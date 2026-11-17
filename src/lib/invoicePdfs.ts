import prisma from './prisma';
import { getBcContext, bcFetchAll, odataUrl } from './bcClient';

// PDF impreso por BC de las facturas / abonos de venta (v2 salesInvoices|salesCreditMemos → pdfDocument), para
// adjuntarlos al recordatorio. Las que no tienen documento en BC (p. ej. las migradas con "*") se devuelven en missing.
export async function salesDocumentPdfs(invoiceIds: number[]) {
  const invoices = await prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { bcId: true, companyId: true, type: true } });
  const files: { filename: string; content: Buffer; contentType: string }[] = [];
  const missing: string[] = [];
  const byCompany = new Map<string, typeof invoices>();
  for (const inv of invoices) byCompany.set(inv.companyId, [...(byCompany.get(inv.companyId) || []), inv]);
  for (const [company, list] of byCompany) {
    const ctx = await getBcContext(company);
    const one = async (inv: (typeof invoices)[number]) => {
      const no = String(inv.bcId || '');
      const entity = /credit/i.test(inv.type) ? 'salesCreditMemos' : 'salesInvoices';
      try {
        const [doc] = await bcFetchAll(odataUrl(`${ctx.apiBase}/${entity}`, { $filter: `number eq '${no.replace(/'/g, "''")}'`, $select: 'id,number' }), ctx.token);
        if (!doc) { missing.push(no); return; }
        const res = await fetch(`${ctx.apiBase}/${entity}(${doc.id})/pdfDocument/pdfDocumentContent`, { headers: { Authorization: `Bearer ${ctx.token}` } });
        const data = Buffer.from(await res.arrayBuffer());
        if (!res.ok || data.length < 500 || data.subarray(0, 4).toString() !== '%PDF') { missing.push(no); return; }
        files.push({ filename: `${no.replace(/[^\w.-]+/g, '_')}.pdf`, content: data, contentType: 'application/pdf' });
      } catch {
        missing.push(no);
      }
    };
    // BC genera cada PDF en unos segundos: de 4 en 4
    for (let i = 0; i < list.length; i += 4) await Promise.all(list.slice(i, i + 4).map(one));
  }
  return { files, missing };
}
