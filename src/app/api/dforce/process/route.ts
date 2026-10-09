import { NextResponse } from 'next/server';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { buildDocuments, CUSTOMER_NO, DFORCE_COMPANY, LOCATION, parseExcel, parsePdf, VENDOR_NO } from '@/lib/dforce';
import { logAction } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Convierte la Gutschrift de D-FORCE (PDF + Excel de Curasoft) en las líneas de Sales Invoice, Sales Credit Memo
// y Purchase Invoice de Craze Entertainment. POST multipart: pdf, excel.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const pdfFile = form.get('pdf');
    const excelFile = form.get('excel');
    if (!(pdfFile instanceof File) || !(excelFile instanceof File)) {
      return NextResponse.json({ error: 'Sube el PDF y el Excel de D-FORCE.' }, { status: 400 });
    }
    const pdf = await parsePdf(new Uint8Array(await pdfFile.arrayBuffer()));
    if (!pdf.lines.length) return NextResponse.json({ error: 'No se han encontrado líneas de venta en el PDF (anexos LI, LA, LDI, LDA, RI, RA).' }, { status: 422 });
    const excel = parseExcel(await excelFile.arrayBuffer());
    const docs = buildDocuments(pdf, excel);

    // Descripción y coste unitario de cada artículo de revista, de BC (Craze Entertainment)
    const items = Array.from(new Set([...docs.invoice, ...docs.credit].map(l => l.no)));
    try {
      const ctx = await getBcContext(DFORCE_COMPANY);
      const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/items`, {
        $filter: items.map(n => `number eq '${n.replace(/'/g, "''")}'`).join(' or '),
        $select: 'number,displayName,unitCost',
      }), ctx.token);
      const byNo = new Map(rows.map((r: any) => [String(r.number), r]));
      for (const l of [...docs.invoice, ...docs.credit]) {
        const it: any = byNo.get(l.no);
        if (it) { l.description = it.displayName || ''; l.unitCost = typeof it.unitCost === 'number' ? it.unitCost : null; }
      }
      const missing = items.filter(n => !byNo.has(n));
      if (missing.length) docs.warnings.push(`Artículos que no existen en BC (créalos antes de importar): ${missing.join(', ')}.`);
    } catch (e: any) {
      console.error('D-FORCE items:', e);
      const reason = String(e.message || e).split('\n').map((x: string) => x.trim()).filter(Boolean).pop();
      docs.warnings.push(`No se han podido leer los artículos de BC (descripción y coste unitario quedan vacíos; BC los rellena al importar): ${reason}`);
    }

    await logAction('D-FORCE: Gutschrift procesada', `${docs.creditNo} · ${pdfFile.name} + ${excelFile.name}`, DFORCE_COMPANY);
    return NextResponse.json({ ...docs, customerNo: CUSTOMER_NO, vendorNo: VENDOR_NO, location: LOCATION, files: { pdf: pdfFile.name, excel: excelFile.name } });
  } catch (error: any) {
    console.error('Error in D-FORCE:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
