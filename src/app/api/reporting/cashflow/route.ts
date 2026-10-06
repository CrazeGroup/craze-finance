import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { getCashflow } from '@/lib/cashflow';
import { monthEnd, monthStart, parseMonths, shiftMonth } from '@/lib/reporting';

export const dynamic = 'force-dynamic';

const FORECAST_MONTHS = 3;

// Resumen mensual del cashflow (mismos movimientos que la pantalla Cashflow) por divisa:
// saldo inicial, cobros, pagos y saldo final de los meses seleccionados + previsión de los 3 siguientes
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (companyId === 'ALL') {
      return NextResponse.json({ error: 'Selecciona una empresa concreta para ver el cashflow.' }, { status: 400 });
    }
    const months = parseMonths(new URL(req.url).searchParams.get('months'));
    if (months.length === 0) return NextResponse.json({ error: 'Selecciona al menos un mes.' }, { status: 400 });

    const lastMonth = months[months.length - 1];
    const forecast = Array.from({ length: FORECAST_MONTHS }, (_, i) => shiftMonth(lastMonth, i + 1));

    const configs = await prisma.cashflowConfig.findMany({ where: { companyId }, select: { currencyCode: true } });
    const currencies = configs.length > 0 ? configs.map(c => c.currencyCode).sort() : ['EUR'];

    const result = await Promise.all(currencies.map(async currency => {
      const { initialBalance, initialBalanceDate, entries } = await getCashflow(companyId, currency);

      const summarizeMonth = (month: string) => {
        const from = new Date(`${monthStart(month)}T00:00:00Z`);
        const to = new Date(`${monthEnd(month)}T23:59:59.999Z`);
        const before = entries.filter(e => e.date < from);
        const inMonth = entries.filter(e => e.date >= from && e.date <= to);
        const opening = before.length > 0 ? before[before.length - 1].balance : initialBalance;
        const inflows = inMonth.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0);
        const outflows = inMonth.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0);
        return { month, opening, inflows, outflows, closing: opening + inflows + outflows };
      };

      return {
        currency,
        initialBalance,
        initialBalanceDate,
        months: months.map(summarizeMonth),
        forecast: forecast.map(summarizeMonth),
      };
    }));

    return NextResponse.json({ currencies: result });
  } catch (error: any) {
    console.error('Error in reporting cashflow:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
