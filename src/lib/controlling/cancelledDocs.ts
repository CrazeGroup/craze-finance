import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';

// Abonos de compra que anulan una factura entera (corrección): pareja factura + abono del mismo proveedor y por el
// mismo importe con signo contrario, unidos por los datos de liquidación de los movimientos de proveedor (API custom
// vendorLedgerEntries): applies-to del abono, factura corregida (correctedInvoiceNoBCT) o "Closed by Entry No." en
// cualquiera de los dos sentidos. Los informes ocultan la pareja cuando las dos están en sus datos y suman 0, así que
// los totales no cambian y solo queda la factura correcta.

const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);

export type CancelPair = { invoice: string; creditMemo: string };

// Abonos registrados en [from, to]; las facturas que anulan pueden ser de hasta un año antes
export async function vendorCancelPairs(ctx: BcContext, from: string, to: string): Promise<CancelPair[]> {
  return cached(`cancel-pairs:${ctx.companyName}:${from}:${to}`, HOUR, async () => {
    const since = `${Number(from.substring(0, 4)) - 1}${from.substring(4)}`;
    const select = 'entryNo,vendorNo,documentNo,amount,closedByEntryNo,appliesToDocType,appliesToDocNo,correctedInvoiceNoBCT,reversed';
    const [memos, invoices] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, {
        $filter: `documentType eq 'Credit Memo' and postingDate ge ${from} and postingDate le ${to}`, $select: select,
      }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, {
        $filter: `documentType eq 'Invoice' and postingDate ge ${since} and postingDate le ${to}`, $select: select,
      }), ctx.token),
    ]);
    const invByEntry = new Map(invoices.map((i: any) => [n(i.entryNo), i]));
    const invByDoc = new Map(invoices.map((i: any) => [s(i.documentNo), i]));
    const closedBy = new Map<number, any[]>();
    for (const i of invoices) if (n(i.closedByEntryNo)) closedBy.set(n(i.closedByEntryNo), [...(closedBy.get(n(i.closedByEntryNo)) || []), i]);

    const used = new Set<string>();
    const pairs: CancelPair[] = [];
    for (const m of memos) {
      if (m.reversed) continue;
      const candidates = [
        /invoice/i.test(s(m.appliesToDocType)) ? invByDoc.get(s(m.appliesToDocNo)) : undefined,
        invByDoc.get(s(m.correctedInvoiceNoBCT)),
        invByEntry.get(n(m.closedByEntryNo)),
        ...(closedBy.get(n(m.entryNo)) || []),
      ].filter(Boolean);
      const inv = candidates.find((i: any) => !used.has(s(i.documentNo)) && !i.reversed
        && s(i.vendorNo) === s(m.vendorNo) && Math.abs(n(i.amount) + n(m.amount)) < 0.01);
      if (!inv) continue;
      used.add(s(inv.documentNo));
      pairs.push({ invoice: s(inv.documentNo), creditMemo: s(m.documentNo) });
    }
    return pairs;
  });
}

// Documentos a ocultar: parejas cuyos dos documentos están en `amountByDoc` y suman 0 (en el importe del informe)
export function hiddenByPairs(pairs: CancelPair[], amountByDoc: Map<string, number>, tolerance = 0.05): Set<string> {
  const hidden = new Set<string>();
  for (const p of pairs) {
    const a = amountByDoc.get(p.invoice), b = amountByDoc.get(p.creditMemo);
    if (a === undefined || b === undefined || hidden.has(p.invoice) || hidden.has(p.creditMemo)) continue;
    if (Math.abs(a + b) <= tolerance) { hidden.add(p.invoice); hidden.add(p.creditMemo); }
  }
  return hidden;
}
