// Facturas electrónicas: ZUGFeRD / Factur-X (PDF/A-3 con el XML dentro) y XRechnung (solo XML).
// Dos sintaxis (EN 16931): UN/CEFACT CII (rsm:CrossIndustryInvoice: ZUGFeRD, Factur-X y XRechnung CII) y OASIS UBL
// (Invoice / CreditNote: XRechnung UBL). De ahí salen exactos el nº, las fechas, el proveedor (VAT, IBAN, correo), las
// líneas, el desglose de IVA y los totales; el OCR los usa en vez de buscarlos en el texto del PDF.
import { getDocumentProxy } from 'unpdf';

// ---------- XML mínimo (sin dependencias): árbol con nombres locales (sin prefijo de namespace) ----------
type Node = { name: string; attrs: Record<string, string>; children: Node[]; text: string };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m);
const local = (n: string) => n.slice(n.indexOf(':') + 1);

export function parseXml(xml: string): Node | null {
  const root: Node = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] || '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1])] = decode(a[2] ?? a[3] ?? '');
      const node: Node = { name: local(m[3]), attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6]) top.text += decode(m[6]);
  }
  return root.children[0] || null;
}

// Hijos por ruta de nombres locales ("SellerTradeParty/Name")
function all(n: Node | null | undefined, path: string): Node[] {
  let cur = n ? [n] : [];
  for (const part of path.split('/')) cur = cur.flatMap(c => c.children.filter(k => k.name === part));
  return cur;
}
const one = (n: Node | null | undefined, path: string) => all(n, path)[0] || null;
const txt = (n: Node | null | undefined, path?: string) => ((path ? one(n, path) : n)?.text || '').trim();
const num = (n: Node | null | undefined, path?: string) => { const v = parseFloat(txt(n, path).replace(',', '.')); return isFinite(v) ? v : null; };
// Fechas CII formato 102 (20261125) y UBL (2026-11-25)
const isoDate = (s: string) => { const d = s.replace(/\D/g, ''); return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : ''; };
const r2 = (v: number) => Math.round(v * 100) / 100;

export type EInvoiceLine = { id: string; name: string; sellerId: string; gtin: string; quantity: number; unit: string; price: number; amount: number; vatPct: number | null };
export type EInvoice = {
  format: string; syntax: 'CII' | 'UBL'; profile: string; number: string; typeCode: string; creditNote: boolean;
  issueDate: string; dueDate: string; deliveryDate: string; currency: string;
  seller: { name: string; vat: string; taxNo: string; email: string; iban: string; street: string; city: string; country: string };
  buyerReference: string; orderRef: string; note: string;
  lines: EInvoiceLine[]; taxes: { pct: number; basis: number; vat: number; category: string }[];
  net: number | null; vat: number | null; total: number | null; payable: number | null;
};

// Tipos de documento: 381 abono, 384 factura rectificativa (abono si el total es negativo), 380/326/389… factura
const CREDIT_TYPES = new Set(['381', '261', '262', '296', '308', '396', '420', '458', '532']);

function fromCii(doc: Node): EInvoice {
  const ctxNode = one(doc, 'ExchangedDocumentContext');
  const profile = txt(ctxNode, 'GuidelineSpecifiedDocumentContextParameter/ID');
  const head = one(doc, 'ExchangedDocument');
  const tx = one(doc, 'SupplyChainTradeTransaction');
  const agr = one(tx, 'ApplicableHeaderTradeAgreement');
  const set = one(tx, 'ApplicableHeaderTradeSettlement');
  const seller = one(agr, 'SellerTradeParty');
  const reg = (scheme: string) => txt(all(seller, 'SpecifiedTaxRegistration/ID').find(n => n.attrs.schemeID === scheme));
  const sum = one(set, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  // TaxTotalAmount puede venir dos veces (en la divisa de la factura y en la de IVA): la de la factura
  const currency = txt(set, 'InvoiceCurrencyCode');
  const taxTotal = all(sum, 'TaxTotalAmount').find(n => !n.attrs.currencyID || n.attrs.currencyID === currency);
  const lines = all(tx, 'IncludedSupplyChainTradeLineItem').map(li => {
    const prod = one(li, 'SpecifiedTradeProduct');
    const qty = one(li, 'SpecifiedLineTradeDelivery/BilledQuantity');
    const priceNode = one(li, 'SpecifiedLineTradeAgreement/NetPriceProductTradePrice');
    const basisQty = num(priceNode, 'BasisQuantity') || 1;
    const quantity = num(qty) ?? 0;
    const amount = num(li, 'SpecifiedLineTradeSettlement/SpecifiedTradeSettlementLineMonetarySummation/LineTotalAmount') ?? 0;
    const price = num(priceNode, 'ChargeAmount');
    return {
      id: txt(li, 'AssociatedDocumentLineDocument/LineID'), name: [txt(prod, 'Name'), txt(prod, 'Description')].filter(Boolean).join(' · '),
      sellerId: txt(prod, 'SellerAssignedID'), gtin: txt(prod, 'GlobalID'), quantity, unit: qty?.attrs.unitCode || '',
      price: price != null ? price / basisQty : quantity ? amount / quantity : amount, amount,
      vatPct: num(li, 'SpecifiedLineTradeSettlement/ApplicableTradeTax/RateApplicablePercent'),
    };
  });
  const typeCode = txt(head, 'TypeCode');
  const total = num(sum, 'GrandTotalAmount');
  const xr = /xrechnung/i.test(profile);
  return {
    format: xr ? 'XRechnung (CII)' : 'ZUGFeRD / Factur-X', syntax: 'CII', profile,
    number: txt(head, 'ID'), typeCode, creditNote: CREDIT_TYPES.has(typeCode) || (typeCode === '384' && (total ?? 0) < 0),
    issueDate: isoDate(txt(head, 'IssueDateTime/DateTimeString')),
    dueDate: isoDate(txt(set, 'SpecifiedTradePaymentTerms/DueDateDateTime/DateTimeString')),
    deliveryDate: isoDate(txt(tx, 'ApplicableHeaderTradeDelivery/ActualDeliverySupplyChainEvent/OccurrenceDateTime/DateTimeString')),
    currency,
    seller: {
      name: txt(seller, 'Name'), vat: reg('VA'), taxNo: reg('FC'),
      email: txt(seller, 'DefinedTradeContact/EmailURIUniversalCommunication/URIID') || txt(seller, 'URIUniversalCommunication/URIID'),
      iban: txt(set, 'SpecifiedTradeSettlementPaymentMeans/PayeePartyCreditorFinancialAccount/IBANID'),
      street: txt(seller, 'PostalTradeAddress/LineOne'), city: [txt(seller, 'PostalTradeAddress/PostcodeCode'), txt(seller, 'PostalTradeAddress/CityName')].filter(Boolean).join(' '),
      country: txt(seller, 'PostalTradeAddress/CountryID'),
    },
    buyerReference: txt(agr, 'BuyerReference'), orderRef: txt(agr, 'BuyerOrderReferencedDocument/IssuerAssignedID'),
    note: all(head, 'IncludedNote/Content').map(n => txt(n)).filter(Boolean).join(' · ').substring(0, 500),
    lines,
    taxes: all(set, 'ApplicableTradeTax').map(t => ({ pct: num(t, 'RateApplicablePercent') ?? 0, basis: num(t, 'BasisAmount') ?? 0, vat: num(t, 'CalculatedAmount') ?? 0, category: txt(t, 'CategoryCode') })),
    net: num(sum, 'TaxBasisTotalAmount'), vat: num(taxTotal), total, payable: num(sum, 'DuePayableAmount'),
  };
}

function fromUbl(doc: Node): EInvoice {
  const credit = doc.name === 'CreditNote';
  const party = one(doc, 'AccountingSupplierParty/Party');
  const sum = one(doc, 'LegalMonetaryTotal');
  const typeCode = txt(doc, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode');
  const total = num(sum, 'TaxInclusiveAmount');
  const currency = txt(doc, 'DocumentCurrencyCode');
  const taxTotal = all(doc, 'TaxTotal').find(t => !one(t, 'TaxAmount')?.attrs.currencyID || one(t, 'TaxAmount')?.attrs.currencyID === currency) || one(doc, 'TaxTotal');
  const schemes = all(party, 'PartyTaxScheme');
  const lines = all(doc, credit ? 'CreditNoteLine' : 'InvoiceLine').map(li => {
    const qty = one(li, credit ? 'CreditedQuantity' : 'InvoicedQuantity');
    const quantity = num(qty) ?? 0;
    const amount = num(li, 'LineExtensionAmount') ?? 0;
    const price = num(li, 'Price/PriceAmount');
    const basisQty = num(li, 'Price/BaseQuantity') || 1;
    return {
      id: txt(li, 'ID'), name: [txt(li, 'Item/Name'), txt(li, 'Item/Description')].filter(Boolean).join(' · '),
      sellerId: txt(li, 'Item/SellersItemIdentification/ID'), gtin: txt(li, 'Item/StandardItemIdentification/ID'),
      quantity, unit: qty?.attrs.unitCode || '', price: price != null ? price / basisQty : quantity ? amount / quantity : amount, amount,
      vatPct: num(li, 'Item/ClassifiedTaxCategory/Percent'),
    };
  });
  return {
    format: 'XRechnung (UBL)', syntax: 'UBL', profile: txt(doc, 'CustomizationID'),
    number: txt(doc, 'ID'), typeCode, creditNote: credit || CREDIT_TYPES.has(typeCode) || (typeCode === '384' && (total ?? 0) < 0),
    issueDate: isoDate(txt(doc, 'IssueDate')),
    dueDate: isoDate(txt(doc, 'DueDate') || txt(doc, 'PaymentMeans/PaymentDueDate')),
    deliveryDate: isoDate(txt(doc, 'Delivery/ActualDeliveryDate')),
    currency,
    seller: {
      name: txt(party, 'PartyLegalEntity/RegistrationName') || txt(party, 'PartyName/Name'),
      vat: txt(schemes.find(s => txt(s, 'TaxScheme/ID') === 'VAT') || schemes[0], 'CompanyID'),
      taxNo: txt(schemes.find(s => txt(s, 'TaxScheme/ID') !== 'VAT'), 'CompanyID'),
      email: txt(party, 'Contact/ElectronicMail') || (one(party, 'EndpointID')?.attrs.schemeID === 'EM' ? txt(party, 'EndpointID') : ''),
      iban: txt(doc, 'PaymentMeans/PayeeFinancialAccount/ID'),
      street: txt(party, 'PostalAddress/StreetName'), city: [txt(party, 'PostalAddress/PostalZone'), txt(party, 'PostalAddress/CityName')].filter(Boolean).join(' '),
      country: txt(party, 'PostalAddress/Country/IdentificationCode'),
    },
    buyerReference: txt(doc, 'BuyerReference'), orderRef: txt(doc, 'OrderReference/ID'),
    note: all(doc, 'Note').map(n => txt(n)).filter(Boolean).join(' · ').substring(0, 500),
    lines,
    taxes: all(taxTotal, 'TaxSubtotal').map(t => ({ pct: num(t, 'TaxCategory/Percent') ?? 0, basis: num(t, 'TaxableAmount') ?? 0, vat: num(t, 'TaxAmount') ?? 0, category: txt(t, 'TaxCategory/ID') })),
    net: num(sum, 'TaxExclusiveAmount'), vat: num(taxTotal, 'TaxAmount'), total, payable: num(sum, 'PayableAmount'),
  };
}

// XML de factura electrónica → datos; null si no es CII ni UBL
export function parseEInvoice(xml: string): EInvoice | null {
  const doc = parseXml(xml.replace(/^﻿/, ''));
  if (!doc) return null;
  if (doc.name === 'CrossIndustryInvoice') return fromCii(doc);
  if (doc.name === 'Invoice' || doc.name === 'CreditNote') return fromUbl(doc);
  return null;
}

// Texto del fichero: UTF-8, o la codificación de la declaración XML
export function xmlText(data: Uint8Array) {
  const head = new TextDecoder('latin1').decode(data.slice(0, 200));
  const enc = head.match(/encoding=["']([\w-]+)["']/i)?.[1] || 'utf-8';
  try { return new TextDecoder(enc).decode(data); } catch { return new TextDecoder('utf-8').decode(data); }
}
export const looksXml = (name: string, data: Uint8Array) =>
  /\.xml$/i.test(name) || /^\s*<(\?xml|[\w:]*(CrossIndustryInvoice|Invoice|CreditNote)\b)/.test(new TextDecoder('latin1').decode(data.slice(0, 300)).replace(/^﻿/, ''));

// XML incrustado en un PDF (ZUGFeRD: zugferd-invoice.xml / ZUGFeRD-invoice.xml; Factur-X: factur-x.xml; XRechnung:
// xrechnung.xml; otros: cualquier .xml que sea una factura)
export async function embeddedEInvoice(data: Uint8Array): Promise<{ file: string; xml: string; invoice: EInvoice } | null> {
  const pdf: any = await getDocumentProxy(data.slice());
  // pdf.js: un Map (versiones recientes, el contenido se pide aparte con getAttachmentContent) o un objeto con content
  const att = await pdf.getAttachments().catch(() => null) as Map<string, { filename?: string; content?: Uint8Array | null }> | Record<string, { filename?: string; content?: Uint8Array | null }> | null;
  if (!att) return null;
  const entries = att instanceof Map ? [...att.entries()] : Object.entries(att);
  const files = entries.map(([id, a]) => ({ id, file: a?.filename || id, content: a?.content }))
    .filter(a => /\.xml$/i.test(a.file))
    .sort((a, b) => Number(!/factur-x|zugferd|xrechnung/i.test(a.file)) - Number(!/factur-x|zugferd|xrechnung/i.test(b.file)));
  for (const f of files) {
    const content = f.content || (typeof pdf.getAttachmentContent === 'function' ? await pdf.getAttachmentContent(f.id).catch(() => null) : null);
    if (!content) continue;
    const xml = xmlText(content);
    const invoice = parseEInvoice(xml);
    if (invoice) return { file: f.file, xml, invoice };
  }
  return null;
}

const fmtDate = (iso: string) => (iso ? iso.split('-').reverse().join('.') : '');
const amt = (v: number | null) => (v == null ? '' : v.toFixed(2));

// Texto legible de la factura electrónica (XRechnung sin PDF): lo usan el reconocimiento del proveedor (nombre, VAT,
// IBAN, correo), el parecido con los PDFs de sus facturas anteriores y las reglas de texto
export function eInvoiceText(e: EInvoice) {
  return [
    e.seller.name, e.seller.street, e.seller.city, e.seller.country,
    e.seller.vat && `USt-IdNr. / VAT: ${e.seller.vat}`, e.seller.taxNo && `Steuernummer: ${e.seller.taxNo}`,
    e.seller.email && `E-Mail: ${e.seller.email}`, e.seller.iban && `IBAN: ${e.seller.iban}`,
    `${e.creditNote ? 'Gutschrift / Credit Note' : 'Rechnung / Invoice'} Number: ${e.number}`,
    `Invoice Date: ${fmtDate(e.issueDate)}`, e.dueDate && `Due Date: ${fmtDate(e.dueDate)}`,
    e.deliveryDate && `Delivery Date: ${fmtDate(e.deliveryDate)}`, e.orderRef && `Order: ${e.orderRef}`,
    e.buyerReference && `Buyer Reference: ${e.buyerReference}`, e.note,
    ...e.lines.map(l => `${l.id} ${l.sellerId} ${l.name} ${l.quantity} ${l.unit} ${amt(l.price)} ${amt(l.amount)} ${e.currency}${l.vatPct != null ? ` ${l.vatPct} %` : ''}`),
    ...e.taxes.map(t => `VAT ${t.pct} % on ${amt(t.basis)}: ${amt(t.vat)} ${e.currency}`),
    `Net ${amt(e.net)} ${e.currency}`, `VAT ${amt(e.vat)} ${e.currency}`, `Total ${amt(e.total)} ${e.currency}`,
  ].filter(Boolean).join('\n');
}

// Identificadores para reconocer al proveedor, con el mismo formato que identifiers() de ocr.ts
export function eInvoiceIds(e: EInvoice) {
  const squash = (s: string) => s.replace(/[\s.\-/]/g, '').toUpperCase();
  const ids: string[] = [];
  if (/^[A-Z]{2}[A-Z0-9]{6,14}$/.test(squash(e.seller.vat))) ids.push(`vat:${squash(e.seller.vat)}`);
  if (squash(e.seller.iban).length >= 15) ids.push(`iban:${squash(e.seller.iban)}`);
  const dom = e.seller.email.split('@')[1]?.toLowerCase().split('.').slice(-2).join('.');
  if (dom) ids.push(`dom:${dom}`);
  return ids;
}

// Resumen para la página
export const eInvoiceSummary = (e: EInvoice, file?: string) => ({
  format: e.format, profile: e.profile, file: file || '', number: e.number, typeCode: e.typeCode, seller: e.seller.name,
  sellerVat: e.seller.vat, iban: e.seller.iban, orderRef: e.orderRef, buyerReference: e.buyerReference,
  lines: e.lines.map(l => ({ name: l.name, sellerId: l.sellerId, quantity: l.quantity, unit: l.unit, price: r2(l.price), amount: r2(l.amount), vatPct: l.vatPct })),
  taxes: e.taxes, net: e.net, vat: e.vat, total: e.total,
});
export type EInvoiceSummary = ReturnType<typeof eInvoiceSummary>;
