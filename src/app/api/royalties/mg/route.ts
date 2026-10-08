import { NextResponse } from 'next/server';
import { groupRoyaltiesReport } from '@/lib/royalties';
import { MG_CONTRACTS } from '@/lib/royaltyContracts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

// Minimum Guarantees: contratos + provisión de royalties del grupo por empresa, código, país y fecha hasta `to`
// (en la divisa de cada empresa; la página la pasa a EUR). /api/royalties/mg?to=YYYY-MM-DD
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const to = searchParams.get('to');
    if (!isDate(to)) return NextResponse.json({ error: 'Fecha no válida' }, { status: 400 });
    const force = searchParams.get('force') === '1';
    // Una sola lectura desde el inicio del contrato más antiguo, con la provisión por fecha; la página
    // la reparte por contrato y por periodo entre plazos de MG
    const from = MG_CONTRACTS.map(c => c.start).sort()[0];
    const companies = from <= to ? (await groupRoyaltiesReport(from, to, force, true)).companies.map(({ byCode, byCodeCountry, ...c }) => c) : [];
    return NextResponse.json({ to, contracts: MG_CONTRACTS, companies });
  } catch (error: any) {
    console.error('Error in royalties MG:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
