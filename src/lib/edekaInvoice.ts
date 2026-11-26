import prisma from '@/lib/prisma';
import { getBcContext, bcFetchAll, odataUrl, type BcContext } from '@/lib/bcClient';
import { transusCall } from '@/lib/transus';

// Facturas EDI a EDEKA por Transus (hoy se teclean a mano en Transus Online). Se construye el mensaje TRANSUSXML
// Invoice (MessageType 8, el mismo formato que BC envía a Rossmann/Markant, fuente "Dynamics 365 Business Central")
// a partir de la factura registrada en BC, con lo que EDEKA pide y BC no pone:
// - precio BRUTO por artículo (BC guarda el neto ya descontado) y los descuentos a nivel de factura, escalonados:
//   DI 2 % y DI 10 % sobre el bruto, EAB 3 % sobre lo que queda y TD 2,8 % sobre lo que queda (CRZ-SI26-03948 cuadra
//   al céntimo). El bruto se recupera dividiendo el neto por la cadena (0,88 × 0,97 × 0,972) y redondeando a 2 dec.
// - FSDU / displays (artículo con lista de materiales): la línea del display es la unidad de factura (IsInvoiceUnit,
//   IsDisplay, ConsumerUnitQuantity) y cada artículo de dentro va como unidad de consumo (IsConsumerUnit, ParentGTIN,
//   precio 0, cantidad = displays × cantidad por display).
// - GLN: comprador = ficha del cliente de venta, factura = ficha del cliente de facturación (EDEKA Zentralhandels),
//   entrega = albarán (Delivery GLN EDI de la dirección de envío). Nº de albarán = parte final (DN-0029449-31377 → 31377).
// Setting `edeka:discounts` (ApiConfig, JSON [{code, pct, base: 'gross'|'rest'}]) cambia la cadena de descuentos.

export const EDEKA_INVOICEE = '191195'; // EDEKA Zentralhandels GmbH (Bill-to de todas las facturas a EDEKA)
const SUPPLIER = { name: 'CRAZE GmbH', transusId: '10793765', gln: '4260278550003', vat: 'DE281461152', country: 'DE' };
const sentKey = (company: string, no: string) => `edeka:sent:${company}:${no}`;

export type Discount = { code: string; pct: number; base: 'gross' | 'rest' };
const DEFAULT_DISCOUNTS: Discount[] = [
  { code: 'DI', pct: 2, base: 'gross' }, { code: 'DI', pct: 10, base: 'gross' },
  { code: 'EAB', pct: 3, base: 'rest' }, { code: 'TD', pct: 2.8, base: 'rest' },
];
async function discountChain(): Promise<Discount[]> {
  const row = await prisma.apiConfig.findUnique({ where: { key: 'edeka:discounts' } }).catch(() => null);
  try { const v = row?.config ? JSON.parse(row.config) : null; if (Array.isArray(v) && v.length) return v; } catch { /* default */ }
  return DEFAULT_DISCOUNTS;
}
// Factor neto/bruto de la cadena: los descuentos sobre el bruto se suman; los "rest" se encadenan
const chainFactor = (d: Discount[]) => {
  const gross = d.filter(x => x.base === 'gross').reduce((s, x) => s + x.pct, 0);
  return d.filter(x => x.base === 'rest').reduce((f, x) => f * (1 - x.pct / 100), 1 - gross / 100);
};
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const ymd = (d?: string) => (d && d !== '0001-01-01' ? d.replace(/-/g, '') : '');
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const q = (s: string) => s.replace(/'/g, "''");
// Código de artículo del proveedor = parte numérica inicial (34309DEX → 34309, 86087PAL → 86087), como en BC/Transus
const supplierCode = (no: string) => no.match(/^\d+/)?.[0] || no;

export type EdekaListRow = {
  no: string; date: string; sellTo: string; sellToName: string; shipTo: string; orderNo: string; amount: number; amountInclVat: number;
  sent?: { at: string; by: string; transactionId: string; test: boolean } | null;
};

// Facturas registradas a EDEKA (Bill-to = EDEKA Zentralhandels) en el periodo, con su estado de envío desde la app
export async function listEdekaInvoices(company: string, from: string, to: string): Promise<EdekaListRow[]> {
  const ctx = await getBcContext(company);
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, {
    $filter: `billToCustomerNumber eq '${EDEKA_INVOICEE}' and invoiceDate ge ${from} and invoiceDate le ${to}`,
    $select: 'number,invoiceDate,customerNumber,customerName,shipToName,externalDocumentNumber,totalAmountExcludingTax,totalAmountIncludingTax,status',
  }), ctx.token);
  const sent = await prisma.apiConfig.findMany({ where: { key: { startsWith: `edeka:sent:${company}:` } } });
  const sentMap = new Map(sent.map(s => [s.key, JSON.parse(s.config || '{}')]));
  return rows.filter((r: any) => r.status !== 'Canceled').map((r: any) => ({
    no: r.number, date: r.invoiceDate, sellTo: r.customerNumber, sellToName: r.customerName, shipTo: r.shipToName || '',
    orderNo: r.externalDocumentNumber || '', amount: Number(r.totalAmountExcludingTax) || 0, amountInclVat: Number(r.totalAmountIncludingTax) || 0,
    sent: sentMap.get(sentKey(company, r.number)) || null,
  })).sort((a, b) => (a.date === b.date ? (a.no < b.no ? 1 : -1) : a.date < b.date ? 1 : -1));
}

type ArticleOut = {
  line: number; itemNo: string; gtin: string; code: string; description: string; kind: 'item' | 'display' | 'component';
  parentGtin?: string; qty: number; grossPrice: number; netPriceBc?: number; amount: number; consumerUnits?: number;
};
export type EdekaBuild = {
  no: string; xml: string; warnings: string[];
  header: Record<string, string>;
  articles: ArticleOut[];
  discounts: { code: string; pct: number; base: string; amount: number }[];
  totals: { lines: number; discounts: number; base: number; vat: number; total: number; vatPct: number };
  bc: { base: number; vat: number; total: number };
};

async function one(ctx: BcContext, url: string) { return (await bcFetchAll(url, ctx.token))[0]; }

export async function buildEdekaInvoice(company: string, no: string, opts: { test?: boolean } = {}): Promise<EdekaBuild> {
  const ctx = await getBcContext(company);
  const warnings: string[] = [];
  const h = await one(ctx, odataUrl(`${ctx.apiBase}/salesInvoices`, { $filter: `number eq '${q(no)}'` }));
  if (!h) throw new Error(`Invoice ${no} not found in BC`);
  if (h.billToCustomerNumber !== EDEKA_INVOICEE) warnings.push(`The bill-to customer is ${h.billToCustomerNumber} ${h.billToName}, not EDEKA Zentralhandels (${EDEKA_INVOICEE})`);

  const [lines, cards, shipments, chain] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.customApiBase}/salesInvoiceLines`, { $filter: `documentNo eq '${q(no)}'` }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Customer_Card_Excel`, {
      $filter: `No eq '${q(h.customerNumber)}' or No eq '${q(h.billToCustomerNumber)}'`, $select: 'No,Name,GLN,VAT_Registration_No',
    }), ctx.token),
    h.orderNumber ? bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Posted_Sales_Shipment_Excel`, {
      $filter: `Order_No eq '${q(h.orderNumber)}'`,
      $select: 'No,Posting_Date,Ship_to_Name,Ship_to_Address,Ship_to_City,Ship_to_Post_Code,Ship_to_Country_Region_Code,Delivery_GLN_EDI,AIT_Delivery_Note_No_Correc,AIT_Delivery_Note_Date_Correc',
    }), ctx.token) : Promise.resolve([]),
    discountChain(),
  ]);
  const card = (n: string) => cards.find((c: any) => c.No === n) || {};
  const buyer: any = card(h.customerNumber), invoicee: any = card(h.billToCustomerNumber);
  if (!buyer.GLN) warnings.push(`Customer ${h.customerNumber} has no GLN in BC`);
  if (!invoicee.GLN) warnings.push(`Customer ${h.billToCustomerNumber} has no GLN in BC`);
  const ship: any = shipments.sort((a: any, b: any) => (a.Posting_Date < b.Posting_Date ? 1 : -1))[0];
  if (!ship) warnings.push(`No posted shipment found for order ${h.orderNumber || '(none)'}: no delivery GLN or despatch advice number`);
  else if (shipments.length > 1) warnings.push(`Order ${h.orderNumber} has ${shipments.length} shipments; the latest (${ship.No}) is used`);
  if (ship && !ship.Delivery_GLN_EDI) warnings.push(`Shipment ${ship.No} has no Delivery GLN EDI (ship-to address)`);
  const despatchNo = (ship?.AIT_Delivery_Note_No_Correc || ship?.No || '').split('-').pop() || '';

  const itemLines = lines.filter((l: any) => l.type === 'Item' && Number(l.quantity));
  const other = lines.filter((l: any) => l.type !== 'Item' && Number(l.amount));
  if (other.length) warnings.push(`${other.length} non-item line(s) with amount are not included: ${other.map((l: any) => `${l.no} ${l.amount}`).join(', ')}`);

  // Listas de materiales (displays) y GTIN de artículos y componentes
  const itemNos = Array.from(new Set(itemLines.map((l: any) => l.no as string)));
  const boms = new Map<string, any[]>();
  await Promise.all(itemNos.map(async n => {
    const comps = await bcFetchAll(odataUrl(`${ctx.customApiBase}/bomComponents`, { $filter: `parentItemNo eq '${q(n)}'` }), ctx.token).catch(() => []);
    const items = comps.filter((c: any) => c.type === 'Item' && Number(c.quantityPer));
    if (items.length) boms.set(n, items);
  }));
  const allNos = Array.from(new Set([...itemNos, ...Array.from(boms.values()).flat().map((c: any) => c.no as string)]));
  const gtins = new Map<string, { gtin: string; name: string }>();
  for (let i = 0; i < allNos.length; i += 20) {
    const part = allNos.slice(i, i + 20);
    const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/items`, { $filter: part.map(n => `number eq '${q(n)}'`).join(' or '), $select: 'number,displayName,gtin' }), ctx.token);
    for (const r of rows) gtins.set(r.number, { gtin: r.gtin || '', name: r.displayName || '' });
  }

  const factor = chainFactor(chain);
  const articles: ArticleOut[] = [];
  let lineNo = 0;
  for (const l of itemLines) {
    const qty = Number(l.quantity);
    const net = Number(l.unitPrice) * (1 - (Number(l.lineDiscount) || 0) / 100);
    const gross = r2(net / factor);
    if (Math.abs(gross * factor - net) > 0.005) warnings.push(`${l.no}: BC net price ${net} does not come from a 2-decimal gross price with the discount chain (gross ${gross} → ${r2(gross * factor * 100000) / 100000})`);
    const gtin = gtins.get(l.no)?.gtin || '';
    if (!gtin) warnings.push(`Item ${l.no} has no GTIN in BC`);
    const comps = boms.get(l.no);
    const consumerUnits = comps?.reduce((s, c) => s + Number(c.quantityPer), 0);
    articles.push({ line: ++lineNo, itemNo: l.no, gtin, code: supplierCode(l.no), description: l.description, kind: comps ? 'display' : 'item', qty, grossPrice: gross, netPriceBc: net, amount: r2(gross * qty), consumerUnits });
    if (comps) {
      // Un mismo artículo puede estar en varias líneas de la lista de materiales: se suman
      const byItem = new Map<string, number>();
      for (const c of comps) byItem.set(c.no, (byItem.get(c.no) || 0) + Number(c.quantityPer));
      for (const [cNo, per] of Array.from(byItem.entries())) {
        const g = gtins.get(cNo);
        if (!g?.gtin) warnings.push(`Component ${cNo} of ${l.no} has no GTIN in BC`);
        articles.push({ line: ++lineNo, itemNo: cNo, gtin: g?.gtin || '', code: supplierCode(cNo), description: g?.name || comps.find(c => c.no === cNo)?.description || '', kind: 'component', parentGtin: gtin, qty: qty * per, grossPrice: 0, amount: 0 });
      }
    }
  }

  const vatPct = Number(itemLines[0]?.vat) || 19;
  if (itemLines.some((l: any) => Number(l.vat) !== vatPct)) warnings.push('The invoice has lines with different VAT rates; only one rate is supported');
  const linesTotal = r2(articles.reduce((s, a) => s + a.amount, 0));
  let rest = linesTotal;
  const discounts = chain.map(d => ({ ...d, amount: 0 }));
  for (const d of discounts.filter(d => d.base === 'gross')) d.amount = r2(linesTotal * d.pct / 100);
  rest = r2(linesTotal - discounts.filter(d => d.base === 'gross').reduce((s, d) => s + d.amount, 0));
  for (const d of discounts.filter(d => d.base === 'rest')) { d.amount = r2(rest * d.pct / 100); rest = r2(rest - d.amount); }
  const discTotal = r2(discounts.reduce((s, d) => s + d.amount, 0));
  const base = r2(linesTotal - discTotal), vat = r2(base * vatPct / 100), total = r2(base + vat);
  const bc = { base: Number(h.totalAmountExcludingTax) || 0, vat: Number(h.totalTaxAmount) || 0, total: Number(h.totalAmountIncludingTax) || 0 };
  if (Math.abs(total - bc.total) > 0.005) warnings.push(`Total ${total.toFixed(2)} differs from BC (${bc.total.toFixed(2)}) by ${(total - bc.total).toFixed(2)}: the gross prices are recalculated from BC's net prices`);

  const header: Record<string, string> = {
    InvoiceNumber: h.number, InvoiceDate: ymd(h.invoiceDate), OrderNumberBuyer: h.externalDocumentNumber || '',
    DespatchAdviceNumber: despatchNo, Buyer: `${h.customerNumber} ${h.customerName}`, BuyerGLN: buyer.GLN || '',
    Invoicee: `${h.billToCustomerNumber} ${h.billToName}`, InvoiceeGLN: invoicee.GLN || '',
    DeliveryParty: ship?.Ship_to_Name || h.shipToName || '', DeliveryPartyGLN: ship?.Delivery_GLN_EDI || '', DueDate: ymd(h.dueDate),
  };

  const el = (t: string, v: string | number | undefined, ind = 2) => (v === undefined || v === '' ? null : `${' '.repeat(ind)}<${t}>${xmlEsc(String(v))}</${t}>`);
  const shipDate = ymd(ship?.AIT_Delivery_Note_Date_Correc || ship?.Posting_Date) || ymd(h.invoiceDate);
  const out: (string | null)[] = ["<?xml version='1.0' encoding='UTF-8'?>", '<Messages>', '<Message>',
    el('MessageStandard', 'TRANSUSXML'), el('MessageType', '8'),
    el('Sender', SUPPLIER.name), el('SenderID', SUPPLIER.transusId), el('SenderGLN', SUPPLIER.gln),
    el('Recipient', h.billToName), el('RecipientGLN', invoicee.GLN),
    el('IsTestMessage', opts.test ? 'Y' : 'N'),
    el('InvoiceNumber', h.number), el('InvoiceType', 'NOR'), el('InvoiceDate', ymd(h.invoiceDate)),
    el('OrderNumberBuyer', h.externalDocumentNumber), el('OrderDate', ymd(h.invoiceDate)),
    el('DeliveryDate', shipDate ? `${shipDate}0000` : undefined),
    el('DespatchAdviceNumber', despatchNo), el('DespatchAdviceDate', shipDate),
    el('ActionNumber', h.externalDocumentNumber),
    el('BuyerGLN', buyer.GLN), el('BuyerID', h.customerNumber), el('BuyerVATNumber', buyer.VAT_Registration_No),
    el('InvoiceeGLN', invoicee.GLN), el('InvoiceeID', h.billToCustomerNumber), el('InvoiceeVATNumber', invoicee.VAT_Registration_No),
    el('DeliveryPartyGLN', ship?.Delivery_GLN_EDI), el('DeliveryParty', ship?.Ship_to_Name || h.shipToName),
    el('DeliveryPartyAddress', ship?.Ship_to_Address || h.shipToAddressLine1), el('DeliveryPartyCity', ship?.Ship_to_City || h.shipToCity),
    el('DeliveryPartyZipcode', ship?.Ship_to_Post_Code || h.shipToPostCode), el('DeliveryPartyCountry', ship?.Ship_to_Country_Region_Code || h.shipToCountry),
    el('SupplierGLN', SUPPLIER.gln), el('SupplierID', SUPPLIER.transusId), el('SupplierVATNumber', SUPPLIER.vat),
    el('RecipientPaymentGLN', SUPPLIER.gln), el('VATPercentage', vatPct), el('IsDutyFree', 'N'), el('CurrencyCode', h.currencyCode || 'EUR'),
    el('DueDate', ymd(h.dueDate)), el('IsReversedCharged', 'N'), el('SupplierCountry', SUPPLIER.country),
  ];
  for (const d of discounts) out.push('  <InvoiceDiscount>', el('DiscountAmount', d.amount.toFixed(2), 4), el('DiscountCode', d.code, 4),
    el('DiscountPercentage', d.pct, 4), el('VATPercentage', vatPct, 4), el('IsDutyFree', 'N', 4), '  </InvoiceDiscount>');
  for (const a of articles) {
    const inv = a.kind !== 'component';
    out.push('  <Article>', el('LineNumber', a.line, 4), el('GTIN', a.gtin, 4), el('ArticleCodeSupplier', a.code, 4), el('ArticleDescription', a.description, 4),
      el('IsInvoiceUnit', inv ? 'Y' : 'N', 4), el('IsConsumerUnit', a.kind === 'component' ? 'Y' : a.kind === 'display' ? 'N' : undefined, 4),
      el('DeliveredQuantity', a.qty, 4), el('InvoicedQuantity', a.qty, 4), el('NetLineAmount', a.amount.toFixed(2), 4),
      el('ConsumerUnitQuantity', a.consumerUnits, 4),
      el('ArticleNetPrice', a.grossPrice.toFixed(2), 4), el('ArticleNetPriceUnitCode', 'PCS', 4),
      inv ? el('ArticleGrossPrice', a.grossPrice.toFixed(2), 4) : null, inv ? el('ArticleGrossPriceUnitCode', 'PCS', 4) : null,
      el('DespatchAdviceNumber', despatchNo, 4), el('OrderNumberBuyer', h.externalDocumentNumber, 4),
      el('VATPercentage', vatPct, 4), el('IsDutyFree', 'N', 4), el('ParentGTIN', a.parentGtin, 4), el('IsDisplay', a.kind === 'display' ? 'Y' : undefined, 4),
      '  </Article>');
  }
  out.push('  <InvoiceTotals>', el('DiscountAmount', discTotal.toFixed(2), 4), el('NetLineAmount', linesTotal.toFixed(2), 4), el('InvoiceAmount', total.toFixed(2), 4),
    el('VATAmount', vat.toFixed(2), 4), el('VATBaseAmount', base.toFixed(2), 4), '  </InvoiceTotals>',
    '  <InvoiceVATTotals>', el('VATPercentage', vatPct, 4), el('IsReversedCharged', 'N', 4), el('VATBaseAmount', base.toFixed(2), 4), el('VATAmount', vat.toFixed(2), 4),
    el('IsDutyFree', 'N', 4), el('DiscountAmount', discTotal.toFixed(2), 4), '  </InvoiceVATTotals>', '</Message>', '</Messages>');

  return {
    no: h.number, xml: out.filter(Boolean).join('\n') + '\n', warnings, header, articles,
    discounts: discounts.map(d => ({ code: d.code, pct: d.pct, base: d.base, amount: d.amount })),
    totals: { lines: linesTotal, discounts: discTotal, base, vat, total, vatPct }, bc,
  };
}

// Envía el XML a Transus (WebConnect M10100) y guarda el envío. Solo con confirmación explícita desde la página.
export async function sendEdekaInvoice(company: string, no: string, test: boolean, by: string) {
  const build = await buildEdekaInvoice(company, no, { test });
  const res = await transusCall('M10100', { Message: Buffer.from(build.xml, 'utf-8').toString('base64') });
  const exitCode = res.fields?.ExitCode;
  const transactionId = res.fields?.TransactionID || '';
  if (exitCode !== '0') {
    throw new Error(`Transus refused the message (ExitCode ${exitCode ?? '?'}${res.fault ? `: ${res.fault}` : ''}${res.raw ? `: ${res.raw.substring(0, 300)}` : ''})`);
  }
  const config = JSON.stringify({ at: new Date().toISOString(), by, transactionId, test });
  await prisma.apiConfig.upsert({ where: { key: sentKey(company, no) }, update: { config }, create: { key: sentKey(company, no), url: '', config } });
  return { transactionId, test, warnings: build.warnings };
}
