import { NextResponse } from 'next/server';
import { commercialFacts, commercialPlans, COMPANIES, withPart, type CompanyAbbr } from '@/lib/commercial/commercial';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Sell-in, presupuesto y forecast agregados de una empresa y año: /api/commercial/facts?company=GmbH&year=2026[&force=1][&plans=1]
// force=1 relee de BC el facturado y los pedidos; plans=1, el presupuesto y el forecast (guardados aparte, se renuevan a diario).
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const company = searchParams.get('company') as CompanyAbbr;
    const year = Number(searchParams.get('year'));
    if (!COMPANIES.some(c => c.abbr === company) || !Number.isInteger(year) || year < 2023 || year > 2100) {
      return NextResponse.json({ error: 'Parámetros no válidos' }, { status: 400 });
    }
    const [facts, plans] = await Promise.all([
      commercialFacts(company, year, searchParams.get('force') === '1'),
      commercialPlans(company, year, searchParams.get('plans') === '1'),
    ]);
    return NextResponse.json({
      ...facts,
      rows: [...facts.rows, ...withPart(plans.rows)],
      items: [...(facts.items || []), ...plans.items.filter(i => !(facts.items || []).some(f => f.no === i.no))],
      counts: { ...facts.counts, ...plans.counts },
      plansUpdated: plans.updated,
      warnings: [...facts.warnings, ...plans.warnings],
    });
  } catch (error: any) {
    console.error('Commercial facts:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
