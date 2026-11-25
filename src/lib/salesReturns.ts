import prisma from '@/lib/prisma';
import { bcFetchAll, getBcContext, odataUrl, BcContext } from '@/lib/bcClient';
import { readSetting } from '@/lib/reporting/cache';

// Sales Return Orders (SRO): todas las abiertas de BC (API custom salesHeaders, documentType Return Order) con
// Assigned User ID, Campaign No. y XML Status (campo AIT), más sus comentarios:
// - BC: las Notes de la SRO (Record Links, API custom recordLinks, ver bcComments). Si BC no las publica, el informe
//   lo avisa (commentsError) y sigue con los de la app.
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

// Notes de BC de las Return Orders (FactBox "Notes" = Record Links de tipo Note, tabla 2000000068, texto en un BLOB):
// la misma entidad de la API custom que Notas de compra (recordLinks, setting purchaseNotesEntity). Record ID
// "Sales Header: Return Order,CRZ-RO26-00026". Map no → notas. Lanza un error legible si BC no la publica.
async function bcComments(ctx: BcContext): Promise<Map<string, SroComment[]>> {
  const entity = await readSetting('purchaseNotesEntity', 'recordLinks');
  let rows: any[];
  try {
    rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/${entity}`, { $filter: "tableNo eq 36" }), ctx.token);
  } catch (e: any) {
    if (/404|not found|ResourceNotFound|No HTTP resource/i.test(e.message || '')) {
      throw new Error(`BC does not publish the Notes (Record Links) yet: they must be published in the custom API as "${entity}".`);
    }
    throw e;
  }
  const out = new Map<string, SroComment[]>();
  for (const r of rows) {
    const type = enumText(pick(r, 'type', 'linkType'));
    if (type && !/note/i.test(type)) continue;
    const company = s(r.company);
    if (company && company.toLowerCase() !== ctx.companyName.toLowerCase()) continue;
    const m = s(pick(r, 'recordIdText', 'recordId', 'recordID')).match(/^sales header:\s*return order,\s*(.+)$/i);
    if (!m) continue;
    const text = s(pick(r, 'noteText', 'note', 'description'));
    if (!text) continue;
    const no = m[1].trim();
    out.set(no, [...(out.get(no) || []), { source: 'bc', date: s(pick(r, 'created', 'createdAt')), text, author: s(pick(r, 'userId', 'createdBy')) }]);
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
