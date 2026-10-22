import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { royaltiesReport, RoyaltiesSetupError, str } from '@/lib/royalties';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

// Ventas por licencia de la empresa seleccionada en un periodo: /api/controlling/license-sales?from=&to=[&force=1]
// Mismas líneas y Royalty Code que Royalties (LM de BC, sin Main Item ni intercompañía, código de la ficha en CRAZE),
// con el desglose de cada código por país de envío y por Customer Group.
// La página pide un periodo por año (1 de enero → misma fecha) y los compara.
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = new URL(req.url).searchParams.get('company') || cookieStore.get('craze_selected_company')?.value || 'CRAZE';   // ?company= (selector del informe) o la empresa del menú
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });

    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: 'Rango de fechas no válido' }, { status: 400 });

    const force = searchParams.get('force') === '1';
    const ctx = await getBcContext(company).catch(e => { console.error('License sales BC:', e); return null; });
    const r = await royaltiesReport(ctx, company, from, to, force);
    const byCode: Record<string, { turnover: number; amount: number; qty: number; provision: number }> = {};
    for (const row of r.rows) {
      const c = (byCode[row.code] ||= { turnover: 0, amount: 0, qty: 0, provision: 0 });
      c.provision += row.provision;
      c.turnover += row.turnover;
      c.amount += row.amount;
      c.qty += row.qty;
    }
    // Nombres de los Customer Groups (API custom customerGroups)
    const groupNames = ctx ? await cached(`license-sales:groups:${company}`, 6 * HOUR, async () => {
      const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/customerGroups`, { $select: 'code,description' }), ctx.token);
      return Object.fromEntries(rows.map((g: any) => [str(g.code), str(g.description)]));
    }, force).catch(() => ({} as Record<string, string>)) : {};
    return NextResponse.json({
      from, to, company, currency: r.currency, eurRate: r.fx?.rate ?? (r.currency === 'EUR' ? 1 : null), ratesSource: r.ratesSource, amountField: r.amountField, shipCountryField: r.shipCountryField,
      byCode, breakdown: r.breakdown, groupNames, lines: r.stats.lines, ic: r.stats.ic, itemsError: r.itemsError,
    });
  } catch (error: any) {
    console.error('Error in license sales:', error);
    const status = error instanceof RoyaltiesSetupError ? 422 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
}
