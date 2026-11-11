import { NextResponse } from 'next/server';
import { magazineAnalysis } from '@/lib/magazineAnalysis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// MAGAZINES › ANALYSIS: beneficio por revista (Craze Entertainment). ?force=1 vuelve a leer BC.
export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get('force') === '1';
    return NextResponse.json(await magazineAnalysis(force));
  } catch (error: any) {
    console.error('Magazine analysis:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
