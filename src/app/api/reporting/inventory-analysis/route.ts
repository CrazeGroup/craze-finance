import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { isValidMonth } from '@/lib/reporting/period';
import { inventoryAnalysis, purchasesAnalysis } from '@/lib/reporting/inventoryAnalysis';
import { inventoryKpis } from '@/lib/reporting/inventoryKpis';

export const dynamic = 'force-dynamic';
// Sin caché lee todos los movimientos de valor y calcula ~24 fines de mes
export const maxDuration = 300;

// Análisis Inventario: /api/reporting/inventory-analysis?month=YYYY-MM[&kind=purchases|kpis][&force=1]
// (kind=purchases: compras CHINA TRF por línea de factura; kind=kpis: destruido, palets y Average Days in Stock)
export async function GET(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const month = searchParams.get('month');
    if (!isValidMonth(month)) return NextResponse.json({ error: 'Mes no válido' }, { status: 400 });
    const ctx = await getBcContext(company);
    const force = searchParams.get('force') === '1';
    const kind = searchParams.get('kind');
    return NextResponse.json(kind === 'purchases' ? await purchasesAnalysis(ctx, company, month, force)
      : kind === 'kpis' ? await inventoryKpis(ctx, company, month, force)
      : await inventoryAnalysis(ctx, company, month, force));
  } catch (error: any) {
    console.error('Error in inventory analysis:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
