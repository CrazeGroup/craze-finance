import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import prisma from '@/lib/prisma';
import { readSetting } from '@/lib/reporting/cache';
import { companyCurrency } from '@/lib/royalties';
import { VENDOR_INVOICE_TYPES } from '@/lib/documentTypes';

// Payment Proposal: movimientos de proveedor (API custom vendorLedgerEntries) con los filtros fijos de la propuesta
// de pagos de BC: facturas y abonos abiertos, No Payment = No, forma de pago TRANSFER y sin proveedores del grupo (CRAZE…),
// con vencimiento entre `from` y `to`. Aprobado para pago = % Payment Approval ≥ 100.

export const PAYMENT_METHOD = 'TRANSFER';
export const APPROVED_PCT = 100;

export type ProposalEntry = {
  entryNo: number; vendorNo: string; vendorName: string; docType: string; docNo: string; extDocNo: string;
  description: string; postingDate: string; dueDate: string;
  remaining: number; remainingLCY: number | null; currency: string;
  approvalPct: number; approvedUsers: string; pendingUsers: string;
};

const pick = (r: any, keys: string[]) => keys.map(k => r[k]).find(v => v !== undefined && v !== null);
const str = (v: any) => (v == null ? '' : String(v).trim());
const num = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const isTrue = (v: any) => v === true || v === 'true' || v === 'Yes' || v === 1;
const users = (v: any) => str(v).split('|').map(u => u.trim()).filter(Boolean);
const joinUsers = (list: string[]) => Array.from(new Set(list)).sort().join('|');
const realDate = (d: any) => { const s = str(d).substring(0, 10); return s && !s.startsWith('0001') ? s : ''; };

// Usuarios de aprobación por nº de movimiento. La API custom no los trae siempre: se leen de la página de
// movimientos de proveedor publicada en OData (la que se exporta a Excel: "Approval Users", "Pending Users"...).
// Servicio fijable con el setting 'paymentProposalUsersService'; por defecto el de la página 29 publicado al usar
// "Editar en Excel" (Vendor_Ledger_Entries_Excel).
const DEFAULT_USERS_SERVICE = 'Vendor_Ledger_Entries_Excel';
type Users = { approval: string[]; approved: string[]; pending: string[] | null; rejected: string[] };
const findKey = (keys: string[], test: (k: string) => boolean) => keys.find(test);
const isPendingKey = (k: string) => /pending/i.test(k) && /user/i.test(k);
const isApprovalKey = (k: string) => /approval/i.test(k) && /user/i.test(k);
const isApprovedKey = (k: string) => /approved/i.test(k) && /user/i.test(k) && !/fibu/i.test(k);
const isRejectedKey = (k: string) => /rejected/i.test(k) && /user/i.test(k);

function usersFrom(r: any, keys: string[]): Users {
  const pendingKey = findKey(keys, isPendingKey);
  const g = (test: (k: string) => boolean) => { const k = findKey(keys, test); return k ? users(r[k]) : []; };
  return { approval: g(isApprovalKey), approved: g(isApprovedKey), pending: pendingKey ? users(r[pendingKey]) : null, rejected: g(isRejectedKey) };
}

async function odataUsers(ctx: BcContext, from: string, to: string, tried: string[]): Promise<{ service: string; byEntry: Map<number, Users> } | null> {
  const root = ctx.odataCompanyBase.replace(/\/Company\(.*$/, '');
  const configured = await readSetting<string>('paymentProposalUsersService', '');
  let names: string[] = configured ? [configured] : [];
  if (!names.length) {
    const res = await fetch(root, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
    if (res.ok) {
      const list: string[] = ((await res.json()).value || []).map((s: any) => s.name);
      // Primero los servicios "…_Excel" (como Currencies_Excel o General_Ledger_Entries_Excel)
      names = list.filter(n => /vendor.?ledger.?entr/i.test(n)).sort((a, b) => Number(!/excel/i.test(a)) - Number(!/excel/i.test(b)));
      if (!names.length) tried.push('la lista de servicios OData no incluye ninguno con "Vendor Ledger Entries" en el nombre');
    } else tried.push(`lista de servicios OData: error ${res.status}`);
    if (!names.includes(DEFAULT_USERS_SERVICE)) names.push(DEFAULT_USERS_SERVICE);
  }
  for (const name of names) {
    const base = `${ctx.odataCompanyBase}/${name}`;
    let sample: any[] = [];
    try { sample = await bcFetchAll(odataUrl(base, { $top: '1' }), ctx.token); } catch (e: any) { tried.push(`${name}: ${e.message.substring(0, 300)}`); continue; }
    if (!sample.length) { tried.push(`${name}: sin filas`); continue; }
    const keys = Object.keys(sample[0]);
    const entryKey = findKey(keys, k => /^entry_?no$/i.test(k));
    const dueKey = findKey(keys, k => /^due_?date$/i.test(k));
    const openKey = findKey(keys, k => /^open$/i.test(k));
    if (!entryKey || !findKey(keys, k => isPendingKey(k) || isApprovalKey(k))) {
      tried.push(`${name}: sin campos Entry No / Pending Users (campos: ${keys.filter(k => !k.startsWith('@')).join(', ')})`);
      continue;
    }
    const filter = [openKey && `${openKey} eq true`, dueKey && `${dueKey} ge ${from} and ${dueKey} le ${to}`].filter(Boolean).join(' and ');
    const select = [entryKey, ...keys.filter(k => isPendingKey(k) || isApprovalKey(k) || isApprovedKey(k) || isRejectedKey(k))].join(',');
    let rows: any[];
    try {
      rows = await bcFetchAll(odataUrl(base, { $filter: filter || undefined, $select: select }), ctx.token);
    } catch (e: any) {
      tried.push(`${name} (filtro ${filter}, campos ${select}): ${e.message.substring(0, 300)}`);
      continue;
    }
    return { service: name, byEntry: new Map(rows.map(r => [num(r[entryKey]), usersFrom(r, keys)])) };
  }
  return null;
}

// Provisional, mientras BC no devuelve los usuarios: Excel de la página 29 subido en la app, por empresa.
// Formato guardado: [Entry No., Pending Users, Approval Users, Approved Users, Rejected Users]
const USERS_UPLOAD_PREFIX = 'payment-proposal:users-upload:';
export type StoredUsersUpload = { fileName: string; uploadedAt: string; rows: [number, string, string, string, string][] };

export async function saveUsersUpload(company: string, upload: StoredUsersUpload) {
  const key = USERS_UPLOAD_PREFIX + company;
  const config = JSON.stringify(upload);
  await prisma.apiConfig.upsert({ where: { key }, update: { config }, create: { key, url: '', config } });
}

async function loadUsersUpload(company: string) {
  const row = await prisma.apiConfig.findUnique({ where: { key: USERS_UPLOAD_PREFIX + company } });
  if (!row?.config) return null;
  const u = JSON.parse(row.config) as StoredUsersUpload;
  const byEntry = new Map<number, Users>(u.rows.map(([entry, pending, approval, approved, rejected]) => [
    entry, { pending: users(pending), approval: users(approval), approved: users(approved), rejected: users(rejected) },
  ]));
  return { fileName: u.fileName, uploadedAt: u.uploadedAt, byEntry };
}

export async function paymentProposal(ctx: BcContext, company: string, from: string, to: string) {
  const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, {
    $filter: `open eq true and paymentMethodCode eq '${PAYMENT_METHOD}' and dueDate ge ${from} and dueDate le ${to}`,
  }), ctx.token);
  const lcy = companyCurrency(company);
  const sample = rows[0] || {};
  const has = (keys: string[]) => keys.some(k => k in sample);
  const apiKeys = Object.keys(sample).filter(k => !k.startsWith('@'));
  const fields = {
    currency: has(['currencyCode']),
    remainingLCY: has(['remainingAmtLCY', 'remainingAmountLCY', 'remainingAmtLcy']),
  };
  // Usuarios: de la API si trae los pendientes; si no, de la página OData; si no, aprobadores − aprobados
  let usersSource = 'none';
  const usersTried: string[] = [];
  let byEntry: Map<number, Users> | null = null;
  if (apiKeys.some(isPendingKey)) usersSource = 'api';
  else {
    const od = rows.length ? await odataUsers(ctx, from, to, usersTried).catch(e => { console.error('Payment proposal users:', e); usersTried.push(String(e.message)); return null; }) : null;
    if (od) { byEntry = od.byEntry; usersSource = `odata:${od.service}`; }
    else {
      const up = await loadUsersUpload(company);
      if (up) { byEntry = up.byEntry; usersSource = `excel:${up.fileName} (cargado el ${up.uploadedAt.substring(0, 10).split('-').reverse().join('/')})`; }
      else if (apiKeys.some(isApprovalKey)) usersSource = 'derived';
    }
  }

  const entries: ProposalEntry[] = rows
    .filter(r => !isTrue(pick(r, ['noPaymentBCT', 'noPayment'])) && str(r.onHold) !== 'NO PAGAR')
    .filter(r => !/^craze/i.test(str(r.vendorName)))
    .filter(r => VENDOR_INVOICE_TYPES.includes(str(r.documentType).replace(/_x0020_/g, ' ')))
    .map(r => {
      const u = byEntry?.get(num(r.entryNo)) || usersFrom(r, apiKeys);
      const approved = u.approved.length ? u.approved : users(pick(r, ['approvedUsersBCT', 'approvedUsers']));
      // Sin campo de pendientes: los aprobadores que aún no han aprobado ni rechazado
      const pending = u.pending ?? u.approval.filter(x => !approved.includes(x) && !u.rejected.includes(x));
      const currency = str(r.currencyCode) || lcy;
      const remaining = num(r.remainingAmount);
      const lcyRaw = pick(r, ['remainingAmtLCY', 'remainingAmountLCY', 'remainingAmtLcy']);
      return {
        entryNo: num(r.entryNo), vendorNo: str(r.vendorNo), vendorName: str(r.vendorName),
        docType: str(r.documentType).replace(/_x0020_/g, ' '), docNo: str(r.documentNo), extDocNo: str(r.externalDocumentNo),
        description: str(r.description), postingDate: realDate(r.postingDate), dueDate: realDate(r.dueDate),
        remaining,
        remainingLCY: lcyRaw !== undefined ? num(lcyRaw) : currency === lcy ? remaining : null,
        currency,
        approvalPct: num(pick(r, ['paymentApprovalCRZ', 'percentagePaymentApproval'])),
        approvedUsers: joinUsers(approved),
        pendingUsers: joinUsers(pending),
      };
    })
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName) || a.dueDate.localeCompare(b.dueDate));

  // Documentos cuyo nº de movimiento no aparece en la página OData (se quedan sin usuarios de ahí)
  const unmatched = byEntry ? entries.filter(e => !byEntry!.has(e.entryNo)).length : 0;
  return { company, from, to, lcy, fields, usersSource, usersTried, unmatched, apiKeys, entries };
}
