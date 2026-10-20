import { NextResponse } from 'next/server';
import { getBcContext } from '@/lib/bcClient';
import { bwaPbiData } from '@/lib/controlling/bwaPbi';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// BWA del Power BI (todas las sociedades, leído desde CRAZE): /api/controlling/bwa-pbi?year=YYYY[&force=1]
// Devuelve el año pedido y el anterior (para la comparativa Year -1).
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const year = Number(searchParams.get('year'));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return NextResponse.json({ error: 'Año no válido' }, { status: 400 });
    const ctx = await getBcContext('CRAZE');
    return NextResponse.json(await bwaPbiData(ctx, year, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Error in BWA Power BI:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
