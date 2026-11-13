import { bcFetchAll, BcContext, getBcContext, odataUrl } from '@/lib/bcClient';
import { bcRequest } from '@/lib/bcWrite';
import { setLineExtras, type Extras } from '@/lib/dforceBc';

// Refacturación intercompany (CRAZE GmbH → CRAZE Entertainment): por cada factura de venta de GmbH refacturada, en
// Entertainment (sin registrar):
//  - Purchase Credit Memo espejo del abono de GmbH (Vendor Cr. Memo No. = nº del abono registrado en GmbH), liquidado
//    contra la factura de compra vigente de la factura original si sigue abierta;
//  - Purchase Invoice espejo de la factura nueva de GmbH (Vendor Invoice No. = su nº registrado).
// Las líneas siguen la factura de compra que ya había en Entertainment: el foilbag de GmbH se sube como AA-00049
// (cantidad 1 por el importe de la línea), el resto con su artículo; almacén, IVA, Project No. y Project Task No. de la
// línea equivalente de esa factura de compra. Fechas de registro y documento = las del documento de GmbH.

const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => Number(v) || 0;
const q = (v: string) => v.replace(/'/g, "''");
export const FOILBAG_ITEM = 'AA-00049';
const isFoilbag = (l: any) => /foil\s*bag/i.test(s(l.description));

export type IcInput = { purchaseInvoice: string; gmbhCreditMemo: string; gmbhInvoice: string };
type PlanLine = { no: string; description: string; qty: number; unitCost: number; amount: number; locationCode: string; taxCode: string; project: string; task: string; uom: string };
export type IcPlan = {
  purchaseInvoice: string; vendor: string; status: string; applyTo: boolean;
  creditMemo: { vendorCrMemoNo: string; postingDate: string; documentDate: string; lines: PlanLine[]; total: number; existing?: string };
  invoice: { vendorInvoiceNo: string; postingDate: string; documentDate: string; lines: PlanLine[]; total: number; existing?: string };
  issues: string[];
};

async function gmbhDoc(gm: BcContext, kind: 'cm' | 'inv', no: string) {
  const [h] = await bcFetchAll(odataUrl(`${gm.apiBase}/${kind === 'cm' ? 'salesCreditMemos' : 'salesInvoices'}`, { $filter: `number eq '${q(no)}'` }), gm.token);
  if (!h) throw new Error(`No existe ${no} en CRAZE GmbH`);
  const lines = await bcFetchAll(odataUrl(`${gm.customApiBase}/${kind === 'cm' ? 'salesCrMemoLines' : 'salesInvoiceLines'}`, { $filter: `documentNo eq '${q(no)}'` }), gm.token);
  return {
    postingDate: s(h.postingDate).substring(0, 10), documentDate: s(kind === 'cm' ? h.creditMemoDate : h.invoiceDate).substring(0, 10),
    lines: lines.filter((l: any) => s(l.type) === 'Item' && n(l.quantity)).sort((a: any, b: any) => n(a.lineNo) - n(b.lineNo)),
  };
}

export async function planIc(ce: BcContext, gm: BcContext, input: IcInput): Promise<IcPlan> {
  const issues: string[] = [];
  const [pi] = await bcFetchAll(odataUrl(`${ce.apiBase}/purchaseInvoices`, { $filter: `number eq '${q(input.purchaseInvoice)}'` }), ce.token);
  if (!pi) throw new Error(`No existe ${input.purchaseInvoice} en CRAZE Entertainment`);
  const tpl = (await bcFetchAll(odataUrl(`${ce.customApiBase}/purchInvLines`, { $filter: `documentNo eq '${q(input.purchaseInvoice)}'` }), ce.token))
    .filter((l: any) => s(l.type) === 'Item').sort((a: any, b: any) => n(a.lineNo) - n(b.lineNo));
  for (const t of tpl) if (!s(t.jobNo) || !s(t.jobTaskNo)) issues.push(`${input.purchaseInvoice} ${s(t.no)}: sin Project No. o Project Task No.`);
  const [cm, inv] = await Promise.all([gmbhDoc(gm, 'cm', input.gmbhCreditMemo), gmbhDoc(gm, 'inv', input.gmbhInvoice)]);
  const build = (lines: any[], doc: string): PlanLine[] => lines.map(l => {
    const foil = isFoilbag(l);
    const t = tpl.find((x: any) => (foil ? s(x.no) === FOILBAG_ITEM : s(x.no) === s(l.no)));
    if (!t) issues.push(`${doc} ${s(l.no)}: no hay línea equivalente en ${input.purchaseInvoice}`);
    const amount = n(l.amount);
    return {
      no: foil ? FOILBAG_ITEM : s(l.no), description: s(t?.description) || s(l.description), qty: foil ? 1 : n(l.quantity),
      unitCost: foil ? amount : n(l.unitPrice) * (1 - n(l.lineDiscount) / 100), amount,
      locationCode: s(t?.locationCode), taxCode: s(t?.vatProdPostingGroup), project: s(t?.jobNo), task: s(t?.jobTaskNo), uom: foil ? '' : s(t?.unitOfMeasureCode),
    };
  });
  const [exCm, exInv] = await Promise.all([
    bcFetchAll(odataUrl(`${ce.apiBase}/purchaseCreditMemos`, { $filter: `vendorCreditMemoNumber eq '${q(input.gmbhCreditMemo)}'`, $select: 'number' }), ce.token),
    bcFetchAll(odataUrl(`${ce.apiBase}/purchaseInvoices`, { $filter: `vendorInvoiceNumber eq '${q(input.gmbhInvoice)}'`, $select: 'number' }), ce.token),
  ]);
  const cmLines = build(cm.lines, input.gmbhCreditMemo), invLines = build(inv.lines, input.gmbhInvoice);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    purchaseInvoice: input.purchaseInvoice, vendor: s(pi.vendorNumber), status: s(pi.status), applyTo: s(pi.status) === 'Open',
    creditMemo: { vendorCrMemoNo: input.gmbhCreditMemo, postingDate: cm.postingDate, documentDate: cm.documentDate, lines: cmLines, total: r2(cmLines.reduce((t, l) => t + l.amount, 0)), existing: s(exCm[0]?.number) || undefined },
    invoice: { vendorInvoiceNo: input.gmbhInvoice, postingDate: inv.postingDate, documentDate: inv.documentDate, lines: invLines, total: r2(invLines.reduce((t, l) => t + l.amount, 0)), existing: s(exInv[0]?.number) || undefined },
    issues,
  };
}

async function createDoc(ce: BcContext, kind: 'cm' | 'inv', plan: IcPlan, piId: string) {
  const d = kind === 'cm' ? plan.creditMemo : plan.invoice;
  const entity = kind === 'cm' ? 'purchaseCreditMemos' : 'purchaseInvoices';
  const linesEntity = kind === 'cm' ? 'purchaseCreditMemoLines' : 'purchaseInvoiceLines';
  const head = await bcRequest('POST', `${ce.apiBase}/${entity}`, ce.token, kind === 'cm'
    ? { vendorNumber: plan.vendor, vendorCreditMemoNumber: (d as any).vendorCrMemoNo, creditMemoDate: d.documentDate, postingDate: d.postingDate, ...(plan.applyTo ? { invoiceId: piId } : {}) }
    : { vendorNumber: plan.vendor, vendorInvoiceNumber: (d as any).vendorInvoiceNo, invoiceDate: d.documentDate, postingDate: d.postingDate });
  const base = `${ce.apiBase}/${entity}(${head.id})`;
  const warnings: string[] = [];
  try {
    const auto = await bcRequest('GET', `${base}/${linesEntity}?$select=id`, ce.token);
    for (const l of auto?.value || []) await bcRequest('DELETE', `${base}/${linesEntity}(${l.id})`, ce.token);
    const locs = await bcFetchAll(odataUrl(`${ce.apiBase}/locations`, { $select: 'id,code' }), ce.token);
    const extras = new Map<number, Extras>();
    for (const l of d.lines) {
      const locationId = l.locationCode ? s(locs.find((x: any) => s(x.code) === l.locationCode)?.id) : '';
      const created = await bcRequest('POST', `${base}/${linesEntity}`, ce.token, {
        lineType: 'Item', lineObjectNumber: l.no, quantity: l.qty, unitCost: l.unitCost, description: l.description.substring(0, 100),
        ...(l.taxCode ? { taxCode: l.taxCode } : {}), ...(locationId ? { locationId } : {}),
      });
      if (l.project) extras.set(Number(created.sequence), { project: l.project, task: l.task });
    }
    warnings.push(...await setLineExtras(ce, 'purchase', s(head.number), extras));
  } catch (e) {
    await bcRequest('DELETE', base, ce.token).catch(() => {});
    throw e;
  }
  const after = await bcRequest('GET', base, ce.token);
  return { no: s(head.number), total: n(after?.totalAmountExcludingTax), warnings };
}

export async function runIc(input: IcInput, dryRun: boolean) {
  const [ce, gm] = await Promise.all([getBcContext('Craze Entertainment'), getBcContext('CRAZE')]);
  const plan = await planIc(ce, gm, input);
  if (dryRun) return { plan };
  if (plan.issues.length) throw new Error(`No se crea nada para ${input.purchaseInvoice}: ${plan.issues.join(' · ')}`);
  const [pi] = await bcFetchAll(odataUrl(`${ce.apiBase}/purchaseInvoices`, { $filter: `number eq '${q(input.purchaseInvoice)}'`, $select: 'id' }), ce.token);
  const out: { creditMemo?: any; invoice?: any } = {};
  out.creditMemo = plan.creditMemo.existing ? { no: plan.creditMemo.existing, existing: true } : await createDoc(ce, 'cm', plan, pi.id);
  out.invoice = plan.invoice.existing ? { no: plan.invoice.existing, existing: true } : await createDoc(ce, 'inv', plan, pi.id);
  return { plan, ...out };
}
