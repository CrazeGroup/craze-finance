import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { journalByCode, sendClearing, type ClearingLine } from '@/lib/banco';
import { logAction } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const cents = (v: number) => Math.round(v * 100);

// Open Entries: cierra dos movimientos abiertos de distinto cliente / proveedor que se compensan, con dos líneas en el
// lote (sin registrar), misma fecha y mismo nº de documento, sin contrapartida: { journalCode, date, lines }
export async function POST(req: Request) {
  try {
    const companyId = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (companyId === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const body = await req.json() as { journalCode: string; date: string; lines: (ClearingLine & { postingDate?: string | null })[] };
    if (!body.journalCode) return NextResponse.json({ error: 'Elige el lote del General Journal.' }, { status: 400 });
    if (!isDate(body.date || '')) return NextResponse.json({ error: 'Falta la fecha.' }, { status: 400 });
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length < 2) return NextResponse.json({ error: 'Hacen falta las dos líneas.' }, { status: 400 });
    if (lines.some(l => !['Customer', 'Vendor'].includes(l.accountType) || !String(l.accountNo || '').trim() || !cents(l.amount) || !l.appliesToDocNo))
      return NextResponse.json({ error: 'Falta la cuenta, el importe o el documento a liquidar en alguna línea.' }, { status: 400 });
    if (lines.reduce((t, l) => t + cents(l.amount), 0) !== 0) return NextResponse.json({ error: 'Las líneas no suman 0.' }, { status: 400 });
    if (new Set(lines.map(l => l.currencyCode || '')).size > 1) return NextResponse.json({ error: 'Los movimientos tienen distinta divisa.' }, { status: 400 });

    // BC no deja liquidar un movimiento con fecha posterior a la del asiento
    const latest = lines.map(l => String(l.postingDate || '')).sort().pop() || '';
    if (latest && body.date < latest) return NextResponse.json({ error: `La fecha no puede ser anterior al ${latest.split('-').reverse().join('/')} (el movimiento más reciente de los dos).` }, { status: 400 });

    const ctx = await getBcContext(companyId);
    const journal = await journalByCode(ctx, body.journalCode);
    const result = await sendClearing(ctx, journal, body.date, lines.map(({ postingDate, ...l }) => l)); // eslint-disable-line @typescript-eslint/no-unused-vars
    await logAction('Open Entries: cierre cruzado enviado al General Journal',
      `${journal.code} · ${result.documentNumber} · ${lines.map(l => `${l.accountType} ${l.accountNo} ${l.appliesToDocNo} ${l.amount}`).join(' / ')}`, companyId);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Open Entries cierre:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
