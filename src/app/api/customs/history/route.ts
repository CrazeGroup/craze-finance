import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { customsHistory } from '@/lib/customsHistory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Histórico de códigos arancelarios: facturas Zoll del año con el análisis de su PDF adjunto (guardado por AT/C).
// Cada llamada procesa los AT/C nuevos que caben en ~40 s y devuelve cuántos quedan (pending).
// ?year=2026[&recompute=<AT/C>|*]
export async function GET(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const year = Number(searchParams.get('year')) || new Date().getFullYear();
    const ctx = await getBcContext(company);
    return NextResponse.json(await customsHistory(ctx, company, year, searchParams.get('recompute') || undefined));
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
