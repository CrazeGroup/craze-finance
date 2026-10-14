import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { isValidMonth } from '@/lib/reporting/period';
import { averageCostValuation } from '@/lib/inventoryAverageCost';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Inventario (Cierre) en directo de BC: /api/inventory-valuation/calculate?month=YYYY-MM[&force=1]
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const month = searchParams.get('month');
    if (!isValidMonth(month)) return NextResponse.json({ error: 'Mes no válido' }, { status: 400 });
    const ctx = await getBcContext(company);
    return NextResponse.json(await averageCostValuation(ctx, company, month, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Error in inventory average cost:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
