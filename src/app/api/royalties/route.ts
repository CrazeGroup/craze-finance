import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { royaltiesReport, RoyaltiesSetupError } from '@/lib/royalties';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

// Royalties de la empresa seleccionada: /api/royalties?from=YYYY-MM-DD&to=YYYY-MM-DD[&force=1]
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });

    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: 'Rango de fechas no válido' }, { status: 400 });

    // Sin conexión a BC se usa el último Excel subido
    const ctx = await getBcContext(company).catch(e => { console.error('Royalties BC:', e); return null; });
    return NextResponse.json(await royaltiesReport(ctx, company, from, to, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Error in royalties:', error);
    if (error instanceof RoyaltiesSetupError) {
      return NextResponse.json({ error: error.message, details: error.details }, { status: 422 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
