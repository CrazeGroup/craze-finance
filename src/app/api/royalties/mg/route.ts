import { NextResponse } from 'next/server';
import { groupRoyaltiesReport } from '@/lib/royalties';
import { MG_CONTRACTS } from '@/lib/royaltyContracts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

// Minimum Guarantees: contratos + provisión de royalties del grupo desde el inicio de cada contrato hasta `to`
// (por empresa, código y país, en la divisa de cada empresa; la página la pasa a EUR). /api/royalties/mg?to=YYYY-MM-DD
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const to = searchParams.get('to');
    if (!isDate(to)) return NextResponse.json({ error: 'Fecha no válida' }, { status: 400 });
    const force = searchParams.get('force') === '1';
    const starts = Array.from(new Set(MG_CONTRACTS.map(c => c.start))).filter(s => s <= to).sort();
    const byStart: Record<string, Awaited<ReturnType<typeof groupRoyaltiesReport>>['companies']> = {};
    for (const start of starts) byStart[start] = (await groupRoyaltiesReport(start, to, force)).companies;
    return NextResponse.json({ to, contracts: MG_CONTRACTS, byStart });
  } catch (error: any) {
    console.error('Error in royalties MG:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
