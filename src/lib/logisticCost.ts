import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { byMonths } from '@/lib/amazonMargin';

// Logistic Cost (/logistic-cost, CRAZE GmbH): coste logístico de cada factura de venta, por Customer Group Code.
// - Costes: custom logisticCosts (una fila por envío del almacén M+F…): Freight Charges, Fuel Surcharge, Other Surcharges,
//   Timed Delivery, Total Costs (manipulación + flete) y Total Charges (todo), con palets, peso, piezas.
// - Enlace con la factura (como en Amazon): Order No. = nº de Warehouse Shipment → envíos registrados (OData shipments,
//   AITSCHVTA1_Whse_Shipment_No) → pedido (Posted_Sales_Shipment_Excel.Order_No) → primera factura de ese pedido con
//   fecha igual o posterior a la del envío (si no hay, la última). Si un envío lleva varios pedidos, se reparte por venta.
// - Venta: custom salesInvoiceLines (importe sin IVA en divisa local con el factor amountLCY / amount del movimiento de
//   cliente); unidades = cantidad de las líneas de artículo. Customer Group = Customer_Group_Code_CRZ del Sell-to.
// - Solo facturas con coste logístico (la base del % es su venta); la venta de todas las facturas va aparte por grupo.

export const FIRST_YEAR = 2024;
const LOOKBACK_DAYS = 92;
const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => Number(v) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().substring(0, 10);

// Columnas de cada factura
export const INV_COLS = ['sales', 'units', 'freight', 'fuel', 'other', 'timed', 'totalCosts', 'totalCharges', 'pallets', 'weight', 'pieces', 'shipments'] as const;
export type LogisticYear = {
  year: number; from: string; to: string; computedAt: string;
  groups: Record<string, string>;                 // código → descripción
  customers: Record<string, [string, string]>;    // nº → [nombre, grupo]
  // [nº factura, fecha, nº cliente, ...INV_COLS]
  invoices: (string | number)[][];
  salesAll: Record<string, number>;               // venta de todas las facturas del año por grupo
  unassigned: { amount: number; rows: number };    // envíos del año sin factura (pedido sin facturar o sin enlace)
};

export async function logisticYear(ctx: BcContext, company: string, year: number, force = false): Promise<LogisticYear> {
  const today = new Date().toISOString().substring(0, 10);
  const closed = `${year}-12-31` < today;
  return cached(`logisticCost1:${company}:${year}`, closed ? 7 * 24 * HOUR : 24 * HOUR, () => compute(ctx, year, today), force,
    { refreshAfterMs: closed ? 7 * 24 * HOUR : HOUR });
}

async function compute(ctx: BcContext, year: number, today: string): Promise<LogisticYear> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31` < today ? `${year}-12-31` : today;
  const early = addDays(from, -LOOKBACK_DAYS);
  const LOG = 'entryNo,orderNo,date,freightCharges,fuelSurcharge,otherSurcharges,timedDelivery,totalCosts,totalCharges,shippedPallets,weight,noOfPieces';

  const [invLines, ledger, customers, groups, shipments, shipOrders, logRows] = await Promise.all([
    byMonths(ctx, `${ctx.customApiBase}/salesInvoiceLines`, 'postingDate', early, to, 'documentNo,sellToCustomerNo,type,quantity,amount,orderNo,postingDate'),
    byMonths(ctx, `${ctx.customApiBase}/custLedgerEntries`, 'postingDate', from, to, 'documentNo,amount,amountLCY').catch(() => [] as any[]),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Customer_Card_Excel`, { $select: 'No,Name,Customer_Group_Code_CRZ' }), ctx.token, 120_000),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/customerGroups`, { $select: 'code,description' }), ctx.token).catch(() => [] as any[]),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/shipments`, {
      $filter: `Posting_Date ge ${early} and Posting_Date le ${to}`, $select: 'No,AITSCHVTA1_Whse_Shipment_No',
    }), ctx.token, 120_000),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Posted_Sales_Shipment_Excel`, {
      $filter: `Posting_Date ge ${early} and Posting_Date le ${to}`, $select: 'No,Order_No',
    }), ctx.token, 120_000),
    byMonths(ctx, `${ctx.customApiBase}/logisticCosts`, 'date', early, to, LOG),
  ]);

  const custGroup = new Map<string, string>();
  const custName = new Map<string, string>();
  const custOut: Record<string, [string, string]> = {};
  for (const c of customers) { custGroup.set(s(c.No), s(c.Customer_Group_Code_CRZ)); custName.set(s(c.No), s(c.Name)); }
  const factor = new Map<string, number>();
  for (const e of ledger) if (n(e.amount)) factor.set(s(e.documentNo), Math.abs(n(e.amountLCY) / n(e.amount)));

  // Facturas: venta en divisa local, unidades, cliente; y facturas de cada pedido
  type Inv = { no: string; date: string; cust: string; sales: number; units: number; orderSales: Map<string, number>; v: number[] };
  const invs = new Map<string, Inv>();
  const invoicesByOrder = new Map<string, Inv[]>();
  for (const l of invLines) {
    const no = s(l.documentNo);
    let inv = invs.get(no);
    if (!inv) {
      inv = { no, date: s(l.postingDate).substring(0, 10), cust: s(l.sellToCustomerNo), sales: 0, units: 0, orderSales: new Map(), v: Array(INV_COLS.length).fill(0) };
      invs.set(no, inv);
    }
    const amt = n(l.amount);
    inv.sales += amt;
    if (s(l.type) === 'Item') inv.units += n(l.quantity);
    const order = s(l.orderNo);
    if (order) {
      inv.orderSales.set(order, (inv.orderSales.get(order) || 0) + amt);
      const list = invoicesByOrder.get(order) || [];
      if (!list.includes(inv)) list.push(inv);
      invoicesByOrder.set(order, list);
    }
  }
  for (const inv of invs.values()) {
    // Facturas anteriores al año: solo para el enlace; su factor se busca igual (si no está, 1)
    const f = factor.get(inv.no) ?? 1;
    inv.sales *= f;
    for (const [k, v] of inv.orderSales) inv.orderSales.set(k, v * f);
  }
  for (const list of invoicesByOrder.values()) list.sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no));

  const orderOfShipment = new Map(shipOrders.map((x: any) => [s(x.No), s(x.Order_No)]));
  const ordersOfWhse = new Map<string, Set<string>>();
  for (const x of shipments) {
    const whse = s(x.AITSCHVTA1_Whse_Shipment_No);
    const order = orderOfShipment.get(s(x.No));
    if (!whse || !order) continue;
    if (!ordersOfWhse.has(whse)) ordersOfWhse.set(whse, new Set());
    ordersOfWhse.get(whse)!.add(order);
  }

  const I = (k: typeof INV_COLS[number]) => INV_COLS.indexOf(k);
  const unassigned = { amount: 0, rows: 0 };
  for (const row of logRows) {
    const charges = n(row.totalCharges);
    if (!charges && !n(row.totalCosts)) continue;
    const date = s(row.date).substring(0, 10);
    const targets: { inv: Inv; w: number }[] = [];
    for (const order of ordersOfWhse.get(s(row.orderNo)) || []) {
      const list = invoicesByOrder.get(order);
      if (!list?.length) continue;
      const inv = list.find(i => i.date >= date) || list[list.length - 1];
      targets.push({ inv, w: Math.abs(inv.orderSales.get(order) || 0) });
    }
    if (!targets.length) {
      if (date >= from) { unassigned.amount += charges; unassigned.rows++; }
      continue;
    }
    const tot = targets.reduce((t, x) => t + x.w, 0);
    for (const { inv, w } of targets) {
      const share = tot ? w / tot : 1 / targets.length;
      inv.v[I('freight')] += n(row.freightCharges) * share;
      inv.v[I('fuel')] += n(row.fuelSurcharge) * share;
      inv.v[I('other')] += n(row.otherSurcharges) * share;
      inv.v[I('timed')] += n(row.timedDelivery) * share;
      inv.v[I('totalCosts')] += n(row.totalCosts) * share;
      inv.v[I('totalCharges')] += charges * share;
      inv.v[I('pallets')] += n(row.shippedPallets) * share;
      inv.v[I('weight')] += n(row.weight) * share;
      inv.v[I('pieces')] += n(row.noOfPieces) * share;
      inv.v[I('shipments')] += share;
    }
  }

  const salesAll: Record<string, number> = {};
  const invoices: (string | number)[][] = [];
  for (const inv of invs.values()) {
    if (inv.date < from || inv.date > to) continue;
    const g = custGroup.get(inv.cust) || '';
    salesAll[g] = r2((salesAll[g] || 0) + inv.sales);
    if (!inv.v[I('totalCharges')] && !inv.v[I('totalCosts')]) continue;
    inv.v[I('sales')] = inv.sales;
    inv.v[I('units')] = inv.units;
    invoices.push([inv.no, inv.date, inv.cust, ...inv.v.map(x => r2(x))]);
    if (!custOut[inv.cust]) custOut[inv.cust] = [custName.get(inv.cust) || '', g];
  }
  invoices.sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[0]).localeCompare(String(b[0])));
  return {
    year, from, to, computedAt: new Date().toISOString(),
    groups: Object.fromEntries(groups.map((x: any) => [s(x.code), s(x.description)])),
    customers: custOut, invoices, salesAll, unassigned: { amount: r2(unassigned.amount), rows: unassigned.rows },
  };
}
