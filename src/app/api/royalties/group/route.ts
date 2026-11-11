import { NextResponse } from 'next/server';
import { groupRoyaltiesReport } from '@/lib/royalties';

export const dynamic = 'force-dynamic';
// Sin caché puede tardar más de 60 s; se precalcula cada mañana (warm-daily.yml)
export const maxDuration = 300;

const isDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

// Provisión de royalties por licencia de todas las empresas del grupo: /api/royalties/group?from=&to=[&force=1]
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: 'Rango de fechas no válido' }, { status: 400 });
    return NextResponse.json(await groupRoyaltiesReport(from, to, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Error in royalties group:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
