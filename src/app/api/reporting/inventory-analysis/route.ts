import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { isValidMonth } from '@/lib/reporting/period';
import { inventoryAnalysis } from '@/lib/reporting/inventoryAnalysis';

export const dynamic = 'force-dynamic';
// Sin caché lee todos los movimientos de valor y calcula ~24 fines de mes
export const maxDuration = 300;

// Análisis Inventario: /api/reporting/inventory-analysis?month=YYYY-MM[&force=1]
export async function GET(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const month = searchParams.get('month');
    if (!isValidMonth(month)) return NextResponse.json({ error: 'Mes no válido' }, { status: 400 });
    return NextResponse.json(await inventoryAnalysis(await getBcContext(company), company, month, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Error in inventory analysis:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
