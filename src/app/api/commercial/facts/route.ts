import { NextResponse } from 'next/server';
import { commercialFacts, COMPANIES, type CompanyAbbr } from '@/lib/commercial/commercial';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Sell-in, presupuesto y forecast agregados de una empresa y año: /api/commercial/facts?company=GmbH&year=2026[&force=1]
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const company = searchParams.get('company') as CompanyAbbr;
    const year = Number(searchParams.get('year'));
    if (!COMPANIES.some(c => c.abbr === company) || !Number.isInteger(year) || year < 2023 || year > 2100) {
      return NextResponse.json({ error: 'Parámetros no válidos' }, { status: 400 });
    }
    return NextResponse.json(await commercialFacts(company, year, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Commercial facts:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
