import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { compactHistory, customsHistory, customsHistoryStored } from '@/lib/customsHistory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Histórico de códigos arancelarios: facturas Zoll del año con el análisis de su PDF adjunto (guardado por AT/C).
// Cada llamada procesa los AT/C nuevos que caben en ~40 s y devuelve cuántos quedan (pending).
// ?year=2026[&recompute=<AT/C>|*]
// ?stored=1: solo lo guardado, sin llamar a BC (al momento; null si aún no hay índice del año)
// ?atc=<AT/C>: el detalle completo de una declaración guardada (descripciones y Positionsbefund de las posiciones)
// ?full=1: sin resumir (Excel). Sin full, la lista va resumida (compactHistory)
export async function GET(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const year = Number(searchParams.get('year')) || new Date().getFullYear();
    const full = searchParams.get('full') === '1';
    const atc = searchParams.get('atc');
    if (atc) {
      const d = await customsHistoryStored(company, year, atc);
      return NextResponse.json({ entry: d?.entries[0] || null });
    }
    if (searchParams.get('stored') === '1') {
      const d = await customsHistoryStored(company, year);
      return NextResponse.json(d ? (full ? d : compactHistory(d)) : { stored: false });
    }
    const ctx = await getBcContext(company);
    const d = await customsHistory(ctx, company, year, searchParams.get('recompute') || undefined);
    return NextResponse.json(full ? d : compactHistory(d));
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
