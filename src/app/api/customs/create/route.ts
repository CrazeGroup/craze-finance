import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { createInvoices, customsConfig, existingInvoices, type CreateInput } from '@/lib/customs';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

// Crea en BC (sin registrar) las facturas de Zoll y EUSt de una declaración: { atc, date, description, invoices }
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const body = (await req.json()) as CreateInput;
    if (!body.atc || !isDate(body.date || '') || !Array.isArray(body.invoices) || !body.invoices.length) {
      return NextResponse.json({ error: 'Faltan el nº AT/C, la fecha o los importes.' }, { status: 400 });
    }
    const [ctx, cfg] = await Promise.all([getBcContext(company), customsConfig()]);

    // No duplicar: solo los tipos que aún no existen con ese nº AT/C (force: el usuario confirmó crearlas de nuevo)
    const existing = await existingInvoices(ctx, body.atc, cfg);
    const invoices = body.force ? body.invoices : body.invoices.filter(i => !existing.some(e => e.kind === i.kind));
    if (!invoices.length) return NextResponse.json({ error: `Ya existen en BC: ${existing.map(e => e.no).join(', ')}`, existing }, { status: 409 });

    const result = await createInvoices(ctx, { ...body, invoices }, cfg);
    if (result.created.length) {
      await logAction('Aduanas: facturas creadas en BC', `${body.atc}${body.force ? ' (ya existían)' : ''} · ${result.created.map(c => `${c.kind.toUpperCase()} ${c.no} ${c.amount}`).join(' · ')}`);
    }
    return NextResponse.json(result, { status: result.error ? 502 : 200 });
  } catch (error: any) {
    console.error('Aduanas create:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
