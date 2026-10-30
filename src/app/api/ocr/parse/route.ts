import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { processPdf } from '@/lib/ocr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Lee una factura de proveedor (multipart "file", un PDF por llamada) y propone la Purchase Invoice.
// "vendor" opcional: proveedor elegido a mano en la página (vuelve a proponer las líneas con sus facturas)
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Sube un PDF.' }, { status: 400 });
    const ctx = await getBcContext(company);
    const result = await processPdf(ctx, file.name, new Uint8Array(await file.arrayBuffer()), String(form.get('vendor') || '') || undefined);
    return NextResponse.json({ company: ctx.companyName, ...result });
  } catch (error: any) {
    console.error('OCR parse:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
