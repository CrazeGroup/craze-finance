import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { cutoffDate, isValidMonth } from '@/lib/reporting/period';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Comprobación de una provisión del reporting, en directo de BC:
// /api/reporting/provision-check?doc=PROV-00049[&month=2026-09][&company=CRAZE]
// Devuelve todos los movimientos contables del documento (cualquier cuenta y fecha) y cómo los suma el reporting.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const doc = (searchParams.get('doc') || '').trim();
    if (!doc) return NextResponse.json({ error: 'Indica ?doc=PROV-00049' }, { status: 400 });
    const cookieStore = await cookies();
    const company = searchParams.get('company') || cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const month = searchParams.get('month');
    const date = isValidMonth(month) ? cutoffDate(month) : null;
    const ctx = await getBcContext(company === 'ALL' ? 'CRAZE' : company);

    const [accounts, entries] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.customApiBase}/glAccounts`, { $filter: 'provision eq true', $select: 'no,name' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: `Document_No eq '${doc.replace(/'/g, "''")}'`,
        $select: 'Entry_No,Posting_Date,Document_No,G_L_Account_No,Description,Amount',
      }), ctx.token),
    ]);
    const provisionAccounts = new Set(accounts.map((a: any) => a.no));
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const list = entries.sort((a: any, b: any) => a.Entry_No - b.Entry_No).map((e: any) => ({
      entryNo: e.Entry_No, date: e.Posting_Date, account: e.G_L_Account_No, description: e.Description, amount: e.Amount,
      provisionAccount: provisionAccounts.has(e.G_L_Account_No), beforeCutoff: date ? e.Posting_Date <= date : true,
    }));
    const byAccount: Record<string, { provisionAccount: boolean; total: number; totalToCutoff: number; n: number }> = {};
    for (const e of list) {
      const a = (byAccount[e.account] ||= { provisionAccount: e.provisionAccount, total: 0, totalToCutoff: 0, n: 0 });
      a.total = r2(a.total + e.amount); a.n++;
      if (e.beforeCutoff) a.totalToCutoff = r2(a.totalToCutoff + e.amount);
    }
    const used = list.filter((e: any) => e.provisionAccount && e.beforeCutoff);
    return NextResponse.json({
      company: ctx.companyName, doc, cutoff: date,
      reporting: {
        note: 'Lo que suma el reporting: movimientos en cuentas de provisión hasta la fecha de corte',
        original: used[0]?.amount ?? null, open: r2(used.reduce((s: number, e: any) => s + e.amount, 0)), entries: used.length,
      },
      byAccount,
      provisionAccounts: accounts.map((a: any) => `${a.no} ${a.name}`),
      entries: list,
    });
  } catch (error: any) {
    console.error('Error in provision-check:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
