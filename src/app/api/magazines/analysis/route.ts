import { NextResponse } from 'next/server';
import { applyManual, magazineAnalysis, manualLines, validatedLines } from '@/lib/magazineAnalysis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Magazine Profitability: beneficio por revista (Craze Entertainment). ?force=1 vuelve a leer BC.
// Las asignaciones a mano y las validaciones se leen aparte de la caché para que se vean al momento.
export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get('force') === '1';
    const [data, validated, manual] = await Promise.all([magazineAnalysis(force), validatedLines(), manualLines()]);
    return NextResponse.json({ ...applyManual(data, manual), validated });
  } catch (error: any) {
    console.error('Magazine analysis:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
