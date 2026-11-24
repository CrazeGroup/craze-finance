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

export async function chinaPayments(company: string): Promise<ChinaEntry[]> {
  const ctx = await getBcContext(company);
  const rows = await bcFetchAll(odataUrl(base(ctx.customApiBase), { $filter: `open eq true and paymentMethodCode eq '${CHINA_PM}'`, $select: FIELDS }), ctx.token);
  return rows.filter((r: any) => !/^craze/i.test((r.vendorName || '').trim()) && Number(r.remainingAmount)).map(toEntry);
}

// Pone (o vacía con date = null) la Scheduled Payment Date de los movimientos en BC, uno a uno, y la relee.
// También la copia en la tabla local (PurchaseInvoice.schedulePaymentDate) para que Cashflow/Pagos la vean ya.
export async function setScheduledDate(company: string, entryNos: number[], date: string | null) {
  const ctx = await getBcContext(company);
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
