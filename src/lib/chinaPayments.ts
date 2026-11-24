import prisma from '@/lib/prisma';
import { getBcContext, bcFetchAll, odataUrl } from '@/lib/bcClient';

// Previsión de pagos a China (pestaña "China" de Cashflow): movimientos de proveedor abiertos con forma de pago
// CHINA TRF (custom vendorLedgerEntries), agrupados en pagos por Scheduled Payment Date (vacía = "To be confirmed").
// Los proveedores del grupo (CRAZE ASIA…) se excluyen. Cambiar la fecha la escribe en BC (scheduledPaymentDateBCT).
export const CHINA_PM = 'CHINA TRF';
const EMPTY_DATE = '0001-01-01';

export type ChinaEntry = {
  entryNo: number; vendorNo: string; vendorName: string; documentType: string; documentNo: string; externalDocumentNo: string;
  postingDate: string; dueDate: string; currencyCode: string; remainingAmount: number; remainingAmtLCY: number; scheduledDate: string | null;
};

const realDate = (d?: string | null) => (d && d !== EMPTY_DATE ? d : null);
const base = (customApiBase: string) => `${customApiBase}/vendorLedgerEntries`;
const FIELDS = 'entryNo,vendorNo,vendorName,documentType,documentNo,externalDocumentNo,postingDate,dueDate,currencyCode,remainingAmount,remainingAmtLCY,scheduledPaymentDateBCT';
const toEntry = (r: any): ChinaEntry => ({
  entryNo: r.entryNo, vendorNo: r.vendorNo, vendorName: r.vendorName, documentType: r.documentType, documentNo: r.documentNo,
  externalDocumentNo: r.externalDocumentNo || '', postingDate: r.postingDate, dueDate: r.dueDate, currencyCode: r.currencyCode || '',
  remainingAmount: Number(r.remainingAmount) || 0, remainingAmtLCY: Number(r.remainingAmtLCY) || 0, scheduledDate: realDate(r.scheduledPaymentDateBCT),
});

// Caché corta en memoria (la usa también Cashflow en cada carga); se vacía al cambiar una fecha
const cache = new Map<string, { at: number; entries: ChinaEntry[] }>();
export async function chinaPaymentsCached(company: string, maxAgeMs = 2 * 60_000): Promise<ChinaEntry[]> {
  const hit = cache.get(company);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.entries;
  const entries = await chinaPayments(company);
  cache.set(company, { at: Date.now(), entries });
  return entries;
}

export async function chinaPayments(company: string): Promise<ChinaEntry[]> {
  const ctx = await getBcContext(company);
  const rows = await bcFetchAll(odataUrl(base(ctx.customApiBase), { $filter: `open eq true and paymentMethodCode eq '${CHINA_PM}'`, $select: FIELDS }), ctx.token);
  return rows.filter((r: any) => !/^craze/i.test((r.vendorName || '').trim()) && Number(r.remainingAmount)).map(toEntry);
}

// Pone (o vacía con date = null) la Scheduled Payment Date de los movimientos en BC, uno a uno, y la relee.
// También la copia en la tabla local (PurchaseInvoice.schedulePaymentDate) para que Cashflow/Pagos la vean ya.
export async function setScheduledDate(company: string, entryNos: number[], date: string | null) {
  const ctx = await getBcContext(company);
  cache.delete(company);
  const results: { entryNo: number; ok: boolean; error?: string; entry?: ChinaEntry }[] = [];
  for (const entryNo of entryNos) {
    const res = await fetch(`${base(ctx.customApiBase)}(${entryNo})`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'If-Match': '*' },
      body: JSON.stringify({ scheduledPaymentDateBCT: date || EMPTY_DATE }),
    });
    if (!res.ok) {
      let msg = await res.text();
      try { msg = JSON.parse(msg).error?.message || msg; } catch { /* texto */ }
      results.push({ entryNo, ok: false, error: msg.substring(0, 300) });
      continue;
    }
    const row = await res.json().catch(() => null);
    const entry = row ? toEntry(row) : undefined;
    results.push({ entryNo, ok: true, entry });
    if (entry?.documentNo) {
      await prisma.purchaseInvoice.updateMany({
        where: { companyId: company, bcId: entry.documentNo },
        data: { schedulePaymentDate: date ? new Date(`${date}T00:00:00Z`) : null },
      }).catch(() => {});
    }
  }
  return results;
}

// Líneas de Cashflow: un pago por proveedor y Scheduled Payment Date (las "To be confirmed" no tienen fecha y no
// entran), en la cuenta de la divisa local de la empresa (importes en LCY)
export async function chinaCashflowLines(company: string) {
  const entries = await chinaPaymentsCached(company);
  const map = new Map<string, { vendorNo: string; vendorName: string; date: string; amount: number; docs: string[] }>();
  for (const e of entries) {
    if (!e.scheduledDate) continue;
    const key = `${e.vendorNo}|${e.scheduledDate}`;
    if (!map.has(key)) map.set(key, { vendorNo: e.vendorNo, vendorName: e.vendorName, date: e.scheduledDate, amount: 0, docs: [] });
    const p = map.get(key)!;
    p.amount += e.remainingAmtLCY;
    p.docs.push(e.externalDocumentNo || e.documentNo);
  }
  return Array.from(map.values()).map(p => ({
    id: `china-${p.vendorNo}-${p.date}`,
    date: new Date(`${p.date}T00:00:00Z`),
    description: `China payment · ${p.vendorName}`,
    amount: p.amount,
    isManual: false,
    isGroup: false,
    isChina: true,
    chinaDocs: p.docs,
  }));
}
