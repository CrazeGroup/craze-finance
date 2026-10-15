import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { consumedProvisionsReport } from '@/lib/controlling/consumedProvisions';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Controlling · Consumed Provisions: /api/controlling/consumed-provisions?from=YYYY-MM-DD&to=YYYY-MM-DD[&force=1]
const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from'), to = searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: 'Fechas no válidas' }, { status: 400 });
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const ctx = await getBcContext(company);
    // Diagnóstico: asientos PROV* agrupados por cuenta, descripción y mes, con el tipo de cuenta (balance / resultados)
    if (searchParams.get('probe') === 'provgl') {
      const [entries, accounts] = await Promise.all([
        bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
          $filter: `startswith(Document_No,'PROV') and Posting_Date ge ${from} and Posting_Date le ${to}`,
          $select: 'Entry_No,Posting_Date,Document_No,G_L_Account_No,Description,Amount,Source_Code',
        }), ctx.token),
        bcFetchAll(`${ctx.customApiBase}/glAccounts`, ctx.token).catch(() => [] as any[]),
      ]);
      const acc = new Map(accounts.map((a: any) => [String(a.no), a]));
      const groups: Record<string, any> = {};
      for (const e of entries) {
        const a: any = acc.get(String(e.G_L_Account_No)) || {};
        const k = `${e.G_L_Account_No}|${e.Description}`;
        const g = groups[k] ||= { account: e.G_L_Account_No, description: e.Description, incomeBalance: a.incomeBalance, accountName: a.name, total: 0, byMonth: {} as Record<string, number> };
        g.total = Math.round((g.total + e.Amount) * 100) / 100;
        const m = String(e.Posting_Date).substring(0, 7);
        g.byMonth[m] = Math.round(((g.byMonth[m] || 0) + e.Amount) * 100) / 100;
      }
      return NextResponse.json({ accountFields: Object.keys(accounts[0] || {}), groups: Object.values(groups) });
    }
    return NextResponse.json(await consumedProvisionsReport(ctx, company, from, to, searchParams.get('force') === '1'));
  } catch (error: any) {
    console.error('Error in consumed-provisions:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
