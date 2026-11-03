import { NextResponse } from 'next/server';
import { getBcContext } from '@/lib/bcClient';
import { DFORCE_COMPANY } from '@/lib/dforce';
import { dateFromFileName, parseMailfinishExcel, suggestOrders } from '@/lib/mailfinish';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Informe de Mailfinish (Excel) → Assembly Orders sugeridas (solo lectura en BC). Multipart: excel y, opcional, date
// (YYYY-MM-DD; por defecto la del nombre del fichero) = fecha del stock de revistas y de registro de las órdenes, y
// outputs (JSON { código del informe: artículo de BC }) con los artículos cambiados en la página.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('excel');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Sube el Excel de Mailfinish.' }, { status: 400 });
    const date = String(form.get('date') || '') || dateFromFileName(file.name);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'El nombre del fichero no lleva la fecha (p. ej. 20260929): indícala.' }, { status: 400 });
    const gadgets = parseMailfinishExcel(await file.arrayBuffer());
    if (!gadgets.length) return NextResponse.json({ error: 'El Excel no tiene gadgets con cantidades en I. Wahl ni II. Wahl.' }, { status: 422 });
    const ctx = await getBcContext(DFORCE_COMPANY);
    const outputs = JSON.parse(String(form.get('outputs') || '{}')) as Record<string, string>;
    const result = await suggestOrders(ctx, gadgets, date, outputs);
    return NextResponse.json({ file: file.name, date, gadgets, ...result });
  } catch (error: any) {
    console.error('MAILFINISH process:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
