import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { FIRST_YEAR, logisticYear } from '@/lib/logisticCost';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Logistic Cost: /api/logistic-cost?year=YYYY[&force=1] → { cur, prev } (prev = año anterior, de su caché)
export async function GET(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company !== 'CRAZE') return NextResponse.json({ error: 'Logistic Cost solo está disponible para CRAZE GmbH.' }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const year = Number(searchParams.get('year')) || new Date().getFullYear();
    if (year < FIRST_YEAR || year > new Date().getFullYear()) return NextResponse.json({ error: `Año no válido (desde ${FIRST_YEAR})` }, { status: 400 });
    const ctx = await getBcContext(company);
    const force = searchParams.get('force') === '1';
    const [cur, prev] = await Promise.all([
      logisticYear(ctx, company, year, force),
      year - 1 >= FIRST_YEAR ? logisticYear(ctx, company, year - 1) : Promise.resolve(null),
    ]);
    return NextResponse.json({ cur, prev });
  } catch (error: any) {
    console.error('Logistic Cost:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
