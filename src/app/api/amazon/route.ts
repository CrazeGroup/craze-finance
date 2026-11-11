import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { amazonYear, FIRST_YEAR } from '@/lib/amazonMargin';

export const dynamic = 'force-dynamic';
// Sin caché lee un año de líneas de venta, envíos, costes logísticos y Ads (y el año anterior para comparar)
export const maxDuration = 300;

// Amazon: margen por cliente Amazon. /api/amazon?year=YYYY[&force=1] → { cur, prev } (prev = año anterior, desde 2025)
// force solo recalcula el año pedido; el anterior sale de su caché.
export async function GET(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const year = Number(searchParams.get('year')) || new Date().getFullYear();
    if (year < FIRST_YEAR || year > new Date().getFullYear()) return NextResponse.json({ error: `Año no válido (desde ${FIRST_YEAR})` }, { status: 400 });
    const ctx = await getBcContext(company);
    const force = searchParams.get('force') === '1';
    const [cur, prev] = await Promise.all([
      amazonYear(ctx, company, year, force),
      year - 1 >= FIRST_YEAR ? amazonYear(ctx, company, year - 1) : Promise.resolve(null),
    ]);
    return NextResponse.json({ cur, prev });
  } catch (error: any) {
    console.error('Error in Amazon margin:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
