import prisma from '@/lib/prisma';
import { bcFetchAll, getBcContext, odataUrl, BcContext } from '@/lib/bcClient';
import { readSetting } from '@/lib/reporting/cache';

// Sales Return Orders (SRO): todas las abiertas de BC (API custom salesHeaders, documentType Return Order) con
// Assigned User ID, Campaign No. y XML Status (campo AIT), más sus comentarios:
// - BC: Sales Comment Line (tabla 44, "Comments" de la SRO). No está en la API estándar: se lee de la API custom
//   (entidad salesCommentLines, o la de la setting salesCommentEntity) o de un servicio OData cuyo nombre case con
//   /sales.?comment/i. Si BC no la publica, el informe lo avisa (commentsError) y sigue con los de la app.
// - App: CashflowComment con clave "sro:<no>" (añadidos desde este informe).

export type SroComment = { source: 'bc' | 'app'; id?: number; date: string; text: string; author: string; lineNo?: number };
export type SalesReturn = {
  company: string; no: string; customerNo: string; customerName: string; externalDocumentNo: string;
  documentDate: string; postingDate: string; orderDate: string; status: string;
  assignedUserId: string; campaignNo: string; salespersonCode: string; typeOfReturn: string; xmlStatus: string;
  amount: number; amountInclVat: number; currency: string; comments: SroComment[];
};

const s = (v: any) => (v == null ? '' : String(v).trim());
const pick = (r: any, ...keys: string[]) => { for (const k of keys) if (r[k] != null && r[k] !== '') return r[k]; return ''; };
// BC devuelve los enum vacíos como "_x0020_"
const enumText = (v: any) => s(v).replace(/_x0020_/g, ' ').trim();
const dateOnly = (v: any) => { const d = s(v).slice(0, 10); return d.startsWith('0001') ? '' : d; };

const SELECT = 'no,sellToCustomerNo,sellToCustomerName,externalDocumentNo,documentDate,postingDate,orderDate,status,assignedUserID,campaignNo,salespersonCode,aitTypeOfReturn,aitXMLStatus,amount,amountIncludingVAT,currencyCode';

async function headers(ctx: BcContext): Promise<Omit<SalesReturn, 'company' | 'comments'>[]> {
  const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/salesHeaders`, {
    $filter: "documentType eq 'Return Order'", $select: SELECT,
  }), ctx.token);
  return rows.map(r => ({
    no: s(r.no), customerNo: s(r.sellToCustomerNo), customerName: s(r.sellToCustomerName), externalDocumentNo: s(r.externalDocumentNo),
    documentDate: dateOnly(r.documentDate), postingDate: dateOnly(r.postingDate), orderDate: dateOnly(r.orderDate), status: enumText(r.status),
    assignedUserId: s(r.assignedUserID), campaignNo: s(r.campaignNo), salespersonCode: s(r.salespersonCode),
    typeOfReturn: s(r.aitTypeOfReturn), xmlStatus: enumText(r.aitXMLStatus),
    amount: Number(r.amount) || 0, amountInclVat: Number(r.amountIncludingVAT) || 0, currency: s(r.currencyCode),
  }));
}

// Comentarios de BC de las Return Orders: Map no → comentarios. Lanza un error legible si BC no los publica.
async function bcComments(ctx: BcContext): Promise<Map<string, SroComment[]>> {
  const entity = await readSetting('salesCommentEntity', 'salesCommentLines');
  let rows: any[] | null = null;
  try {
    rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/${entity}`, {}), ctx.token);
  } catch (e: any) {
    if (!/404|not found|ResourceNotFound|No HTTP resource/i.test(e.message || '')) throw e;
  }
  if (!rows) {
    // Servicio OData publicado a mano (p. ej. página 67 "Sales Comment Sheet")
    const list = await fetch(`${ctx.odataCompanyBase.replace(/\/Company\(.*$/, '')}`, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : { value: [] })).catch(() => ({ value: [] }));
    const service = (list.value || []).map((x: any) => x.name || x.url).find((n: string) => /sales.?comment/i.test(n || ''));
    if (!service) throw new Error('BC does not publish the Sales Comment Lines (table 44) yet: ask to publish them in the custom API as "salesCommentLines".');
    rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/${encodeURIComponent(service)}`, {}), ctx.token);
  }
  const out = new Map<string, SroComment[]>();
  for (const r of rows) {
    const type = enumText(pick(r, 'documentType', 'Document_Type'));
    if (type && !/return/i.test(type)) continue;
    const no = s(pick(r, 'no', 'documentNo', 'No'));
    const text = s(pick(r, 'comment', 'Comment'));
    if (!no || !text) continue;
    const created = s(pick(r, 'systemCreatedAt', 'SystemCreatedAt'));
    const date = dateOnly(pick(r, 'date', 'Date')) || created.slice(0, 10);
    const list = out.get(no) || [];
    list.push({ source: 'bc', date: created && created.slice(0, 10) === date ? created : date, text, author: s(pick(r, 'systemCreatedBy', 'userId', 'code', 'Code')), lineNo: Number(pick(r, 'lineNo', 'Line_No')) || undefined });
    out.set(no, list);
  }
  return out;
}

export async function salesReturns(company: string): Promise<{ rows: SalesReturn[]; commentsError: string | null }> {
  const ctx = await getBcContext(company);
  const [heads, bc, app] = await Promise.all([
    headers(ctx),
    bcComments(ctx).then(m => ({ m, error: null as string | null })).catch((e: any) => ({ m: new Map<string, SroComment[]>(), error: String(e.message || e) })),
    prisma.cashflowComment.findMany({ where: { companyId: company, targetKey: { startsWith: 'sro:' } }, orderBy: { createdAt: 'asc' } }),
  ]);
  const appBy = new Map<string, SroComment[]>();
  for (const c of app) {
    const no = c.targetKey.slice(4);
    appBy.set(no, [...(appBy.get(no) || []), { source: 'app', id: c.id, date: c.createdAt.toISOString(), text: c.text, author: c.author || '' }]);
  }
  const rows = heads.map(h => ({
    ...h, company,
    comments: [...(bc.m.get(h.no) || []), ...(appBy.get(h.no) || [])].sort((a, b) => a.date.localeCompare(b.date)),
  }));
  return { rows, commentsError: bc.error };
}
