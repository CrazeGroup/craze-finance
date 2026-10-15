import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { cutoffDate, isValidMonth, today } from '@/lib/reporting/period';
import { accountKey, buildProvisionRows, fetchProvisionData } from '@/lib/reporting/provisions';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Comprobación de una provisión del reporting, en directo de BC:
// /api/reporting/provision-check?doc=PROV-00049[&month=2026-09][&company=CRAZE]
// Devuelve los movimientos contables del documento, su serie (cuenta de provisión) con todos sus documentos
// y el original / consumido / abierto que calcula el reporting.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const doc = (searchParams.get('doc') || '').trim().toUpperCase();
    if (!doc) return NextResponse.json({ error: 'Indica ?doc=PROV-00049' }, { status: 400 });
    const cookieStore = await cookies();
    const company = searchParams.get('company') || cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const month = searchParams.get('month');
    const date = isValidMonth(month) ? cutoffDate(month) : today();
    const ctx = await getBcContext(company === 'ALL' ? 'CRAZE' : company);

    const { entries, flagged } = await fetchProvisionData(ctx, date);
    const rows = buildProvisionRows(entries, flagged, date, date.substring(0, 4));
    const row = rows.find(r => r.doc.toUpperCase() === doc);
    const series = row ? rows.filter(r => r.series === row.series) : [];
    const docEntries = entries.filter(e => String(e.Document_No).toUpperCase() === doc).sort((a, b) => a.Entry_No - b.Entry_No);
    return NextResponse.json({
      company: ctx.companyName, doc, cutoff: date,
      reporting: row ? {
        series: row.account, original: row.orig, consumed: row.cons, open: row.open, latestOfSeries: row.latest,
        note: 'Abierto = saldo de la cuenta de provisión de la serie con todos sus documentos PROV* del año, en el último documento',
      } : 'El documento no tiene movimientos PROV* en una cuenta de balance hasta la fecha de corte',
      seriesDocuments: series.map(r => ({ doc: r.doc, date: r.date, desc: r.desc, original: r.orig, open: r.open })),
      entries: docEntries.map(e => ({
        entryNo: e.Entry_No, date: e.Posting_Date, account: e.G_L_Account_No, description: e.Description, amount: e.Amount,
        seriesAccount: row ? accountKey(e.G_L_Account_No) === row.series : false,
      })),
    });
  } catch (error: any) {
    console.error('Error in provision-check:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
