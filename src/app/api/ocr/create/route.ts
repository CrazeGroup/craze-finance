import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { createOcrInvoice, existingFor, learnVendor, type OcrCreateInput } from '@/lib/ocr';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);

// Crea en BC (sin registrar) la Purchase Invoice revisada en la página. Multipart: data = OcrCreateInput y pdf = la
// factura, que se adjunta. Guarda los identificadores del PDF con el proveedor para reconocerlo la próxima vez
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Select a specific company.' }, { status: 400 });
    const form = await req.formData();
    const body = JSON.parse(String(form.get('data') || '{}')) as OcrCreateInput;
    const pdfFile = form.get('pdf');
    const pdf = pdfFile instanceof File ? { name: pdfFile.name, data: new Uint8Array(await pdfFile.arrayBuffer()) } : undefined;
    if (!body.vendor || !body.invoiceNo?.trim()) return NextResponse.json({ error: 'The vendor or the invoice no. is missing.' }, { status: 400 });
    if (![body.invoiceDate, body.postingDate, body.dueDate].every(isDate)) return NextResponse.json({ error: 'Invalid date.' }, { status: 400 });
    if (!Array.isArray(body.lines) || !body.lines.length) return NextResponse.json({ error: 'The invoice has no lines.' }, { status: 400 });
    const missing = body.lines.find(l => l.lineType !== 'Comment' && !l.number);
    if (missing) return NextResponse.json({ error: `The item/account no. is missing on line "${missing.description}".` }, { status: 400 });

    const ctx = await getBcContext(company);
    const invoiceNo = body.invoiceNo.trim();
    const existing = await existingFor(ctx, body.vendor, invoiceNo);
    if (existing.length && !body.force) return NextResponse.json({ error: `Already exists in BC: ${existing.map(e => e.no).join(', ')}`, existing }, { status: 409 });

    const result = await createOcrInvoice(ctx, { ...body, invoiceNo }, pdf);
    await learnVendor(ctx.companyName, body.ids || [], body.vendor).catch(() => {});
    await logAction('OCR: purchase invoice created in BC', `${result.no} · vendor ${body.vendor}, invoice ${invoiceNo} · ${result.net ?? ''} ${result.currency}${body.force ? ' (already existed)' : ''}`);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('OCR create:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
