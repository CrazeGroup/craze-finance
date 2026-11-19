import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { journalByCode, sendToBatch, type SendMovement } from '@/lib/banco';
import { logAction } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una línea de BC por llamada, más el tipo de documento por OData
export const maxDuration = 300;

const TYPES = ['G/L Account', 'Customer', 'Vendor', 'Bank Account'];
const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

// Envía al lote (sin registrar) las líneas de los movimientos elegidos: { journalCode, bankNo, movements }
export async function POST(req: Request) {
  try {
    const companyId = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (companyId === 'ALL') return NextResponse.json({ error: 'Select a specific company.' }, { status: 400 });
    const body = await req.json() as { journalCode: string; bankNo: string; movements: SendMovement[] };
    if (!body.journalCode || !body.bankNo) return NextResponse.json({ error: 'Choose the bank account and the batch.' }, { status: 400 });
    if (!Array.isArray(body.movements) || !body.movements.length) return NextResponse.json({ error: 'There are no transactions to send.' }, { status: 400 });
    for (const m of body.movements) {
      if (!isDate(m.date || '')) return NextResponse.json({ error: 'A transaction has no date.' }, { status: 400 });
      if (!m.lines?.length) return NextResponse.json({ error: `The transaction of ${m.date} has no lines.` }, { status: 400 });
      const bad = m.lines.find(l => !TYPES.includes(l.accountType) || !String(l.accountNo || '').trim() || !Number.isFinite(l.amount) || !l.amount);
      if (bad) return NextResponse.json({ error: `A line of ${m.date} is missing the account or the amount (${bad.description || 'no description'}).` }, { status: 400 });
    }

    const ctx = await getBcContext(companyId);
    const journal = await journalByCode(ctx, body.journalCode);
    const result = await sendToBatch(ctx, journal, body.bankNo, body.movements);
    await logAction('BANCO: lines sent to the General Journal', `${journal.code} · bank ${body.bankNo} · transactions: ${body.movements.length} · lines: ${result.lines}`, companyId);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('BANCO envío:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
