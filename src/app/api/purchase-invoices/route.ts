import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { VENDOR_INVOICE_TYPES } from '@/lib/documentTypes';
import { getBcContext, bcFetchAll, odataUrl } from '@/lib/bcClient';

export const dynamic = 'force-dynamic';

// Posting Date de los movimientos de proveedor abiertos, leído en directo de BC (custom vendorLedgerEntries; la tabla
// local no lo guarda). Caché en memoria 10 min por empresa; si BC falla, la página sale sin Posting Date.
const postingCache = new Map<string, { at: number; dates: Map<string, string> }>();
async function postingDates(company: string): Promise<Map<string, string>> {
  const hit = postingCache.get(company);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.dates;
  const ctx = await getBcContext(company);
  // Abiertos + cerrados en los últimos 30 días (documentos pagados en BC que la sincronización aún no ha cerrado)
  const since = new Date(Date.now() - 30 * 86400000).toISOString().substring(0, 10);
  const url = (filter: string) => odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, { $filter: filter, $select: 'documentNo,postingDate' });
  const rows = (await Promise.all([bcFetchAll(url('open eq true'), ctx.token), bcFetchAll(url(`closedAtDate ge ${since}`), ctx.token)])).flat();
  const dates = new Map<string, string>();
  for (const r of rows) if (r.documentNo && r.postingDate && !dates.has(r.documentNo)) dates.set(String(r.documentNo), r.postingDate);
  postingCache.set(company, { at: Date.now(), dates });
  return dates;
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';

    const invoices = await prisma.purchaseInvoice.findMany({
      where: { companyId, type: { in: VENDOR_INVOICE_TYPES } },
      include: {
        vendor: true,
        approvals: true,
      },
    });

    const posting = await postingDates(companyId).catch(e => { console.warn('Posting Date from BC failed:', e.message); return new Map<string, string>(); });

    const enrichedInvoices = invoices.map(inv => {
      const isOverdue = inv.status === 'Overdue';
      const daysOverdue = isOverdue ? Math.floor((new Date().getTime() - new Date(inv.dueDate).getTime()) / (1000 * 60 * 60 * 24)) : 0;
      
      // Calculate approvals logic
      const totalApprovals = inv.approvals.length;
      const approvedCount = inv.approvals.filter(a => a.status === 'Approved').length;
      const rejectedCount = inv.approvals.filter(a => a.status === 'Rejected' || a.status === 'Canceled').length;
      
      return {
        ...inv,
        // bcId = nº de documento (o "nº|tipo|movimiento" para tipos no clásicos)
        postingDate: posting.get(String(inv.bcId || '').split('|')[0]) || null,
        isOverdue,
        daysOverdue,
        totalApprovals,
        approvedCount,
        rejectedCount
      };
    });

    return NextResponse.json(enrichedInvoices);
  } catch (error) {
    console.error('Error fetching purchase invoices:', error);
    return NextResponse.json({ error: 'Failed to fetch purchase invoices' }, { status: 500 });
  }
}
