import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';

// Controlling · Facturación según Order Date: lo facturado cada mes (Posted Sales Invoices, importe sin IVA en divisa
// local) desglosado por el mes de la Order Date de su pedido, y en el año en curso las Sales Orders abiertas con
// Order Date y Requested Delivery Date en el mismo mes (lo que debería facturarse ese mes).
// - Facturas: movimientos de cliente de tipo Invoice (custom custLedgerEntries, Sales (LCY) = importe sin IVA en divisa
//   local) + nº de pedido de la factura (v2 salesInvoices.orderNumber).
// - Order Date del pedido: Sales Order abierta (custom salesHeaders) o, si ya se facturó entera, el pedido archivado
//   (v2 salesOrderArchives). Facturas sin pedido = "Sin pedido"; pedido no encontrado = "Order Date desconocida".
// - Pedidos abiertos: custom salesHeaders tipo Order, importe sin IVA a divisa local (amount / currencyFactor) menos lo
//   ya facturado de ese pedido en el año.

export type Invoice = {
  no: string; postingDate: string; customerNo: string; customerName: string; amount: number;
  orderNo: string; orderDate: string | null;
};
export type OpenOrder = {
  no: string; customerNo: string; customerName: string; orderDate: string; requestedDeliveryDate: string;
  amount: number; invoiced: number; pending: number; currency: string;
};

const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const lastDay = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};
const d10 = (v: any) => { const x = s(v).substring(0, 10); return x && x !== '0001-01-01' ? x : ''; };

// Order Date de los pedidos archivados (todas las versiones tienen la misma)
async function archivedOrderDates(ctx: BcContext, sinceYear: number) {
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesOrderArchives`, {
    $select: 'number,orderDate', $filter: `orderDate ge ${sinceYear}-01-01`,
  }), ctx.token);
  return Object.fromEntries(rows.map(r => [s(r.number), d10(r.orderDate)]).filter(([, d]) => d));
}

// Sales Orders abiertas (cabeceras); importe sin IVA pasado a divisa local con el factor de la cabecera
async function openOrderHeaders(ctx: BcContext) {
  const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/salesHeaders`, {
    $filter: `documentType eq 'Order'`,
    $select: 'no,sellToCustomerNo,sellToCustomerName,orderDate,requestedDeliveryDate,amount,currencyCode,currencyFactor',
  }), ctx.token).catch(async () =>
    // Por si algún campo no está publicado: sin $select
    bcFetchAll(odataUrl(`${ctx.customApiBase}/salesHeaders`, { $filter: `documentType eq 'Order'` }), ctx.token));
  return rows.map(r => {
    const factor = n(r.currencyFactor);
    return {
      no: s(r.no), customerNo: s(r.sellToCustomerNo), customerName: s(r.sellToCustomerName),
      orderDate: d10(r.orderDate), requestedDeliveryDate: d10(r.requestedDeliveryDate),
      amount: factor ? n(r.amount) / factor : n(r.amount), currency: s(r.currencyCode),
    };
  });
}

// Por trimestres en paralelo: un año entero en una sola consulta puede pasar del límite de 60 s
async function postedInvoices(ctx: BcContext, from: string, to: string): Promise<Omit<Invoice, 'orderDate'>[]> {
  const year = Number(from.substring(0, 4));
  const quarters = [[1, 3], [4, 6], [7, 9], [10, 12]]
    .map(([a, b]) => [`${year}-${String(a).padStart(2, '0')}-01`, lastDay(`${year}-${String(b).padStart(2, '0')}`)])
    .map(([a, b]) => [a < from ? from : a, b > to ? to : b]).filter(([a, b]) => a <= b);
  const parts = await Promise.all(quarters.map(([a, b]) => postedInvoicesRange(ctx, a, b)));
  return parts.flat();
}

async function postedInvoicesRange(ctx: BcContext, from: string, to: string): Promise<Omit<Invoice, 'orderDate'>[]> {
  const [entries, headers] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.customApiBase}/custLedgerEntries`, {
      $filter: `documentType eq 'Invoice' and postingDate ge ${from} and postingDate le ${to}`,
      $select: 'documentNo,postingDate,customerNo,customerName,salesLCY,reversed',
    }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, {
      $filter: `postingDate ge ${from} and postingDate le ${to}`, $select: 'number,orderNumber,status',
    }), ctx.token),
  ]);
  const orderOf = new Map(headers.filter(h => s(h.status) !== 'Draft').map(h => [s(h.number), s(h.orderNumber)]));
  return entries.filter(e => !e.reversed).map(e => ({
    no: s(e.documentNo), postingDate: d10(e.postingDate), customerNo: s(e.customerNo), customerName: s(e.customerName),
    amount: n(e.salesLCY), orderNo: orderOf.get(s(e.documentNo)) || '',
  }));
}


// Un año: facturas de los meses fromMonth..toMonth (MM) con la Order Date de su pedido y, si includeOpen, los
// pedidos abiertos. Se piden por separado los años de la comparativa (cada uno, una llamada < 60 s).
export async function orderIntakeYear(ctx: BcContext, year: number, fromMonth: number, toMonth: number, includeOpen: boolean, force = false) {
  const from = `${year}-${String(fromMonth).padStart(2, '0')}-01`;
  const to = lastDay(`${year}-${String(toMonth).padStart(2, '0')}`);
  const company = ctx.companyName;
  const live = to >= today();
  const warnings: string[] = [];
  const [invoices, archived, open] = await Promise.all([
    // Año en curso siempre en vivo; años cerrados en caché 12 h
    live ? postedInvoices(ctx, from, to) : cached(`order-intake:inv:${company}:${from}:${to}`, 12 * HOUR, () => postedInvoices(ctx, from, to), force),
    cached(`order-intake:archive:${company}:${year - 1}`, 6 * HOUR, () => archivedOrderDates(ctx, year - 1), force).catch(e => {
      warnings.push(`No se han podido leer los pedidos archivados (Sales Order Archives): ${e.message}`);
      return {} as Record<string, string>;
    }),
    openOrderHeaders(ctx),
  ]);
  const openDate = new Map(open.map(o => [o.no, o.orderDate]));
  const withDates: Invoice[] = invoices.map(i => ({
    ...i, orderDate: i.orderNo ? (openDate.get(i.orderNo) || archived[i.orderNo] || null) : null,
  }));

  let openOrders: OpenOrder[] = [];
  if (includeOpen) {
    // Lo ya facturado de cada pedido abierto (parcialmente facturado) en el año
    const invoicedByOrder: Record<string, number> = {};
    for (const i of withDates) if (i.orderNo) invoicedByOrder[i.orderNo] = (invoicedByOrder[i.orderNo] || 0) + i.amount;
    openOrders = open.filter(o => o.orderDate && o.requestedDeliveryDate).map(o => {
      const invoiced = invoicedByOrder[o.no] || 0;
      return { ...o, invoiced, pending: Math.max(0, o.amount - invoiced) };
    }).filter(o => o.pending > 0.005);
  }
  return { year, from, to, invoices: withDates, openOrders, warnings };
}
