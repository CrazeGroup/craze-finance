import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { findService } from '@/lib/royalties';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const r2 = (v: number) => Math.round(v * 100) / 100;

// Consumed Provisions · /api/controlling/consumed-provisions?from=&to=&probe=lm|gl (diagnóstico)
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from'), to = searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: 'Fechas no válidas' }, { status: 400 });
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const ctx = await getBcContext(company === 'ALL' ? 'CRAZE' : company);
    const probe = searchParams.get('probe');

    if (probe === 'lm') {
      const service = await findService(ctx);
      const rows = await bcFetchAll(odataUrl(service.url, { $filter: `Posting_date ge ${from} and Posting_date le ${to}` }), ctx.token);
      const sums: Record<string, number> = {};
      for (const r of rows) for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && /prov|turnover/i.test(k)) sums[k] = (sums[k] || 0) + v;
      return NextResponse.json({ rows: rows.length, docs: new Set(rows.map((r: any) => r.Document_No)).size, sums: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, r2(v)])) });
    }
    if (probe === 'gl') {
      const accounts = (searchParams.get('accounts') || 'PROV-AMZPROM,PROV-KONDITIONS,PROV-MARKETING,PROV-ROYALTIES').split(',');
      const entries = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: `Posting_Date ge ${from} and Posting_Date le ${to} and (${accounts.map(a => `G_L_Account_No eq '${a}'`).join(' or ')})`,
        $select: 'Entry_No,Posting_Date,Document_Type,Document_No,G_L_Account_No,Description,Amount,Source_Type,Source_No,Source_Code,External_Document_No,Bal_Account_No,Gen_Posting_Type,Transaction_No',
      }), ctx.token);
      const summary: Record<string, any> = {};
      for (const e of entries) {
        const k = `${e.G_L_Account_No} | ${e.Document_Type || '-'} | ${String(e.Document_No).replace(/\d+$/, '#')} | ${e.Source_Code} | ${e.Source_Type || '-'}`;
        const s = summary[k] ||= { n: 0, amount: 0, sample: [] as any[] };
        s.n++; s.amount = r2(s.amount + e.Amount);
        if (s.sample.length < 3) s.sample.push(e);
      }
      // Todos los movimientos de algunos documentos no PROV- (para ver dónde se registraron inicialmente)
      const docs = Array.from(new Set(entries.filter((e: any) => !String(e.Document_No).startsWith('PROV-')).map((e: any) => e.Document_No))).slice(0, 8) as string[];
      const related = docs.length ? await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: docs.map(d => `Document_No eq '${d.replace(/'/g, "''")}'`).join(' or '),
        $select: 'Entry_No,Posting_Date,Document_Type,Document_No,G_L_Account_No,Description,Amount,Source_Type,Source_No,Source_Code,External_Document_No',
      }), ctx.token) : [];
      return NextResponse.json({ entries: entries.length, summary, related });
    }
    return NextResponse.json({ error: 'Pendiente' }, { status: 501 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
