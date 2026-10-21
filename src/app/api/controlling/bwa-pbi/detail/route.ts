import { NextResponse } from 'next/server';
import { bwaAccountDetail } from '@/lib/controlling/bwaPbiDetail';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);

// Movimientos de una cuenta de mapeo del BWA: /api/controlling/bwa-pbi/detail?account=6000 00&scope=CRAZE&from=&to=[&force=1]
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const account = searchParams.get('account') || '';
    const scope = searchParams.get('scope') || '';
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (!account || !scope || !isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: 'Parámetros no válidos' }, { status: 400 });
    return NextResponse.json(await bwaAccountDetail(account, scope, from, to, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Error in BWA detail:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
