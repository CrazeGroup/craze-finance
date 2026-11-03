import { NextResponse } from 'next/server';
import { getBcContext } from '@/lib/bcClient';
import { DFORCE_COMPANY } from '@/lib/dforce';
import { createAssemblyOrder, learnOutput, LOC_DAMAGED, LOC_GOOD, type OrderInput } from '@/lib/mailfinish';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Crea en BC (sin registrar) una Assembly Order de MAILFINISH: body = OrderInput + gadget (código del informe), una orden
// por llamada. Si el artículo no es el código del informe, guarda la equivalencia para los próximos informes.
export async function POST(req: Request) {
  try {
    const { gadget, ...o } = (await req.json()) as OrderInput & { gadget?: string };
    if (![LOC_GOOD, LOC_DAMAGED].includes(o.location)) return NextResponse.json({ error: 'Location no válida.' }, { status: 400 });
    if (!o.output || !o.input || !o.inputLocation) return NextResponse.json({ error: 'Faltan el gadget o la revista.' }, { status: 400 });
    if (!(o.quantity > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(o.date || '')) return NextResponse.json({ error: 'Cantidad o fecha no válida.' }, { status: 400 });
    const ctx = await getBcContext(DFORCE_COMPANY);
    const result = await createAssemblyOrder(ctx, o);
    if (gadget && gadget !== o.output) await learnOutput(gadget, o.output).catch(() => {});
    await logAction('MAILFINISH: Assembly Order creada en BC', `${result.no} · ${o.quantity} × ${o.output} en ${o.location} ← ${o.input} (${o.inputLocation}) · ${o.date}`, DFORCE_COMPANY);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('MAILFINISH create:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
