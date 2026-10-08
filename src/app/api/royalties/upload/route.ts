import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { saveUpload, StoredUpload } from '@/lib/royalties';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Guarda las líneas del Excel "Documents LM Components" (ya leídas en el navegador) de la empresa seleccionada
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });

    const body = await req.json() as StoredUpload;
    if (!Array.isArray(body.lines) || !body.lines.length || typeof body.desc !== 'object') {
      return NextResponse.json({ error: 'El fichero no contiene líneas válidas' }, { status: 400 });
    }
    const upload: StoredUpload = {
      fileName: String(body.fileName || ''), uploadedAt: new Date().toISOString(),
      from: String(body.from || ''), to: String(body.to || ''), desc: body.desc, lines: body.lines,
    };
    await saveUpload(company, upload);
    await logAction('Royalties: Excel LM cargado', `${upload.fileName} · ${upload.lines.length} líneas · ${upload.from} – ${upload.to}`);
    return NextResponse.json({ ok: true, lines: upload.lines.length });
  } catch (error: any) {
    console.error('Error uploading royalties Excel:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
