import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { saveRatesUpload, saveUpload, StoredUpload, RoyaltyRates } from '@/lib/royalties';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Guarda lo leído en el navegador de un Excel de BC: las líneas de "Documents LM Components" (por empresa)
// o, con kind = 'rates', los % de la página 80007 "Royalties" (comunes, de CRAZE GmbH)
export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (body.kind === 'rates') {
      const rates = body.rates as RoyaltyRates;
      if (!rates || typeof rates !== 'object' || !Object.keys(rates).length) {
        return NextResponse.json({ error: 'El fichero no contiene Royalty Codes' }, { status: 400 });
      }
      const fileName = String(body.fileName || '');
      await saveRatesUpload({ fileName, uploadedAt: new Date().toISOString(), rates });
      await logAction('Royalties: Excel de % de royalty cargado', `${fileName} · ${Object.keys(rates).length} Royalty Codes`);
      return NextResponse.json({ ok: true, codes: Object.keys(rates).length });
    }

    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });

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
