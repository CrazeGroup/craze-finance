import { NextResponse } from 'next/server';
import { commercialDims } from '@/lib/commercial/commercial';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Datos maestros de Commercial Analysis (artículos, Customer Groups, KAM, dimensiones), de CRAZE GmbH
export async function GET(req: Request) {
  try {
    return NextResponse.json(await commercialDims(new URL(req.url).searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Commercial dims:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
