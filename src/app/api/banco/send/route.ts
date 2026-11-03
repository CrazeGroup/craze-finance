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
    if (companyId === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const body = await req.json() as { journalCode: string; bankNo: string; movements: SendMovement[] };
    if (!body.journalCode || !body.bankNo) return NextResponse.json({ error: 'Elige la cuenta de banco y el lote.' }, { status: 400 });
    if (!Array.isArray(body.movements) || !body.movements.length) return NextResponse.json({ error: 'No hay movimientos que enviar.' }, { status: 400 });
    for (const m of body.movements) {
      if (!isDate(m.date || '')) return NextResponse.json({ error: 'Hay un movimiento sin fecha.' }, { status: 400 });
      if (!m.lines?.length) return NextResponse.json({ error: `El movimiento del ${m.date} no tiene líneas.` }, { status: 400 });
      const bad = m.lines.find(l => !TYPES.includes(l.accountType) || !String(l.accountNo || '').trim() || !Number.isFinite(l.amount) || !l.amount);
      if (bad) return NextResponse.json({ error: `Falta la cuenta o el importe en una línea del ${m.date} (${bad.description || 'sin descripción'}).` }, { status: 400 });
    }

    const ctx = await getBcContext(companyId);
    const journal = await journalByCode(ctx, body.journalCode);
    const result = await sendToBatch(ctx, journal, body.bankNo, body.movements);
    await logAction('BANCO: líneas enviadas al General Journal', `${journal.code} · banco ${body.bankNo} · ${body.movements.length} movimientos · ${result.lines} líneas`, companyId);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('BANCO envío:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
