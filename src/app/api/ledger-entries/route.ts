import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Movimientos abiertos de cliente y proveedor que no son facturas (pagos, abonos, reembolsos y sin tipo),
// en directo de BC (API custom custLedgerEntries / vendorLedgerEntries) para la empresa seleccionada.
const VALID_DOCUMENT_TYPES = ['refund', 'credit memo', 'payment', ''];

const str = (v: any) => (v == null ? '' : String(v).trim());
const num = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const pick = (r: any, keys: string[]) => keys.map(k => r[k]).find(v => v !== undefined && v !== null && v !== '');
const docType = (v: any) => str(v).replace(/_x0020_/g, ' ');
const realDate = (d: any) => { const s = str(d).substring(0, 10); return s && !s.startsWith('0001') ? s : null; };

function mapEntry(type: 'Customer' | 'Vendor', r: any) {
  const t = docType(r.documentType);
  return {
    type,
    entryNo: num(r.entryNo),
    entityNo: str(type === 'Customer' ? r.customerNo : r.vendorNo),
    entityName: str(type === 'Customer' ? r.customerName : r.vendorName) || 'Unknown',
    postingDate: realDate(r.postingDate),
    dueDate: realDate(r.dueDate),
    documentType: t || 'Empty',
    documentNo: str(r.documentNo),
    externalDocumentNo: str(pick(r, ['externalDocumentNo', 'documentNoReceived', 'yourReference'])),
    currencyCode: str(r.currencyCode),
    originalAmount: num(pick(r, ['originalAmount', 'amount'])),
    remainingAmount: num(r.remainingAmount),
    description: str(r.description),
    paymentMethodCode: str(r.paymentMethodCode),
    messageToRecipient: str(r.messageToRecipient),
    salesReturnOrderNo: '',
  };
}

// Sugerencias para cerrar un pago / reembolso / abono abierto con otros movimientos abiertos del MISMO cliente o
// proveedor (y divisa) de signo contrario, incluidas las facturas abiertas:
//  1) uno con el importe pendiente exacto que además se cita (su nº de documento o Ext. Doc. No. aparece en la
//     descripción / Ext. Doc. No. del otro, o al revés)
//  2) uno con el importe exacto (si hay varios, el de fecha más cercana, avisando de cuántos)
//  3) una combinación de 2 o 3 movimientos que suma exactamente, solo entre los de ±120 días (más lejos, una suma
//     exacta suele ser casualidad)
//  4) uno que se cita pero con otro importe (cierre parcial: queda la diferencia)
type Entry = ReturnType<typeof mapEntry>;
type Suggestion = { kind: 'exact_ref' | 'exact' | 'combo' | 'ref'; entries: { entryNo: number; documentType: string; documentNo: string; postingDate: string | null; remaining: number }[]; note: string };
const alnum = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
const refs = (e: Entry) => [e.documentNo, e.externalDocumentNo].map(alnum).filter(x => x.length >= 6);
const cites = (a: Entry, b: Entry) => {
  const text = alnum(`${a.description} ${a.externalDocumentNo} ${a.messageToRecipient}`);
  return refs(b).some(x => text.includes(x));
};
const cents = (v: number) => Math.round(v * 100);
function suggestFor(e: Entry, group: Entry[]): Suggestion | null {
  const target = -cents(e.remainingAmount);
  if (!target) return null;
  const cands = group.filter(c => c.entryNo !== e.entryNo && Math.sign(c.remainingAmount) === Math.sign(target) && cents(c.remainingAmount));
  if (!cands.length) return null;
  const dist = (c: Entry) => Math.abs(Date.parse(c.postingDate || '1970-01-01') - Date.parse(e.postingDate || '1970-01-01'));
  const pack = (list: Entry[]) => list.map(c => ({ entryNo: c.entryNo, documentType: c.documentType, documentNo: c.documentNo, postingDate: c.postingDate, remaining: c.remainingAmount }));
  const cited = cands.filter(c => cites(e, c) || cites(c, e));
  const exact = cands.filter(c => cents(c.remainingAmount) === target);
  const exactRef = exact.filter(c => cited.includes(c));
  if (exactRef.length) return { kind: 'exact_ref', entries: pack([exactRef[0]]), note: 'Mismo importe y se citan' };
  if (exact.length) {
    const best = [...exact].sort((a, b) => dist(a) - dist(b))[0];
    return { kind: 'exact', entries: pack([best]), note: exact.length > 1 ? `Mismo importe (${exact.length} posibles: el de fecha más cercana)` : 'Mismo importe' };
  }
  // Combinaciones de 2 a 4 entre los más cercanos en fecha
  const near = [...cands].filter(c => dist(c) <= 120 * 86400000).sort((a, b) => dist(a) - dist(b)).slice(0, 25);
  const vals = near.map(c => cents(c.remainingAmount));
  let combo: number[] | null = null;
  const search = (start: number, left: number, picked: number[]) => {
    if (combo) return;
    if (left === 0 && picked.length >= 2) { combo = [...picked]; return; }
    if (picked.length === 3) return;
    for (let i = start; i < near.length && !combo; i++) {
      // mismo signo que el objetivo: no se puede pasar de largo
      if (Math.abs(vals[i]) > Math.abs(left)) continue;
      picked.push(i); search(i + 1, left - vals[i], picked); picked.pop();
    }
  };
  search(0, target, []);
  if (combo) return { kind: 'combo', entries: pack((combo as number[]).map(i => near[i])), note: `Suman el importe exacto (${(combo as number[]).length} movimientos)` };
  if (cited.length) {
    const c = cited[0];
    const rest = (e.remainingAmount + c.remainingAmount);
    return { kind: 'ref', entries: pack([c]), note: `Se citan, pero con otro importe: quedaría ${rest.toFixed(2)}` };
  }
  return null;
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const ctx = await getBcContext(company);

    const [customers, vendors] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.customApiBase}/custLedgerEntries`, { $filter: 'open eq true' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, { $filter: 'open eq true' }), ctx.token),
    ]);
    // Sales Return Order No. (campo de extensión, solo en la página OData de movimientos de cliente); si la empresa no
    // lo tiene, se queda vacío
    const returnOrders = new Map<number, string>();
    await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Customer_Ledger_Entries_Excel`, {
      $filter: 'Open eq true', $select: 'Entry_No,Sales_Return_Order_No_BCT',
    }), ctx.token).then(rows => rows.forEach((x: any) => { if (str(x.Sales_Return_Order_No_BCT)) returnOrders.set(num(x.Entry_No), str(x.Sales_Return_Order_No_BCT)); })).catch(() => {});
    const all = [
      ...customers.map(r => ({ ...mapEntry('Customer', r), salesReturnOrderNo: returnOrders.get(num(r.entryNo)) || '' })),
      ...vendors.map(r => mapEntry('Vendor', r)),
    ];
    const groups = new Map<string, Entry[]>();
    for (const e of all) {
      const k = `${e.type}|${e.entityNo}|${e.currencyCode}`;
      groups.set(k, [...(groups.get(k) || []), e]);
    }
    const isListed = (e: Entry) => VALID_DOCUMENT_TYPES.includes(e.documentType.toLowerCase()) || e.documentType === 'Empty';
    const entries = all.filter(isListed)
      .map(e => ({ ...e, suggestion: suggestFor(e, groups.get(`${e.type}|${e.entityNo}|${e.currencyCode}`) || []) }))
      .sort((a, b) => (a.postingDate || '').localeCompare(b.postingDate || ''));
    return NextResponse.json(entries);
  } catch (error: any) {
    console.error('Error fetching ledger entries:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
