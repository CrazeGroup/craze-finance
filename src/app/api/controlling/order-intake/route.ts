import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { orderIntakeYear } from '@/lib/controlling/orderIntake';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Facturación según Order Date de un año: /api/controlling/order-intake?year=YYYY&from=M&to=M[&open=1][&force=1]
// open=1 añade las Sales Orders abiertas (solo tiene sentido en el año en curso)
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });

    const { searchParams } = new URL(req.url);
    const year = Number(searchParams.get('year'));
    const from = Number(searchParams.get('from'));
    const to = Number(searchParams.get('to'));
    if (!Number.isInteger(year) || year < 2000 || !(from >= 1 && to <= 12 && from <= to)) {
      return NextResponse.json({ error: 'Periodo no válido' }, { status: 400 });
    }
    const ctx = await getBcContext(company);
    return NextResponse.json(await orderIntakeYear(ctx, year, from, to, searchParams.get('open') === '1', searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Error in order intake:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
