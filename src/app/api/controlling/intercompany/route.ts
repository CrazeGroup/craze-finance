import { NextResponse } from 'next/server';
import { intercompanyReport, IC_COMPANIES } from '@/lib/controlling/intercompany';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);

// Facturas intercompañía emitidas por una empresa: /api/controlling/intercompany?company=CRAZE&from=&to=[&force=1]
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const company = searchParams.get('company') || 'CRAZE';
    const from = searchParams.get('from'), to = searchParams.get('to');
    if (!IC_COMPANIES.some(c => c.name === company) || !isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: 'Parámetros no válidos' }, { status: 400 });
    return NextResponse.json(await intercompanyReport(company, from, to, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Intercompany:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
