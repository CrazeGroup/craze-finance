import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { isValidMonth } from '@/lib/reporting/period';
import { inventoryReport } from '@/lib/reporting/inventory';
import { chinaPurchasesReport, payablesReport, receivablesReport } from '@/lib/reporting/ledgers';
import { provisionsReport } from '@/lib/reporting/provisions';
import { bwaReport } from '@/lib/reporting/bwa';
import { cashflowReport } from '@/lib/reporting/cashflowReport';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Un bloque del reporting mensual: /api/reporting/<bloque>?month=YYYY-MM[&force=1]
// Los datos se leen de Business Central (con caché) salvo el cashflow, que es el de la propia app.
const SECTIONS = ['inventory', 'purchases', 'receivables', 'payables', 'provisions', 'bwa', 'cashflow'] as const;
type Section = typeof SECTIONS[number];

export async function GET(req: Request, { params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  try {
    if (!SECTIONS.includes(section as Section)) return NextResponse.json({ error: 'Bloque no válido' }, { status: 404 });
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const { searchParams } = new URL(req.url);
    const month = searchParams.get('month');
    const force = searchParams.get('force') === '1';
    if (!isValidMonth(month)) return NextResponse.json({ error: 'Mes no válido' }, { status: 400 });

    if (section === 'cashflow') {
      if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
      return NextResponse.json(await cashflowReport(company));
    }

    // El BWA es de todo el grupo; el resto, de la empresa seleccionada
    const bcCompany = section === 'bwa' || company === 'ALL' ? 'CRAZE' : company;
    if (company === 'ALL' && section !== 'bwa') {
      return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    }
    const ctx = await getBcContext(bcCompany);

    switch (section as Section) {
      case 'inventory': return NextResponse.json(await inventoryReport(ctx, company, month, force));
      case 'purchases': return NextResponse.json(await chinaPurchasesReport(ctx, company, month, force));
      case 'receivables': return NextResponse.json(await receivablesReport(ctx, company, month, force));
      case 'payables': return NextResponse.json(await payablesReport(ctx, company, month, force));
      case 'provisions': return NextResponse.json(await provisionsReport(ctx, company, month, force));
      case 'bwa': return NextResponse.json(await bwaReport(ctx, month, force));
    }
    return NextResponse.json({ error: 'Bloque no válido' }, { status: 404 });
  } catch (error: any) {
    console.error(`Error in reporting ${section}:`, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
