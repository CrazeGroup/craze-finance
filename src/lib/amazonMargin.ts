import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { InvAttrs, itemCatalog } from '@/lib/reporting/inventoryAnalysis';

// Amazon (/amazon): margen de cada cliente Amazon por año, línea a línea de las facturas y abonos de venta registrados.
//   Margen = venta − coste (cantidad × Unit Cost (LCY) de la línea) − coste logístico − Amazon Ads.
// - Clientes Amazon = clientes cuyo nombre contiene "Amazon"; el cliente es el Sell-to de la línea y su país el de la
//   ficha del cliente.
// - Venta: custom salesInvoiceLines / salesCrMemoLines (abonos en negativo), en divisa local con el factor
//   amountLCY / amount de su movimiento de cliente.
// - Logística: custom logisticCosts (Total Charges). Su Order No. es el nº de Warehouse Shipment, que se enlaza con el
//   envío registrado (OData shipments, AITSCHVTA1_Whse_Shipment_No) y de ahí con el pedido de venta
//   (Posted_Sales_Shipment_Excel.Order_No). El coste va a la primera factura de ese pedido con fecha igual o posterior
//   a la del envío (si no hay, a la última), repartido entre sus líneas por importe.
// - Amazon Ads: líneas del artículo AA-00015 de las facturas (y abonos, en negativo) de compra de proveedores cuyo
//   nombre contiene "Amazon"; país = el de la ficha del proveedor. Cada mes, lo de un país se reparte entre las líneas
//   de factura de los clientes Amazon de ese país en ese mes, en proporción a la venta. Lo que no tiene ventas en su
//   país y mes queda como "sin asignar".

export const ADS_ITEM = 'AA-00015';
export const FIRST_YEAR = 2025;
const LOOKBACK_DAYS = 92;   // envíos de finales del año anterior que se facturan en este

const s = (v: any) => (v == null ? '' : String(v).trim());
const r2 = (v: number) => Math.round(v * 100) / 100;
const isAmazon = (name: string) => /amazon/i.test(name);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().substring(0, 10);

export type AmazonCustomer = { no: string; name: string; country: string };
// docs: [nº, 0 factura | 1 abono, fecha, índice de cliente, nº de pedido]
// lines: [índice de documento, índice de artículo, cantidad, venta, coste, logística, ads]
export type AmazonYear = {
  year: number; from: string; to: string; computedAt: string;
  customers: AmazonCustomer[]; items: InvAttrs[]; rawDesc: Record<string, string>;
  docs: [string, number, string, number, string][];
  lines: number[][];
  ads: { country: string; month: string; amount: number; assigned: number }[];
  logistic: { assigned: number; unassigned: number; unassignedRows: number };
};

// Lee un servicio en paralelo por meses (las tablas de líneas son grandes)
async function byMonths(ctx: BcContext, base: string, dateField: string, from: string, to: string, select: string, extra = '') {
  const parts: [string, string][] = [];
  let d = from;
  while (d <= to) {
    const [y, m] = d.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().substring(0, 10);
    parts.push([d, end < to ? end : to]);
    d = addDays(end, 1);
  }
  const chunks = await Promise.all(parts.map(([a, b]) => bcFetchAll(odataUrl(base, {
    $filter: `${dateField} ge ${a} and ${dateField} le ${b}${extra ? ` and ${extra}` : ''}`, $select: select,
  }), ctx.token, 120_000)));
  return chunks.flat();
}

export async function amazonYear(ctx: BcContext, company: string, year: number, force = false): Promise<AmazonYear> {
  const today = new Date().toISOString().substring(0, 10);
  const closed = `${year}-12-31` < today;
  return cached(`amazonMargin1:${company}:${year}`, closed ? 7 * 24 * HOUR : HOUR, () => compute(ctx, year, today), force,
    { refreshAfterMs: closed ? 7 * 24 * HOUR : HOUR });
}

async function compute(ctx: BcContext, year: number, today: string): Promise<AmazonYear> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31` < today ? `${year}-12-31` : today;
  const early = addDays(from, -LOOKBACK_DAYS);
  const LINE = 'documentNo,sellToCustomerNo,type,no,description,quantity,amount,unitCostLCY,orderNo,postingDate';

  const [customerRows, vendorRows, invLines, crLines, ledger, shipments, shipOrders, logRows, adsInv, adsCr, catalog] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.apiBase}/customers`, { $select: 'number,displayName,country' }), ctx.token, 60_000),
    bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, { $select: 'number,displayName,country' }), ctx.token, 60_000),
    byMonths(ctx, `${ctx.customApiBase}/salesInvoiceLines`, 'postingDate', early, to, LINE),
    byMonths(ctx, `${ctx.customApiBase}/salesCrMemoLines`, 'postingDate', from, to, LINE.replace(',orderNo', '')),
    byMonths(ctx, `${ctx.customApiBase}/custLedgerEntries`, 'postingDate', from, to, 'documentNo,amount,amountLCY').catch(() => [] as any[]),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/shipments`, {
      $filter: `Posting_Date ge ${early} and Posting_Date le ${to}`, $select: 'No,AITSCHVTA1_Whse_Shipment_No',
    }), ctx.token, 120_000),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Posted_Sales_Shipment_Excel`, {
      $filter: `Posting_Date ge ${early} and Posting_Date le ${to}`, $select: 'No,Order_No',
    }), ctx.token, 120_000),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/logisticCosts`, {
      $filter: `date ge ${early} and date le ${to}`, $select: 'entryNo,orderNo,consignee,date,totalCharges',
    }), ctx.token, 120_000),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/purchInvLines`, {
      $filter: `no eq '${ADS_ITEM}' and postingDate ge ${from} and postingDate le ${to}`, $select: 'buyFromVendorNo,amount,postingDate',
    }), ctx.token, 120_000),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/purchCrMemoLines`, {
      $filter: `no eq '${ADS_ITEM}' and postingDate ge ${from} and postingDate le ${to}`, $select: 'buyFromVendorNo,amount,postingDate',
    }), ctx.token, 120_000).catch(() => [] as any[]),
    itemCatalog(false),
  ]);

  // Clientes Amazon (Sell-to)
  const custInfo = new Map<string, AmazonCustomer>();
  for (const c of customerRows) if (isAmazon(s(c.displayName))) custInfo.set(s(c.number), { no: s(c.number), name: s(c.displayName), country: s(c.country) });

  // Factor a divisa local por documento
  const factor = new Map<string, number>();
  for (const e of ledger) if (e.amount) factor.set(s(e.documentNo), e.amountLCY / e.amount);

  const customers: AmazonCustomer[] = [];
  const custIdx = new Map<string, number>();
  const items: InvAttrs[] = [];
  const itemIdx = new Map<string, number>();
  const docs: AmazonYear['docs'] = [];
  const docIdx = new Map<string, number>();
  const lines: number[][] = [];
  // Facturas por pedido (también las del margen anterior al año, solo para asignar la logística)
  const invoicesByOrder = new Map<string, { no: string; date: string }[]>();
  const linesByDoc = new Map<string, number[]>();

  const itemOf = (l: any) => {
    const isItem = s(l.type) === 'Item';
    const key = isItem ? s(l.no) : `${s(l.no) || s(l.type)} ${s(l.description)}`.trim();
    let ii = itemIdx.get(key);
    if (ii === undefined) {
      ii = items.length;
      itemIdx.set(key, ii);
      items.push(isItem ? catalog.attrsOf(key, s(l.description))
        : { no: key, desc: '', range: '', cat: '', line: '', license: '', bu: '', raw: '', root: '', royalty: '', cg: '', pmc: '' });
    }
    return ii;
  };
  const addLine = (l: any, kind: 0 | 1) => {
    const cust = custInfo.get(s(l.sellToCustomerNo));
    if (!cust) return;
    const doc = s(l.documentNo);
    const date = s(l.postingDate).substring(0, 10);
    const order = kind === 0 ? s(l.orderNo) : '';
    if (kind === 0 && order) {
      const list = invoicesByOrder.get(order) || [];
      if (!list.some(x => x.no === doc)) list.push({ no: doc, date });
      invoicesByOrder.set(order, list);
    }
    if (date < from) return;
    const sales = Number(l.amount) || 0;
    const cost = (Number(l.quantity) || 0) * (Number(l.unitCostLCY) || 0);
    if (!sales && !cost) return;
    let di = docIdx.get(doc);
    if (di === undefined) {
      let ci = custIdx.get(cust.no);
      if (ci === undefined) { ci = customers.length; custIdx.set(cust.no, ci); customers.push(cust); }
      di = docs.length;
      docIdx.set(doc, di);
      docs.push([doc, kind, date, ci, order]);
    }
    const f = factor.get(doc) ?? 1;
    const sign = kind === 0 ? 1 : -1;
    const li = lines.length;
    lines.push([di, itemOf(l), sign * (Number(l.quantity) || 0), sign * sales * Math.abs(f), sign * cost, 0, 0]);
    linesByDoc.set(doc, [...(linesByDoc.get(doc) || []), li]);
  };
  for (const l of invLines) addLine(l, 0);
  for (const l of crLines) addLine(l, 1);
  for (const list of invoicesByOrder.values()) list.sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no));

  // Reparte un importe entre líneas por venta (o por igual si no tienen venta)
  const spread = (idx: number[], amount: number, col: number) => {
    if (!idx.length) return false;
    const base = idx.reduce((t, i) => t + Math.abs(lines[i][3]), 0);
    for (const i of idx) lines[i][col] += amount * (base ? Math.abs(lines[i][3]) / base : 1 / idx.length);
    return true;
  };

  // Logística: Whse Shipment → envíos registrados → pedidos → factura del pedido
  const orderOfShipment = new Map(shipOrders.map((x: any) => [s(x.No), s(x.Order_No)]));
  const ordersOfWhse = new Map<string, Set<string>>();
  for (const x of shipments) {
    const whse = s(x.AITSCHVTA1_Whse_Shipment_No);
    const order = orderOfShipment.get(s(x.No));
    if (!whse || !order) continue;
    if (!ordersOfWhse.has(whse)) ordersOfWhse.set(whse, new Set());
    ordersOfWhse.get(whse)!.add(order);
  }
  const logistic = { assigned: 0, unassigned: 0, unassignedRows: 0 };
  for (const row of logRows) {
    const amount = Number(row.totalCharges) || 0;
    if (!amount) continue;
    const date = s(row.date).substring(0, 10);
    const target: number[] = [];
    let found = false;
    for (const order of ordersOfWhse.get(s(row.orderNo)) || []) {
      const invs = invoicesByOrder.get(order);
      if (!invs?.length) continue;
      found = true;
      const inv = invs.find(i => i.date >= date) || invs[invs.length - 1];
      for (const li of linesByDoc.get(inv.no) || []) if (docs[lines[li][0]][4] === order) target.push(li);
    }
    if (target.length) {
      spread(target, amount, 5);
      logistic.assigned += amount;
    } else if (!found && date >= from && isAmazon(s(row.consignee))) {
      // Envío a Amazon cuyo pedido aún no está facturado (o no se ha podido enlazar)
      logistic.unassigned += amount;
      logistic.unassignedRows++;
    }
  }

  // Amazon Ads por país y mes
  const vendorCountry = new Map<string, string>();
  for (const v of vendorRows) if (isAmazon(s(v.displayName))) vendorCountry.set(s(v.number), s(v.country));
  const adsBy = new Map<string, number>();
  const addAds = (l: any, sign: number) => {
    const country = vendorCountry.get(s(l.buyFromVendorNo));
    if (country === undefined) return;
    const k = `${country}|${s(l.postingDate).substring(0, 7)}`;
    adsBy.set(k, (adsBy.get(k) || 0) + sign * (Number(l.amount) || 0));
  };
  for (const l of adsInv) addAds(l, 1);
  for (const l of adsCr) addAds(l, -1);
  const salesLines = new Map<string, number[]>();
  lines.forEach((l, i) => {
    const d = docs[l[0]];
    if (d[1] !== 0 || l[3] <= 0) return;
    const k = `${customers[d[3]].country}|${d[2].substring(0, 7)}`;
    if (!salesLines.has(k)) salesLines.set(k, []);
    salesLines.get(k)!.push(i);
  });
  const ads: AmazonYear['ads'] = [];
  for (const [k, amount] of adsBy) {
    const [country, month] = k.split('|');
    const ok = spread(salesLines.get(k) || [], amount, 6);
    ads.push({ country, month, amount: r2(amount), assigned: ok ? r2(amount) : 0 });
  }
  ads.sort((a, b) => a.month.localeCompare(b.month) || a.country.localeCompare(b.country));

  for (const l of lines) for (let c = 2; c < 7; c++) l[c] = r2(l[c]);
  return {
    year, from, to, computedAt: new Date().toISOString(),
    customers, items, rawDesc: catalog.rawDescs(items), docs, lines, ads,
    logistic: { assigned: r2(logistic.assigned), unassigned: r2(logistic.unassigned), unassignedRows: logistic.unassignedRows },
  };
}
