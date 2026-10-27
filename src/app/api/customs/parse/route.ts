import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { customsConfig, existingInvoices, parseCustomsPdf } from '@/lib/customs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Lee uno o varios Einfuhrabgabenbescheide (multipart "files") y busca en BC si sus facturas ya existen
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const files = (await req.formData()).getAll('files').filter((f): f is File => f instanceof File);
    if (!files.length) return NextResponse.json({ error: 'Sube al menos un PDF de aduanas.' }, { status: 400 });

    const [ctx, cfg] = await Promise.all([getBcContext(company), customsConfig()]);
    const docs = await Promise.all(files.map(async f => {
      try {
        const doc = await parseCustomsPdf(f.name, new Uint8Array(await f.arrayBuffer()));
        const existing = doc.atc ? await existingInvoices(ctx, doc.atc, cfg) : [];
        return { ...doc, existing };
      } catch (e: any) {
        return { file: f.name, error: `No se ha podido leer el PDF: ${e.message}` };
      }
    }));
    return NextResponse.json({ company: ctx.companyName, config: cfg, docs });
  } catch (error: any) {
    console.error('Aduanas parse:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
