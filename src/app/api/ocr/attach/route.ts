import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { attachFile } from '@/lib/bcWrite';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Adjunta un fichero más (multipart "file", uno por llamada) a una Purchase Invoice creada desde OCR ("id" = SystemId)
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const form = await req.formData();
    const id = String(form.get('id') || '');
    const file = form.get('file');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !(file instanceof File)) return NextResponse.json({ error: 'Faltan la factura o el fichero.' }, { status: 400 });
    const ctx = await getBcContext(company);
    await attachFile(ctx, id, { name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('OCR attach:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
