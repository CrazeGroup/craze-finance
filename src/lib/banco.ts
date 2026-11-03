import { bcFetchAll, odataUrl, type BcContext } from '@/lib/bcClient';
import { bcRequest } from '@/lib/bcWrite';

// BANCO: extracto CSV del banco (formato CSV-CAMT de Sparkasse) → movimientos que aún no están en las Bank Account Ledger
// Entries de la cuenta → sugerencia de líneas para el General Journal (lote con esa cuenta de banco como contrapartida).
// - Cuadre: cada movimiento con un movimiento de banco del mismo importe (±7 días) o con varios del mismo nº de
//   documento que suman su importe (cobros repartidos por factura, comisiones descontadas…).
// - Sugerencia, por orden: lo que se hizo con la misma contrapartida (IBAN o nombre) en los movimientos del extracto
//   que ya están registrados; las facturas abiertas citadas en el concepto; el cliente o proveedor con ese nombre.

export type Movement = {
  idx: number; date: string; valueDate: string; text: string; purpose: string; name: string; iban: string;
  endToEnd: string; amount: number; pending: boolean; account: string;
};
export type LedgerEntry = {
  entryNo: number; date: string; docNo: string; description: string; amount: number; balType: string; balNo: string;
};
export type AppliesType = 'Invoice' | 'Credit Memo' | 'Payment' | 'Refund';
export type AccountType = 'G/L Account' | 'Customer' | 'Vendor' | 'Bank Account';
export type SuggestedLine = {
  accountType: AccountType | ''; accountNo: string; accountName: string; description: string;
  amount: number; appliesToDocType?: AppliesType; appliesToDocNo?: string;
};
export type Suggestion = { documentNo: string; source: string; note: string; lines: SuggestedLine[] };
export type MovementResult = Movement & {
  status: 'posted' | 'batch' | 'new';
  matched: { docNo: string; date: string; description: string; balType: string; balNo: string; amount: number }[];
  suggestion: Suggestion | null;
  doubtful?: boolean;
};
export type OpenEntry = { side: 'Customer' | 'Vendor'; no: string; name: string; docType: string; docNo: string; extDocNo: string; remaining: number };
export type Party = { side: 'Customer' | 'Vendor'; no: string; name: string };
export type BatchLine = { date: string; bankAmount: number; docNo: string; description: string };

const WINDOW_DAYS = 7;
const cents = (v: number) => Math.round(v * 100);
const r2 = (v: number) => Math.round(v * 100) / 100;
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const q = (s: string) => s.replace(/'/g, "''");

// ---------- CSV ----------

function splitCsvLine(line: string, sep: string) {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// "03.11.26" / "03.11.2026" → "2026-11-03"
function germanDate(s: string) {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (!m) return '';
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
// "-1.234,56" → -1234.56
const germanNumber = (s: string) => parseFloat(s.trim().replace(/\./g, '').replace(',', '.'));

export function parseBankCsv(text: string): Movement[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('El fichero está vacío.');
  const sep = lines[0].includes(';') ? ';' : ',';
  const head = splitCsvLine(lines[0], sep).map(h => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex(h => names.includes(h));
  const c = {
    account: col('auftragskonto'), date: col('buchungstag'), value: col('valutadatum'), text: col('buchungstext'),
    purpose: col('verwendungszweck'), name: col('beguenstigter/zahlungspflichtiger', 'begünstigter/zahlungspflichtiger'),
    iban: col('kontonummer/iban', 'kontonummer'), e2e: col('kundenreferenz (end-to-end)'), amount: col('betrag'), info: col('info'),
  };
  if (c.date < 0 || c.amount < 0) throw new Error('No se reconoce el formato: faltan las columnas Buchungstag y Betrag (CSV-CAMT de Sparkasse).');
  const get = (row: string[], i: number) => (i >= 0 ? (row[i] || '').trim() : '');
  return lines.slice(1).map((l, idx) => {
    const row = splitCsvLine(l, sep);
    return {
      idx, date: germanDate(get(row, c.date)), valueDate: germanDate(get(row, c.value)), text: get(row, c.text),
      purpose: get(row, c.purpose).replace(/\s+/g, ' '), name: get(row, c.name), iban: get(row, c.iban).replace(/\s/g, '').toUpperCase(),
      endToEnd: get(row, c.e2e), amount: germanNumber(get(row, c.amount)), pending: /vorgemerkt/i.test(get(row, c.info)),
      account: get(row, c.account).replace(/\s/g, '').toUpperCase(),
    };
  }).filter(m => m.date && Number.isFinite(m.amount));
}

// ---------- BC ----------

export async function bankLedgerEntries(ctx: BcContext, bankNo: string, from: string): Promise<LedgerEntry[]> {
  const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Bank_Account_Ledger_Entries_Excel`, {
    $filter: `Bank_Account_No eq '${q(bankNo)}' and Posting_Date ge ${from}`,
    $select: 'Entry_No,Posting_Date,Document_No,Description,Amount,Bal_Account_Type,Bal_Account_No,Reversed',
  }), ctx.token);
  // Un movimiento anulado y su anulación no cuentan como registrados
  return rows.filter((r: any) => !r.Reversed).map((r: any) => ({
    entryNo: r.Entry_No, date: r.Posting_Date, docNo: String(r.Document_No || ''), description: String(r.Description || ''),
    amount: Number(r.Amount) || 0, balType: String(r.Bal_Account_Type || ''), balNo: String(r.Bal_Account_No || ''),
  }));
}

export async function openEntries(ctx: BcContext): Promise<OpenEntry[]> {
  const [cust, vend] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.customApiBase}/custLedgerEntries`, { $filter: 'open eq true', $select: 'customerNo,customerName,documentType,documentNo,externalDocumentNo,remainingAmount' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, { $filter: 'open eq true', $select: 'vendorNo,vendorName,documentType,documentNo,externalDocumentNo,remainingAmount' }), ctx.token),
  ]);
  const docType = (t: string) => String(t || '').replace(/_x0020_/g, ' ');
  return [
    ...cust.map((r: any) => ({ side: 'Customer' as const, no: r.customerNo, name: r.customerName, docType: docType(r.documentType), docNo: String(r.documentNo || ''), extDocNo: String(r.externalDocumentNo || ''), remaining: Number(r.remainingAmount) || 0 })),
    ...vend.map((r: any) => ({ side: 'Vendor' as const, no: r.vendorNo, name: r.vendorName, docType: docType(r.documentType), docNo: String(r.documentNo || ''), extDocNo: String(r.externalDocumentNo || ''), remaining: Number(r.remainingAmount) || 0 })),
  ];
}

export async function journalByCode(ctx: BcContext, code: string) {
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/journals`, { $filter: `code eq '${q(code)}'`, $select: 'id,code,balancingAccountNumber' }), ctx.token);
  if (!rows.length) throw new Error(`No existe el lote ${code} en el General Journal de BC.`);
  return rows[0] as { id: string; code: string; balancingAccountNumber: string };
}

// Líneas que ya están en el lote (sin registrar), con el importe visto desde el banco
export async function batchLines(ctx: BcContext, journalId: string, bankNo: string): Promise<BatchLine[]> {
  const rows = await bcFetchAll(`${ctx.apiBase}/journals(${journalId})/journalLines`, ctx.token);
  return rows.map((r: any) => {
    const amount = Number(r.amount) || 0;
    const isBankAccount = r.accountType === 'Bank Account' && r.accountNumber === bankNo;
    return { date: r.postingDate, bankAmount: isBankAccount ? amount : -amount, docNo: String(r.documentNumber || ''), description: String(r.description || '') };
  });
}

// ---------- Cuadre ----------

// Devuelve, por movimiento, los movimientos de banco con los que cuadra
export function matchMovements(movements: Movement[], entries: LedgerEntry[]) {
  const used = new Set<number>();
  const result = new Map<number, LedgerEntry[]>();
  const dist = (m: Movement, d: string) => Math.min(days(m.date, d), m.valueDate ? days(m.valueDate, d) : Infinity);

  // Asigna a cada movimiento el candidato más cercano en fecha que siga libre
  const assign = (candidates: { m: Movement; es: LedgerEntry[]; d: number }[]) => {
    candidates.sort((a, b) => a.d - b.d || a.es[0].entryNo - b.es[0].entryNo);
    for (const { m, es } of candidates) {
      if (result.has(m.idx) || es.some(e => used.has(e.entryNo))) continue;
      result.set(m.idx, es);
      es.forEach(e => used.add(e.entryNo));
    }
  };
  const docs = new Map<string, LedgerEntry[]>();
  for (const e of entries) docs.set(`${e.docNo}|${e.date}`, [...(docs.get(`${e.docNo}|${e.date}`) || []), e]);
  const sum = (es: LedgerEntry[]) => cents(es.reduce((t, e) => t + e.amount, 0));
  const pending = () => movements.filter(m => !result.has(m.idx));

  // 1. Un documento entero (mismo nº y fecha) que suma el importe: un movimiento suelto o un cobro repartido por factura
  const docsBySum = new Map<number, LedgerEntry[][]>();
  for (const es of docs.values()) docsBySum.set(sum(es), [...(docsBySum.get(sum(es)) || []), es]);
  assign(movements.flatMap(m => (docsBySum.get(cents(m.amount)) || [])
    .map(es => ({ m, es, d: dist(m, es[0].date) })).filter(c => c.d <= WINDOW_DAYS)));

  // 2. Un movimiento de banco del mismo importe dentro de un documento con más líneas
  const byAmount = new Map<number, LedgerEntry[]>();
  for (const e of entries) byAmount.set(cents(e.amount), [...(byAmount.get(cents(e.amount)) || []), e]);
  assign(pending().flatMap(m => (byAmount.get(cents(m.amount)) || [])
    .map(e => ({ m, es: [e], d: dist(m, e.date) })).filter(c => c.d <= WINDOW_DAYS)));

  // 3. Parte de un documento que suma el importe (el resto del documento es otro movimiento)
  for (const m of pending()) {
    const target = cents(m.amount);
    for (const es of docs.values()) {
      const free = es.filter(e => !used.has(e.entryNo));
      if (free.length < 2 || dist(m, free[0].date) > WINDOW_DAYS) continue;
      const found = subsetWithSum(free, target);
      if (found) {
        result.set(m.idx, found);
        found.forEach(e => used.add(e.entryNo));
        break;
      }
    }
  }

  // 4. Remesa ("DATUM … ANZAHL n"): n movimientos de banco de un mismo día (documentos distintos) que suman el importe
  for (const m of movements) {
    const n = Number(m.purpose.match(/ANZAHL\s+(\d+)/i)?.[1] || 0);
    if (result.has(m.idx) || n < 2) continue;
    const dates = Array.from(new Set(entries.filter(e => !used.has(e.entryNo)).map(e => e.date)))
      .filter(d => dist(m, d) <= WINDOW_DAYS).sort((a, b) => dist(m, a) - dist(m, b));
    for (const d of dates) {
      const group = entries.filter(e => !used.has(e.entryNo) && e.date === d && Math.sign(e.amount) === Math.sign(m.amount));
      const found = combinationWithSum(group, n, cents(m.amount));
      if (found) {
        result.set(m.idx, found);
        found.forEach(e => used.add(e.entryNo));
        break;
      }
    }
  }

  // 5. Cobro neto de una factura de compra (o al revés): movimientos del mismo día de documentos distintos con el
  //    nombre de la contrapartida (p. ej. dm drogerie markt GmbH 17.689,69 y dm drogerie markt GmbH AT -308,16)
  for (const m of pending()) {
    const key = firstWord(m.name);
    if (!key) continue;
    const dates = Array.from(new Set(entries.filter(e => !used.has(e.entryNo)).map(e => e.date)))
      .filter(d => dist(m, d) <= WINDOW_DAYS).sort((a, b) => dist(m, a) - dist(m, b));
    for (const d of dates) {
      const group = entries.filter(e => !used.has(e.entryNo) && e.date === d && firstWord(e.description) === key);
      const found = group.length >= 2 ? subsetWithSum(group, cents(m.amount)) : null;
      if (found) {
        result.set(m.idx, found);
        found.forEach(e => used.add(e.entryNo));
        break;
      }
    }
  }
  return result;
}

// Primera palabra del nombre normalizado ("dm drogerie markt GmbH AT" → "dm")
const firstWord = (s: string) => normName(s).split(' ')[0] || '';

// k movimientos del grupo que suman target (busca por el lado más corto: los k o los que sobran)
function combinationWithSum(group: LedgerEntry[], k: number, target: number): LedgerEntry[] | null {
  if (k > group.length) return null;
  const total = group.reduce((t, e) => t + cents(e.amount), 0);
  const invert = k > group.length - k;
  const size = invert ? group.length - k : k;
  const goal = invert ? total - target : target;
  const values = group.map(e => cents(e.amount));
  const pick: number[] = [];
  let steps = 0;
  const dfs = (start: number, left: number, sum: number): boolean => {
    if (++steps > 2_000_000) return false;
    if (left === 0) return sum === goal;
    for (let i = start; i <= values.length - left; i++) {
      pick.push(i);
      if (dfs(i + 1, left - 1, sum + values[i])) return true;
      pick.pop();
    }
    return false;
  };
  if (!dfs(0, size, 0)) return null;
  const chosen = new Set(pick);
  return group.filter((_, i) => chosen.has(i) !== invert);
}

function subsetWithSum(group: LedgerEntry[], target: number): LedgerEntry[] | null {
  if (cents(group.reduce((t, e) => t + e.amount, 0)) === target) return group;
  if (group.length > 16) return null;
  const n = group.length;
  for (let mask = 3; mask < (1 << n) - 1; mask++) {
    if ((mask & (mask - 1)) === 0) continue; // un solo movimiento: ya se ha probado en el paso 1
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += cents(group[i].amount);
    if (sum === target) return group.filter((_, i) => mask & (1 << i));
  }
  return null;
}

// Movimientos sin registrar que ya están en el lote (mismo importe, ±7 días)
export function matchBatch(movements: Movement[], lines: BatchLine[]) {
  const used = new Set<number>();
  const result = new Map<number, BatchLine>();
  for (const m of movements) {
    const i = lines.findIndex((l, j) => !used.has(j) && cents(l.bankAmount) === cents(m.amount) && days(l.date, m.date) <= WINDOW_DAYS);
    if (i >= 0) { used.add(i); result.set(m.idx, lines[i]); }
  }
  return result;
}

// ---------- Sugerencias ----------

const LEGAL = /\b(gmbh|ag|kg|co|ohg|se|sa|s a|sas|sarl|sl|slu|s l|bv|nv|ltd|limited|llc|inc|plc|eood|ood|spa|srl|s r l|sp z o o|z o o|spolka|ograniczona|odpowiedzialnoscia|beschraenkter|haftung|mit|ab|as|oy|mbh|und|and|the|eu|europe|deutschland)\b/g;
export const normName = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();

const toAccountType = (t: string): AccountType | '' =>
  t === 'G/L Account' || t === 'Customer' || t === 'Vendor' || t === 'Bank Account' ? t : '';
const docType = (t: string): AppliesType => (/credit/i.test(t) ? 'Credit Memo' : /refund/i.test(t) ? 'Refund' : /payment/i.test(t) ? 'Payment' : 'Invoice');
const amazonPaymentNo = (purpose: string) => purpose.match(/PAYMENT-NUM\s+([\d ]{6,})/i)?.[1].replace(/\s/g, '') || '';

const ownAccount = (m: Movement) => !!m.iban && !!m.account && (m.account === m.iban || m.account.endsWith(m.iban));

type Rule = {
  accountType: AccountType; accountNo: string; description: string; usesPurpose: boolean; date: string; text: string; amount: number;
  lines: { accountType: AccountType; accountNo: string; description: string; amount: number }[];
};

// Lo que se hizo con cada contrapartida (IBAN y nombre) en los movimientos ya registrados
function learnRules(movements: Movement[], matched: Map<number, LedgerEntry[]>, bankNo: string) {
  const byIban = new Map<string, Rule[]>();
  const byName = new Map<string, Rule[]>();
  for (const m of movements) {
    const entries = (matched.get(m.idx) || []).filter(e => !(e.balType === 'Bank Account' && e.balNo === bankNo));
    if (!entries.length) continue;
    const main = entries.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
    const accountType = toAccountType(main.balType);
    if (!accountType || !main.balNo) continue;
    const desc = normName(main.description);
    const usesPurpose = !!desc && (normName(m.purpose).includes(desc) || desc.includes(normName(m.purpose)) || main.description === main.docNo);
    const lines = entries.flatMap(e => {
      const t = toAccountType(e.balType);
      return t && e.balNo ? [{ accountType: t, accountNo: e.balNo, description: e.description, amount: e.amount }] : [];
    });
    const rule: Rule = { accountType, accountNo: main.balNo, description: main.description, usesPurpose, date: m.date, text: m.text, amount: m.amount, lines };
    const keep = (map: Map<string, Rule[]>, key: string) => { if (key) map.set(key, [...(map.get(key) || []), rule]); };
    // Las remesas y traspasos llevan la propia cuenta como contrapartida: no identifican a nadie
    if (!ownAccount(m)) keep(byIban, m.iban);
    keep(byName, normName(m.name));
  }
  return { byIban, byName };
}

// De lo hecho con la contrapartida: el mismo importe (cuota, alquiler, comisión); si no, el mismo tipo de movimiento
// (p. ej. la transferencia y su comisión), y si no, lo más reciente
function pickRule(m: Movement, rules: Rule[] | undefined) {
  if (!rules?.length) return null;
  const recent = [...rules].sort((a, b) => b.date.localeCompare(a.date));
  return recent.find(r => cents(r.amount) === cents(m.amount)) || recent.find(r => r.text === m.text) || recent[0];
}

// Facturas abiertas citadas en el concepto (nº de documento o nº de documento externo)
function citedEntries(m: Movement, open: OpenEntry[]) {
  const side = m.amount > 0 ? 'Customer' : 'Vendor';
  const text = ` ${m.purpose.toUpperCase().replace(/[^A-Z0-9-]+/g, ' ')} `;
  const compact = m.purpose.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return open.filter(o => {
    if (o.side !== side) return false;
    if (o.docNo.length >= 6 && text.includes(` ${o.docNo.toUpperCase()} `)) return true;
    const ext = o.extDocNo.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return ext.length >= 6 && compact.includes(ext);
  });
}

// Índices de values (hasta 14) que suman target
function subsetIndexes(values: number[], target: number): number[] | null {
  const n = Math.min(values.length, 14);
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += values[i];
    if (sum === target) return Array.from({ length: n }, (_, i) => i).filter(i => mask & (1 << i));
  }
  return null;
}

// Facturas abiertas de la cuenta ya elegida que liquida el movimiento: las que cita el concepto (nº de documento,
// nº externo o solo su número, p. ej. "Rechnung 02657" o "RG 1215217008"); si no cita ninguna, la que tiene pendiente
// el importe o varias que lo suman
function applyWithinAccount(m: Movement, side: 'Customer' | 'Vendor', no: string, name: string, open: OpenEntry[]) {
  const own = open.filter(o => o.side === side && o.no === no && o.remaining);
  const compact = m.purpose.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const runs = new Set((m.purpose.match(/\d{4,}/g) || []).filter(r => !/^20[2-3]\d$/.test(r)).map(r => r.replace(/^0+/, '')));
  const cites = (o: OpenEntry) => [o.docNo, o.extDocNo].some(d => {
    const c = d.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tail = d.match(/(\d{4,})\D*$/)?.[1].replace(/^0+/, '') || '';
    return (c.length >= 4 && compact.includes(c)) || (!!tail && runs.has(tail));
  });
  const lineFor = (o: OpenEntry, amount = o.remaining): SuggestedLine => ({
    accountType: side, accountNo: no, accountName: name, description: `${name} ${o.docNo}`.substring(0, 100), amount: r2(amount),
    appliesToDocType: docType(o.docType), appliesToDocNo: o.docNo,
  });
  const target = cents(m.amount);
  const cited = own.filter(cites);
  if (cited.length) {
    const total = cents(cited.reduce((t, o) => t + o.remaining, 0));
    if (total === target) return { lines: cited.map(o => lineFor(o)), note: `El concepto cita ${cited.map(o => o.docNo).join(', ')}` };
    if (cited.length === 1) return { lines: [lineFor(cited[0], m.amount)], note: `El concepto cita ${cited[0].docNo}, con pendiente ${r2(cited[0].remaining).toFixed(2)}: revisa la diferencia` };
  }
  const same = own.filter(o => cents(o.remaining) === target);
  if (same.length) return { lines: [lineFor(same[0])], note: `${same[0].docNo} tiene pendiente el mismo importe${same.length > 1 ? ` (y ${same.length - 1} más)` : ''}` };
  const idx = own.length >= 2 ? subsetIndexes(own.map(o => cents(o.remaining)), target) : null;
  if (idx) return { lines: idx.map(i => lineFor(own[i])), note: `${idx.map(i => own[i].docNo).join(' + ')} suman el importe` };
  const refs = m.purpose.toUpperCase().match(/\b(?:[A-Z]{2,5}-)?[A-Z]{2,5}\d{2}-\d{4,6}\b/g);
  return refs ? { lines: null, note: `El concepto cita ${Array.from(new Set(refs)).join(', ')}, sin pendiente en esta cuenta` } : null;
}

function matchParty(m: Movement, parties: Party[]) {
  const name = normName(m.name);
  if (name.length < 3) return null;
  const preferred = m.amount > 0 ? 'Customer' : 'Vendor';
  const hits = parties.filter(p => {
    const n = normName(p.name);
    return n && (n === name || (Math.min(n.length, name.length) >= 5 && (n.startsWith(name) || name.startsWith(n))));
  });
  return hits.find(p => p.side === preferred) || hits[0] || null;
}

export function suggest(
  movements: Movement[], matched: Map<number, LedgerEntry[]>, bankNo: string, open: OpenEntry[], parties: Party[],
): Map<number, Suggestion> {
  const { byIban, byName } = learnRules(movements, matched, bankNo);
  const partyName = new Map(parties.map(p => [`${p.side}|${p.no}`, p.name]));
  const out = new Map<number, Suggestion>();
  const defaultDescription = (m: Movement) => (m.name || m.purpose).substring(0, 100);

  for (const m of movements) {
    if (matched.has(m.idx)) continue;
    const documentNo = amazonPaymentNo(m.purpose);
    const line = (accountType: AccountType | '', accountNo: string, description: string, amount = m.amount): SuggestedLine => ({
      accountType, accountNo, accountName: accountType === 'Customer' || accountType === 'Vendor' ? partyName.get(`${accountType}|${accountNo}`) || '' : '',
      description: description.substring(0, 100), amount: r2(amount),
    });

    // Con la cuenta de un cliente o proveedor, las facturas que liquida (si no, la línea tal cual)
    const withApply = (l: SuggestedLine) => {
      if (l.accountType !== 'Customer' && l.accountType !== 'Vendor') return { lines: [l], note: '' };
      const a = applyWithinAccount(m, l.accountType, l.accountNo, l.accountName || partyName.get(`${l.accountType}|${l.accountNo}`) || m.name, open);
      return { lines: a?.lines || [l], note: a?.note || '' };
    };

    // Facturas abiertas citadas en el concepto
    const cited = citedEntries(m, open);
    const citedParties = new Set(cited.map(o => o.no));
    if (cited.length && citedParties.size === 1) {
      const o = cited[0];
      const total = cents(cited.reduce((t, c) => t + c.remaining, 0));
      const name = o.name || partyName.get(`${o.side}|${o.no}`) || m.name;
      const applied = (c: OpenEntry): SuggestedLine => ({ ...line(o.side, o.no, `${name} ${c.docNo}`, c.remaining), accountName: name, appliesToDocType: docType(c.docType), appliesToDocNo: c.docNo });
      // La diferencia puede ser una factura abierta del otro lado con nombre parecido (cobro neto de una factura de compra)
      const other = open.find(c => c.side !== o.side && cents(c.remaining) === cents(m.amount) - total && firstWord(c.name) === firstWord(name));
      if (total === cents(m.amount)) {
        out.set(m.idx, { documentNo, source: 'Factura', note: `Cuadra con ${cited.map(c => c.docNo).join(', ')}`, lines: cited.map(applied) });
      } else if (other) {
        const otherLine: SuggestedLine = { ...line(other.side, other.no, `${other.name} ${other.docNo}`, other.remaining), accountName: other.name, appliesToDocType: docType(other.docType), appliesToDocNo: other.docNo };
        out.set(m.idx, { documentNo, source: 'Factura', note: `Cuadra con ${cited.map(c => c.docNo).join(', ')} menos ${other.docNo} de ${other.name}`, lines: [...cited.map(applied), otherLine] });
      } else if (cited.length === 1) {
        out.set(m.idx, { documentNo, source: 'Factura', note: `${o.docNo} tiene pendiente ${r2(o.remaining).toFixed(2)}: revisa la diferencia (Skonto, comisión…)`, lines: [{ ...applied(o), amount: r2(m.amount) }] });
      } else {
        out.set(m.idx, { documentNo, source: 'Factura', note: `Facturas citadas ${cited.map(c => `${c.docNo} (${r2(c.remaining).toFixed(2)})`).join(', ')}: no suman el importe, liquídalas en BC`, lines: [{ ...line(o.side, o.no, name), accountName: name }] });
      }
      continue;
    }

    // Misma contrapartida en movimientos ya registrados
    const rule = pickRule(m, (m.iban && !ownAccount(m) && byIban.get(m.iban)) || byName.get(normName(m.name)));
    if (rule) {
      const when = `Como el ${rule.date.split('-').reverse().join('.')}`;
      // Varias líneas (p. ej. leasing: cuota, intereses e IVA): las mismas; con otro importe, solo si son cuentas de
      // G/L, y la principal se queda la diferencia (las de clientes y proveedores van por factura)
      const same = cents(rule.amount) === cents(m.amount);
      if (rule.lines.length > 1 && (same || rule.lines.every(l => l.accountType === 'G/L Account'))) {
        const main = rule.lines.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
        const lines = rule.lines.map(l => line(l.accountType, l.accountNo, rule.usesPurpose ? m.purpose : l.description, l === main ? l.amount + m.amount - rule.amount : l.amount));
        out.set(m.idx, { documentNo, source: 'Histórico', note: same ? `${when}, mismo importe` : `${when}: revisa el reparto entre las líneas`, lines });
        continue;
      }
      const description = documentNo || (rule.usesPurpose ? m.purpose : rule.description) || defaultDescription(m);
      const single = line(rule.accountType, rule.accountNo, description);
      const applied = withApply(single);
      out.set(m.idx, { documentNo, source: 'Histórico', note: [when, applied.note].filter(Boolean).join(' · '), lines: applied.lines });
      continue;
    }

    // Cliente o proveedor con ese nombre
    const party = matchParty(m, parties);
    if (party) {
      const applied = withApply({ ...line(party.side, party.no, party.name), accountName: party.name });
      out.set(m.idx, { documentNo, source: 'Nombre', note: applied.note, lines: applied.lines });
      continue;
    }
    out.set(m.idx, { documentNo, source: '', note: 'Sin sugerencia: indica la cuenta', lines: [line('', '', `${m.name} ${m.purpose}`.trim())] });
  }
  return out;
}

// ---------- Envío al lote ----------

export type SendMovement = { date: string; documentNo: string; lines: SuggestedLine[] };

async function templateName(ctx: BcContext, journalId: string) {
  const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/workflowGenJournalBatches`, { $filter: `id eq ${journalId}`, $select: 'journalTemplateName' }), ctx.token).catch(() => []);
  return String(rows[0]?.journalTemplateName || 'ALLGEMEIN');
}

// Crea las líneas (sin registrar) con el banco como contrapartida. Las de un mismo movimiento comparten nº de documento;
// sin nº, BC pone el siguiente de la serie del lote. Tipo de documento y liquidación (no están en la API v2) se ponen
// después en la página General_Journals_Excel.
export async function sendToBatch(ctx: BcContext, journal: { id: string; code: string }, bankNo: string, movements: SendMovement[]) {
  const base = `${ctx.apiBase}/journals(${journal.id})/journalLines`;
  const created: { id: string; lineNumber: number; documentNumber: string; docType: string; applies?: { type: string; no: string } }[] = [];
  try {
    for (const mv of movements) {
      let docNo = mv.documentNo.trim();
      for (const l of mv.lines) {
        const r = await bcRequest('POST', base, ctx.token, {
          accountType: l.accountType, accountNumber: l.accountNo, postingDate: mv.date, ...(docNo ? { documentNumber: docNo } : {}),
          amount: -r2(l.amount), description: l.description.substring(0, 100), balanceAccountType: 'Bank Account', balancingAccountNumber: bankNo,
        });
        docNo = docNo || String(r.documentNumber || '');
        const party = l.accountType === 'Customer' || l.accountType === 'Vendor';
        // Cobro de cliente o pago a proveedor: Payment; devolución: Refund
        const refund = (l.accountType === 'Customer' && l.amount < 0) || (l.accountType === 'Vendor' && l.amount > 0);
        created.push({
          id: r.id, lineNumber: r.lineNumber, documentNumber: String(r.documentNumber || ''), docType: party && refund ? 'Refund' : 'Payment',
          applies: party && l.appliesToDocNo ? { type: l.appliesToDocType || 'Invoice', no: l.appliesToDocNo } : undefined,
        });
      }
    }
  } catch (e) {
    // No dejar el envío a medias
    for (const c of created) await bcRequest('DELETE', `${base}(${c.id})`, ctx.token).catch(() => {});
    throw e;
  }

  const warnings: string[] = [];
  const template = await templateName(ctx, journal.id);
  const key = (n: number) => `${ctx.odataCompanyBase}/General_Journals_Excel(Journal_Template_Name='${encodeURIComponent(q(template))}',Journal_Batch_Name='${encodeURIComponent(q(journal.code))}',Line_No=${n})`;
  for (const c of created) {
    try {
      await bcRequest('PATCH', key(c.lineNumber), ctx.token, {
        Document_Type: c.docType,
        ...(c.applies ? { Applies_to_Doc_Type: c.applies.type.replace(/ /g, '_x0020_'), Applies_to_Doc_No: c.applies.no } : {}),
      });
    } catch (e: any) {
      warnings.push(`No se ha podido poner el tipo de documento ni la liquidación en las líneas (${String(e?.message || e).substring(0, 160)}); revísalo en BC.`);
      break;
    }
  }
  if (created.some(c => !c.documentNumber)) warnings.push('Alguna línea ha quedado sin nº de documento: ponlo en BC antes de registrar.');
  return { lines: created.length, documentNumbers: Array.from(new Set(created.map(c => c.documentNumber).filter(Boolean))), warnings };
}
