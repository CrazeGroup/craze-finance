import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { probeSources, purchaseItemsReport } from '@/lib/controlling/purchaseItems';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Controlling · compras por artículo: /api/controlling/purchase-items?from=YYYY-MM-DD&to=YYYY-MM-DD[&force=1]
const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from'), to = searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: 'Fechas no válidas' }, { status: 400 });
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const ctx = await getBcContext(company);
    if (searchParams.get('probe') === '1') return NextResponse.json(await probeSources(ctx, from, to));
    return NextResponse.json(await purchaseItemsReport(ctx, company, from, to, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Error in controlling purchase-items:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
