import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext, bcFetchAll } from '@/lib/bcClient';
import { getReportingConfig, monthEnd, parseMonths } from '@/lib/reporting';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Provisiones desde principio de año hasta el último mes seleccionado, a partir de las cuentas
// contables configuradas. Cuentas de pasivo: el haber es la dotación (original), el debe el consumo.
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (companyId === 'ALL') {
      return NextResponse.json({ error: 'Selecciona una empresa concreta para ver las provisiones.' }, { status: 400 });
    }
    const months = parseMonths(new URL(req.url).searchParams.get('months'));
    if (months.length === 0) return NextResponse.json({ error: 'Selecciona al menos un mes.' }, { status: 400 });

    const { provisionAccounts } = await getReportingConfig();
    if (provisionAccounts.length === 0) {
      return NextResponse.json({ notConfigured: true, accounts: [] });
    }

    const lastMonth = months[months.length - 1];
    const yearStart = `${lastMonth.substring(0, 4)}-01-01`;
    const endDate = monthEnd(lastMonth);

    const ctx = await getBcContext(companyId);
    const accountFilter = provisionAccounts.map(a => `accountNumber eq '${a.replace(/'/g, "''")}'`).join(' or ');
    const filter = `(${accountFilter}) and postingDate le ${endDate}`;
    const [entries, accounts] = await Promise.all([
      bcFetchAll(`${ctx.apiBase}/generalLedgerEntries?$filter=${encodeURIComponent(filter)}&$select=accountNumber,postingDate,debitAmount,creditAmount`, ctx.token),
      bcFetchAll(`${ctx.apiBase}/accounts?$filter=${encodeURIComponent(provisionAccounts.map(a => `number eq '${a.replace(/'/g, "''")}'`).join(' or '))}&$select=number,displayName`, ctx.token),
    ]);
    const accountNames = new Map(accounts.map((a: any) => [a.number, a.displayName]));

    const rows = provisionAccounts.map(account => {
      const row = { account, name: accountNames.get(account) || '', openingBalance: 0, original: 0, consumed: 0, open: 0 };
      for (const e of entries) {
        if (e.accountNumber !== account) continue;
        const credit = e.creditAmount || 0;
        const debit = e.debitAmount || 0;
        if (String(e.postingDate).substring(0, 10) < yearStart) {
          row.openingBalance += credit - debit;
        } else {
          row.original += credit;
          row.consumed += debit;
        }
      }
      row.open = row.openingBalance + row.original - row.consumed;
      return row;
    });

    const sum = (k: 'openingBalance' | 'original' | 'consumed' | 'open') => rows.reduce((s, r) => s + r[k], 0);
    return NextResponse.json({
      from: yearStart,
      to: endDate,
      accounts: rows,
      totals: { openingBalance: sum('openingBalance'), original: sum('original'), consumed: sum('consumed'), open: sum('open') },
    });
  } catch (error: any) {
    console.error('Error in reporting provisions:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
