import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { logisticYear, INV_COLS } from '@/lib/logisticCost';

// Customer Margin (/customer-margin, CRAZE GmbH): margen por Customer Group Code de todas las facturas y abonos de venta.
//   Margen = venta − coste del producto − coste logístico − Skonto − Conditions out of invoice − Bonus − Marketing fee
//            − Accounting Partner (Markant)
// - Venta, coste y condiciones: página 60000 "Documents LM Components" (OData Documents_LM_Components_Excel), línea a
//   línea, sin las filas Main Item (sus componentes ya llevan el importe): Line_Amount_LCY, Total_Product_Cost y las
//   provisiones que BC calcula con el % de Conditions_CRZ del grupo y la fecha (Provision_Skonto, Provision_Conditions,
//   Provision_Bonus, Provision_Marketing, Provision_Accounting_Partner). Los abonos van en negativo.
// - Coste logístico: Total Charges de cada factura según Logistic Cost (src/lib/logisticCost.ts).
// - Customer Group = Customer_Group_Code de la línea.

export const FIRST_YEAR = 2024;
const SERVICE = 'Documents_LM_Components_Excel';
const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => Number(v) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().substring(0, 10);

// Columnas de cada documento
export const DOC_COLS = ['sales', 'cost', 'logistic', 'skonto', 'conditions', 'bonus', 'marketing', 'partner', 'qty'] as const;
export type MarginYear = {
  year: number; from: string; to: string; computedAt: string;
  groups: Record<string, string>;
  customers: Record<string, string>;            // nº → nombre
  // [nº documento, 0 factura | 1 abono, fecha, nº cliente, grupo, ...DOC_COLS]
  docs: (string | number)[][];
};

export async function marginYear(ctx: BcContext, company: string, year: number, force = false): Promise<MarginYear> {
  const today = new Date().toISOString().substring(0, 10);
  const closed = `${year}-12-31` < today;
  return cached(`customerMargin1:${company}:${year}`, closed ? 7 * 24 * HOUR : 24 * HOUR, () => compute(ctx, company, year, today), force,
    { refreshAfterMs: closed ? 7 * 24 * HOUR : HOUR });
}

async function compute(ctx: BcContext, company: string, year: number, today: string): Promise<MarginYear> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31` < today ? `${year}-12-31` : today;
  const SELECT = 'Document_Type,Document_No,Posting_date,Sell_to_Customer_No,Sell_to_Customer_Name,Customer_Group_Code,Main_Item_CRZ,Quantity,'
    + 'Line_Amount_LCY,Total_Product_Cost,Provision_Skonto,Provision_Conditions,Provision_Bonus,Provision_Marketing,Provision_Accounting_Partner';
  // Por meses en paralelo (la página es grande)
  const parts: [string, string][] = [];
  for (let d = from; d <= to;) {
    const [y, m] = d.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().substring(0, 10);
    parts.push([d, end < to ? end : to]);
    d = addDays(end, 1);
  }
  const [chunks, groups, logistic] = await Promise.all([
    Promise.all(parts.map(([a, b]) => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/${SERVICE}`, {
      $filter: `Posting_date ge ${a} and Posting_date le ${b}`, $select: SELECT,
    }), ctx.token, 180_000))),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/customerGroups`, { $select: 'code,description' }), ctx.token).catch(() => [] as any[]),
    logisticYear(ctx, company, year).catch(() => null),
  ]);

  const docs = new Map<string, (string | number)[]>();
  const customers: Record<string, string> = {};
  const I = (k: typeof DOC_COLS[number]) => 5 + DOC_COLS.indexOf(k);
  for (const r of chunks.flat()) {
    if (r.Main_Item_CRZ === true) continue;
    const type = s(r.Document_Type);
    if (!/invoice|credit/i.test(type)) continue;
    const no = s(r.Document_No);
    let d = docs.get(no);
    if (!d) {
      d = [no, /credit/i.test(type) ? 1 : 0, s(r.Posting_date).substring(0, 10), s(r.Sell_to_Customer_No), s(r.Customer_Group_Code), ...DOC_COLS.map(() => 0)];
      docs.set(no, d);
    }
    if (!d[4] && s(r.Customer_Group_Code)) d[4] = s(r.Customer_Group_Code);
    if (!d[3] && s(r.Sell_to_Customer_No)) d[3] = s(r.Sell_to_Customer_No);
    if (s(r.Sell_to_Customer_No) && !customers[s(r.Sell_to_Customer_No)]) customers[s(r.Sell_to_Customer_No)] = s(r.Sell_to_Customer_Name);
    (d[I('sales')] as number) += n(r.Line_Amount_LCY);
    (d[I('cost')] as number) += n(r.Total_Product_Cost);
    (d[I('skonto')] as number) += n(r.Provision_Skonto);
    (d[I('conditions')] as number) += n(r.Provision_Conditions);
    (d[I('bonus')] as number) += n(r.Provision_Bonus);
    (d[I('marketing')] as number) += n(r.Provision_Marketing);
    (d[I('partner')] as number) += n(r.Provision_Accounting_Partner);
    (d[I('qty')] as number) += n(r.Quantity);
  }
  // Coste logístico de cada factura
  if (logistic) {
    const tc = 3 + INV_COLS.indexOf('totalCharges');
    for (const inv of logistic.invoices) {
      const d = docs.get(String(inv[0]));
      if (d) (d[I('logistic')] as number) += Number(inv[tc]) || 0;
    }
  }
  const out = [...docs.values()].map(d => d.map((v, i) => (i >= 5 ? r2(v as number) : v)))
    .sort((a, b) => String(a[2]).localeCompare(String(b[2])) || String(a[0]).localeCompare(String(b[0])));
  return {
    year, from, to, computedAt: new Date().toISOString(),
    groups: Object.fromEntries(groups.map((x: any) => [s(x.code), s(x.description)])), customers, docs: out,
  };
}
