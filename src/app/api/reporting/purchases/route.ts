import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { getBcContext, bcFetchAll } from '@/lib/bcClient';
import { monthEnd, monthStart, parseMonths } from '@/lib/reporting';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PAYMENT_METHOD = 'CHINA TRF';

// Compras de inventario: facturas de proveedor registradas en los meses seleccionados
// cuyo proveedor tiene forma de pago CHINA TRF. Se leen de BC porque la app solo guarda las abiertas.
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (companyId === 'ALL') {
      return NextResponse.json({ error: 'Selecciona una empresa concreta para ver las compras.' }, { status: 400 });
    }
    const months = parseMonths(new URL(req.url).searchParams.get('months'));
    if (months.length === 0) return NextResponse.json({ error: 'Selecciona al menos un mes.' }, { status: 400 });

    const vendors = await prisma.vendor.findMany({
      where: { companyId, paymentMethod: { equals: PAYMENT_METHOD, mode: 'insensitive' } },
      select: { bcId: true, name: true }
    });
    const vendorNames = new Map(vendors.map(v => [v.bcId, v.name]));

    const ctx = await getBcContext(companyId);
    const filter = `documentType eq 'Invoice' and postingDate ge ${monthStart(months[0])} and postingDate le ${monthEnd(months[months.length - 1])}`;
    const entries = await bcFetchAll(`${ctx.customApiBase}/vendorLedgerEntries?$filter=${encodeURIComponent(filter)}`, ctx.token);

    const selected = new Set(months);
    const invoices = entries
      .filter(e => vendorNames.has(e.vendorNo) && selected.has(String(e.postingDate).substring(0, 7)))
      .map(e => ({
        documentNo: e.documentNo,
        vendorNo: e.vendorNo,
        vendorName: vendorNames.get(e.vendorNo) || e.vendorNo,
        postingDate: String(e.postingDate).substring(0, 10),
        currencyCode: e.currencyCode || 'EUR',
        // Importe en divisa local si BC lo devuelve; las facturas de proveedor vienen en negativo
        amount: Math.abs(e.originalAmountLCY ?? e.amountLCY ?? e.originalAmount ?? e.amount ?? 0),
      }))
      .sort((a, b) => a.postingDate.localeCompare(b.postingDate));

    const byMonth = Object.fromEntries(months.map(m => {
      const monthInvoices = invoices.filter(i => i.postingDate.startsWith(m));
      return [m, { total: monthInvoices.reduce((s, i) => s + i.amount, 0), count: monthInvoices.length }];
    }));

    return NextResponse.json({
      paymentMethod: PAYMENT_METHOD,
      vendorsWithMethod: vendors.length,
      byMonth,
      total: invoices.reduce((s, i) => s + i.amount, 0),
      invoices,
    });
  } catch (error: any) {
    console.error('Error in reporting purchases:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
