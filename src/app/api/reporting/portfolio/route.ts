import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { computePortfolio, currentMonth, mergePortfolios, parseMonths, resolveCompanies, Portfolio } from '@/lib/reporting';

export const dynamic = 'force-dynamic';

// Cartera de clientes y proveedores por mes: el mes en curso se calcula en vivo,
// los meses cerrados salen de la foto guardada a cierre (null si no hay foto).
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const months = parseMonths(new URL(req.url).searchParams.get('months'));
    const today = currentMonth();
    const companies = await resolveCompanies(companyId);

    const pastMonths = months.filter(m => m < today);
    const snapshots = pastMonths.length > 0
      ? await prisma.reportingSnapshot.findMany({ where: { companyId: { in: companies }, month: { in: pastMonths } } })
      : [];

    const live = months.some(m => m >= today) ? await computePortfolio(companyId) : null;

    const result: Record<string, { source: 'live' | 'snapshot'; takenAt: string | null; data: Portfolio } | null> = {};
    for (const month of months) {
      if (month >= today) {
        result[month] = { source: 'live', takenAt: new Date().toISOString(), data: live! };
        continue;
      }
      const monthSnaps = snapshots.filter(s => s.month === month);
      if (monthSnaps.length === 0) {
        result[month] = null;
        continue;
      }
      result[month] = {
        source: 'snapshot',
        takenAt: monthSnaps.reduce((max, s) => (s.updatedAt > max ? s.updatedAt : max), monthSnaps[0].updatedAt).toISOString(),
        data: mergePortfolios(monthSnaps.map(s => s.data as unknown as Portfolio)),
      };
    }

    return NextResponse.json({ months: result });
  } catch (error: any) {
    console.error('Error in reporting portfolio:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
