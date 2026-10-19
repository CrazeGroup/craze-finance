import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { royaltiesReport, RoyaltiesSetupError } from '@/lib/royalties';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

// Ventas por licencia de la empresa seleccionada en un periodo: /api/controlling/license-sales?from=&to=[&force=1]
// Mismas líneas y Royalty Code que Royalties (LM de BC, sin Main Item ni intercompañía, código de la ficha en CRAZE).
// La página pide un periodo por año (1 de enero → misma fecha) y los compara.
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });

    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: 'Rango de fechas no válido' }, { status: 400 });

    const ctx = await getBcContext(company).catch(e => { console.error('License sales BC:', e); return null; });
    const r = await royaltiesReport(ctx, company, from, to, searchParams.get('force') === '1');
    const byCode: Record<string, { turnover: number; amount: number; qty: number }> = {};
    for (const row of r.rows) {
      const c = (byCode[row.code] ||= { turnover: 0, amount: 0, qty: 0 });
      c.turnover += row.turnover;
      c.amount += row.amount;
      c.qty += row.qty;
    }
    return NextResponse.json({ from, to, company, currency: r.currency, amountField: r.amountField, byCode, lines: r.stats.lines, ic: r.stats.ic, itemsError: r.itemsError });
  } catch (error: any) {
    console.error('Error in license sales:', error);
    const status = error instanceof RoyaltiesSetupError ? 422 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
}
