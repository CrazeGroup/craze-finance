import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { chinaPayments, setScheduledDate } from '@/lib/chinaPayments';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const companyOf = async () => {
  const c = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
  return c === 'ALL' ? 'CRAZE' : c;
};

// Previsión de pagos CHINA TRF de la empresa activa (en directo de BC)
export async function GET() {
  try {
    const company = await companyOf();
    return NextResponse.json({ company, entries: await chinaPayments(company) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// { entryNos: number[], date: 'YYYY-MM-DD' | null } → Scheduled Payment Date en Vendor Ledger Entries de BC
export async function PATCH(request: Request) {
  try {
    const company = await companyOf();
    const { entryNos, date, docs } = await request.json();
    const ids = (Array.isArray(entryNos) ? entryNos : []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) return NextResponse.json({ error: 'No entries' }, { status: 400 });
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return NextResponse.json({ error: 'Invalid date' }, { status: 400 });
    const results = await setScheduledDate(company, ids, date);
    const ok = results.filter(r => r.ok).length;
    await logAction('Scheduled Payment Date changed (China payments)',
      `${date ? `Date ${date}` : 'Cleared (To be confirmed)'} | ${ok}/${ids.length} entries | ${Array.isArray(docs) ? docs.join(', ') : ids.join(', ')}`);
    return NextResponse.json({ results });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
