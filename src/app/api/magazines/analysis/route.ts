import { NextResponse } from 'next/server';
import { magazineAnalysis, validatedLines } from '@/lib/magazineAnalysis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Magazine Profitability: beneficio por revista (Craze Entertainment). ?force=1 vuelve a leer BC.
// validated (líneas sin revista dadas por buenas) se lee aparte de la caché para que se vea al momento.
export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get('force') === '1';
    const [data, validated] = await Promise.all([magazineAnalysis(force), validatedLines()]);
    return NextResponse.json({ ...data, validated });
  } catch (error: any) {
    console.error('Magazine analysis:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
