import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDocumentProxy, extractText } from 'unpdf';
import { getBcContext, bcFetchAll, odataUrl } from '@/lib/bcClient';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Muestras de facturas de compra registradas de un proveedor con su PDF adjunto (texto extraído), cabecera y líneas,
// para ver cómo se contabiliza cada tipo de factura (base para ampliar el OCR). Solo lectura.
// ?vendor=<nº o parte del nombre>&top=3[&company=]
const q = (s: string) => s.replace(/'/g, "''");

export async function GET(req: Request) {
  if (!(await getSession())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const { searchParams } = new URL(req.url);
    const vendor = (searchParams.get('vendor') || '').trim();
    if (!vendor) return NextResponse.json({ error: 'Falta ?vendor=' }, { status: 400 });
    const top = Math.min(Number(searchParams.get('top')) || 3, 10);
    const company = searchParams.get('company') || (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const ctx = await getBcContext(company === 'ALL' ? 'CRAZE' : company);
    const get = async (url: string) => {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`BC ${res.status}: ${(await res.text()).substring(0, 300)}`);
      return res.json();
    };

    // BC no admite 'or' entre campos distintos: primero por nº, luego por nombre
    const findVendors = (filter: string) => bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, { $filter: filter, $select: 'id,number,displayName' }), ctx.token);
    let vendors = await findVendors(`number eq '${q(vendor)}'`);
    if (!vendors.length) vendors = await findVendors(`contains(displayName,'${q(vendor)}')`);
    if (vendors.length !== 1) return NextResponse.json({ company: ctx.companyName, error: vendors.length ? 'Varios proveedores, indica el nº' : 'Proveedor no encontrado', vendors });
    const v = vendors[0];

    const invoices = (await get(odataUrl(`${ctx.apiBase}/purchaseInvoices`, {
      $filter: `vendorNumber eq '${q(v.number)}' and status ne 'Draft'`, $orderby: 'postingDate desc', $top: String(top),
    }))).value || [];

    const docs = await Promise.all(invoices.map(async (inv: any) => {
      const [lines, posted, atts] = await Promise.all([
        get(`${ctx.apiBase}/purchaseInvoices(${inv.id})/purchaseInvoiceLines`).then(d => d.value).catch(e => e.message),
        bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Posted_Purchase_Invoice_Excel`, { $filter: `No eq '${q(inv.number)}'` }), ctx.token)
          .then(r => r[0]).catch(e => e.message),
        get(odataUrl(`${ctx.apiBase}/documentAttachments`, {
          $filter: `parentType eq 'Purchase Invoice' and parentId eq ${inv.id}`, $select: 'id,fileName,lastModifiedDateTime',
        })).then(d => d.value).catch(e => e.message),
      ]);
      const attachments = Array.isArray(atts) ? await Promise.all(atts.map(async (a: any) => {
        try {
          const res = await fetch(`${ctx.apiBase}/documentAttachments(${a.id})/attachmentContent`, { headers: { Authorization: `Bearer ${ctx.token}` } });
          if (!res.ok) return { ...a, error: `HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` };
          const data = new Uint8Array(await res.arrayBuffer());
          if (!/\.pdf$/i.test(a.fileName)) return { ...a, bytes: data.length };
          const { text } = await extractText(await getDocumentProxy(data), { mergePages: true });
          return { ...a, bytes: data.length, text: String(text).replace(/[ \t]+/g, ' ').substring(0, 20000) };
        } catch (e: any) {
          return { ...a, error: e.message };
        }
      })) : atts;
      return { invoice: inv, posted, lines, attachments };
    }));

    return NextResponse.json({ company: ctx.companyName, vendor: v, docs });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
