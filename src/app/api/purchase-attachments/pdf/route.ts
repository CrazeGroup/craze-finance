import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext, odataUrl } from '@/lib/bcClient';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Abre el adjunto (Attachments de BC, v2 documentAttachments) de una factura o abono registrado, para los enlaces de
// los desgloses de Controlling. ?no=<Document No.>&type=purchInv|purchCrMemo|salesInv|salesCrMemo[&company=][&id=<adjunto>]
// Con un solo adjunto lo devuelve directamente (el navegador muestra el PDF); con varios, una lista para elegir.
const TYPES: Record<string, { entity: string; parentType: string; label: string }> = {
  purchInv: { entity: 'purchaseInvoices', parentType: 'Purchase Invoice', label: 'factura de compra' },
  purchCrMemo: { entity: 'purchaseCreditMemos', parentType: 'Purchase Credit Memo', label: 'abono de compra' },
  salesInv: { entity: 'salesInvoices', parentType: 'Sales Invoice', label: 'factura de venta' },
  salesCrMemo: { entity: 'salesCreditMemos', parentType: 'Sales Credit Memo', label: 'abono de venta' },
};
const q = (s: string) => s.replace(/'/g, "''");
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const page = (title: string, body: string, status = 200) => new NextResponse(
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;padding:32px;color:#111"><h2 style="font-size:18px">${esc(title)}</h2>${body}</body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const no = (searchParams.get('no') || '').trim();
  const type = TYPES[searchParams.get('type') || 'purchInv'];
  if (!no || !type) return page('Falta el nº de documento o el tipo', '', 400);
  try {
    const company = searchParams.get('company') || (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const ctx = await getBcContext(company === 'ALL' ? 'CRAZE' : company);
    const get = async (url: string) => {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error(`BC ${res.status}: ${(await res.text()).substring(0, 300)}`);
      return res.json();
    };

    const docs = (await get(odataUrl(`${ctx.apiBase}/${type.entity}`, { $filter: `number eq '${q(no)}'`, $select: 'id,number' }))).value || [];
    if (!docs.length) return page(`No se encuentra la ${type.label} ${no} en ${ctx.companyName}`, '', 404);
    const atts: any[] = (await get(odataUrl(`${ctx.apiBase}/documentAttachments`, {
      $filter: `parentType eq '${type.parentType}' and parentId eq ${docs[0].id}`, $select: 'id,fileName,lastModifiedDateTime',
    }))).value || [];
    if (!atts.length) return page(`La ${type.label} ${no} no tiene documentos adjuntos en BC`, `<p>${esc(ctx.companyName)}</p>`, 404);

    const id = searchParams.get('id');
    const att = id ? atts.find(a => a.id === id) : atts.length === 1 ? atts[0] : null;
    if (!att) {
      const link = (a: any) => {
        const p = new URLSearchParams(searchParams); p.set('id', a.id);
        return `<li style="margin:6px 0"><a href="?${esc(p.toString())}">${esc(a.fileName || a.id)}</a></li>`;
      };
      return page(`${no}: ${atts.length} adjuntos`, `<ul>${atts.map(link).join('')}</ul>`);
    }

    const res = await fetch(`${ctx.apiBase}/documentAttachments(${att.id})/attachmentContent`, { headers: { Authorization: `Bearer ${ctx.token}` }, cache: 'no-store' });
    if (!res.ok) throw new Error(`BC ${res.status}: ${(await res.text()).substring(0, 300)}`);
    const fileName = String(att.fileName || `${no}.pdf`);
    const contentType = /\.pdf$/i.test(fileName) ? 'application/pdf'
      : /\.png$/i.test(fileName) ? 'image/png' : /\.jpe?g$/i.test(fileName) ? 'image/jpeg' : 'application/octet-stream';
    return new NextResponse(await res.arrayBuffer(), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'private, max-age=600',
      },
    });
  } catch (error: any) {
    return page('No se ha podido leer el adjunto de BC', `<pre style="white-space:pre-wrap">${esc(error.message)}</pre>`, 500);
  }
}
