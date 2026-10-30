import { getDocumentProxy, extractText } from 'unpdf';
import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { readSetting } from '@/lib/reporting/cache';
import { attachFile, bcRequest } from '@/lib/bcWrite';

// Aduanas: el Einfuhrabgabenbescheid (PDF de ATLAS, "FMSG-SYS_TAX_ASSESSMENT-…") de cada declaración genera dos
// facturas de compra en BC, como se registran a mano:
// - ZOLL: proveedor 7300184 "ZOLL Aufschubkonto", artículo AA-00008 (Custom Duties), 1 × importe del Zoll, OHNE MWST.
// - EUST: proveedor 7300185 "EUST Aufschubkonto", artículo AA-00093 (Import Tax), dos líneas: +1 × EUSt con IVA EUST
//   (100 %, el IVA de importación deducible) y −1 × EUSt sin IVA, así la factura suma el importe de la EUSt.
// En las dos: Vendor Invoice No. = nº AT/C, fechas de registro/documento = "Erstellt am", vencimiento = Fällig (A-Frist)
// y Posting Description = Description 2 de las líneas = "<pedido N380> / <contenedor o AWB>".
// Proveedores y artículos se pueden cambiar con la setting customsConfig.

export type CustomsConfig = {
  zollVendor: string; eustVendor: string; zollItem: string; eustItem: string;
  zollVat: string; eustVat: string; noVat: string;
};
const DEFAULT_CONFIG: CustomsConfig = {
  zollVendor: '7300184', eustVendor: '7300185', zollItem: 'AA-00008', eustItem: 'AA-00093',
  zollVat: 'OHNE MWST', eustVat: 'EUST', noVat: 'OHNE MWST',
};
export const customsConfig = async () => ({ ...DEFAULT_CONFIG, ...(await readSetting<Partial<CustomsConfig>>('customsConfig', {})) });

export type Duty = { type: string; code: string; amount: number; due: string };
// Posición de la declaración (parte "Beleg"): código arancelario aplicado, descripción y nº de artículo si los ponen
export type CustomsPosition = {
  pos: number; tariff: string; description: string; articles: string[];
  packages: number | null; value: number | null; dutyRate: number | null; duty: number | null;
};
export type CustomsDoc = {
  file: string; atc: string; registration: string; lrn: string; date: string;
  orders: string[]; transport: string[]; duties: Duty[]; positions: CustomsPosition[];
  zoll: number; zollDue: string; eust: number; eustDue: string; total: number | null;
  description: string; warnings: string[];
};

const iso = (d: string) => { const m = d.match(/(\d\d)\.(\d\d)\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const amount = (s: string) => parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
const between = (t: string, from: string, to: RegExp) => {
  const i = t.indexOf(from);
  if (i < 0) return '';
  const rest = t.slice(i + from.length);
  const j = rest.search(to);
  return j < 0 ? rest : rest.slice(0, j);
};

export async function parseCustomsPdf(file: string, data: Uint8Array): Promise<CustomsDoc> {
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  const t = text.replace(/\s+/g, ' ');
  const warnings: string[] = [];

  const atc = t.match(/(AT\/C\/[\w/]+\/\d{4})/)?.[1] || '';
  const registration = t.match(/Einfuhrabgabenbescheid (\d{2}[A-Z]{2}\w{14})/)?.[1] || '';
  const lrn = t.match(/Bezugsnr\.\/LRN\*? (\S+)/)?.[1] || '';
  const date = iso(t.match(/Erstellt am (\d\d\.\d\d\.\d{4})/)?.[1] || t.match(/CUSTAX\w+ (\d\d\.\d\d\.\d{4})/)?.[1] || '');

  // Tabla "Abgaben" (la primera): Abgabenart, Buch-Schl., Betrag in EUR, … Fällig (A-Frist)
  const abgaben = between(t, 'Abgaben Abgabenart Buch-Schl.', /Gesamtabgabensumme/);
  const duties: Duty[] = [];
  for (const m of abgaben.matchAll(/([A-Za-zÄÖÜäöü]+) ([A-Z]\d{4}) ([\d.]*\d,\d{2}) .*?(\d\d\.\d\d\.\d{4})/g)) {
    duties.push({ type: m[1], code: m[2], amount: amount(m[3]), due: iso(m[4]) });
  }
  const totalMatch = t.match(/Gesamtabgabensumme in EUR ([\d.]*\d,\d{2})/);
  const total = totalMatch ? amount(totalMatch[1]) : null;
  const isEust = (d: Duty) => /^eust$/i.test(d.type);
  const zollDuties = duties.filter(d => !isEust(d)), eustDuties = duties.filter(isEust);
  const round = (v: number) => Math.round(v * 100) / 100;
  const zoll = round(zollDuties.reduce((s, d) => s + d.amount, 0));
  const eust = round(eustDuties.reduce((s, d) => s + d.amount, 0));
  if (!duties.length) warnings.push('No se ha encontrado la tabla de Abgaben (importes de Zoll y EUSt).');
  if (total != null && Math.abs(total - zoll - eust) > 0.01) warnings.push(`Zoll + EUSt (${zoll + eust}) no cuadra con la Gesamtabgabensumme (${total}).`);
  if (zollDuties.length > 1) warnings.push(`Varios conceptos van a la factura de Zoll: ${zollDuties.map(d => d.type).join(', ')}.`);

  // Pedido (Unterlagen N380) y transporte: contenedor(es) o, en aéreo, el AWB (N740/N741). Solo están en la parte "Beleg".
  const unterlagen = between(t, 'Unterlagen** Bereich Art Nummer Datum', /Beendigung SumA|Dieses Dokument/);
  const docs = Array.from(unterlagen.matchAll(/\d ([A-Z0-9]{4}) (\S+) \d\d\.\d\d\.\d{4}/g)).map(m => ({ type: m[1], no: m[2] }));
  const orders = Array.from(new Set(docs.filter(d => d.type === 'N380').map(d => d.no)));
  const containers = Array.from(new Set(between(t, 'Container**', /Unterlagen\*\*|Beendigung SumA/).match(/[A-Z]{4}\d{7}/g) || []));
  const transport = containers.length ? containers : Array.from(new Set(docs.filter(d => d.type === 'N740' || d.type === 'N741').map(d => d.no)));
  if (!orders.length) warnings.push('El PDF no trae el pedido (Unterlagen N380): escribe la descripción a mano.');
  if (!transport.length) warnings.push('El PDF no trae contenedor ni AWB: complétalo en la descripción.');
  if (!atc) warnings.push('No se ha encontrado el nº AT/C.');

  const positions = parsePositions(t);
  if (!positions.length) warnings.push('No se han encontrado las posiciones (Warennummer) en la parte "Beleg".');

  const description = [orders.join(', '), transport.join(', ')].filter(Boolean).join(' / ');
  return {
    file, atc, registration, lrn, date, orders, transport, duties, positions,
    zoll, zollDue: zollDuties[0]?.due || '', eust, eustDue: eustDuties[0]?.due || '', total, description, warnings,
  };
}

// Posiciones de la parte "Beleg für den Beteiligten" (la primera parte, el Bescheid, solo trae Warennummer y Zollwert).
// Se quitan la cabecera y el pie que se repiten en cada página, que pueden caer en medio de una posición.
function parsePositions(t: string): CustomsPosition[] {
  const start = t.indexOf('Beleg für den Beteiligten');
  if (start < 0) return [];
  const beleg = t.slice(start)
    .replace(/Hauptzollamt .{0,200}?Beleg für den Beteiligten Zollanmeldung \/ Einfuhrabgabenbescheid \S+ AT\/C\/\S+ CUSTAX\w+ \d\d\.\d\d\.\d{4}( \d{14}( [A-Z0-9]{1,6}(?= ))?)?/g, ' ')
    .replace(/ZODIAK\S* \/ ATLAS [\d.]+ \d\d\.\d\d\.\d{4} \/ \d\d:\d\d:\d\d Seite: \d+/g, ' ')
    .replace(/\s+/g, ' ');
  const parts = beleg.split(/Abschließend festgesetzt \(.?\) Nicht abschließend festgesetzt \(.?\) Position (\d+)/);
  const positions: CustomsPosition[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const b = parts[i + 1];
    const tariff = b.match(/Warennummer\*\* (\d{4} ?\d{4} ?\d{0,3})/)?.[1].replace(/ /g, '') || '';
    if (!tariff) continue;
    const description = (b.match(/Warenbezeichnung\*\* (.*?) Packstücke/)?.[1] || '').trim();
    // "Artikel Nr.: 80207/80665", "Artikel Nr: 76880,76798", "Artikel Nr.: 35597;39854" (en la descripción o en Positionszusatz)
    // Los saltos de línea parten palabras y números ("Artike l Nr.: 81 914"): se buscan en el texto sin espacios
    const articles = new Set<string>();
    for (const m of b.replace(/ /g, '').matchAll(/Artikel-?Nr\.?:?((?:\d{3,7}[\/,;]?)+)/gi)) {
      for (const a of m[1].split(/[\/,;]/)) if (a) articles.add(a);
    }
    const zoll = b.match(/ZOLLEU [\d.]*\d,\d{2} EUR ([\d.]*\d,\d+) Prozent( [A-Z0-9]+)? ([\d.]*\d,\d{2})/);
    positions.push({
      pos: Number(parts[i]), tariff, description, articles: Array.from(articles),
      packages: b.match(/Packstücke, Art\*\* (\d+)/) ? Number(b.match(/Packstücke, Art\*\* (\d+)/)![1]) : null,
      value: b.match(/Zollwert ([\d.]*\d,\d{2}) EUR/) ? amount(b.match(/Zollwert ([\d.]*\d,\d{2}) EUR/)![1]) : null,
      dutyRate: zoll ? amount(zoll[1]) : null,
      duty: zoll ? amount(zoll[3]) : null,
    });
  }
  return positions;
}

// ---------- BC ----------

const q = (s: string) => s.replace(/'/g, "''");

// Facturas ya existentes con ese nº AT/C (registradas o pendientes), para no duplicarlas
export async function existingInvoices(ctx: BcContext, atc: string, cfg: CustomsConfig) {
  const variants = [atc, `${atc}.`].map(v => `'${q(v)}'`);
  const [posted, open] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Posted_Purchase_Invoice_Excel`, {
      $filter: variants.map(v => `Vendor_Invoice_No eq ${v}`).join(' or '),
      $select: 'No,Buy_from_Vendor_No,Posting_Date',
    }), ctx.token).catch(() => [] as any[]),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/purchaseHeaders`, {
      $filter: `documentType eq 'Invoice' and (${variants.map(v => `vendorInvoiceNo eq ${v}`).join(' or ')})`,
      $select: 'no,buyFromVendorNo,postingDate',
    }), ctx.token).catch(() => [] as any[]),
  ]);
  const kind = (vendor: string) => (vendor === cfg.zollVendor ? 'zoll' : vendor === cfg.eustVendor ? 'eust' : 'otro');
  return [
    ...posted.map((r: any) => ({ no: r.No, kind: kind(r.Buy_from_Vendor_No), posted: true, date: r.Posting_Date })),
    ...open.map((r: any) => ({ no: r.no, kind: kind(r.buyFromVendorNo), posted: false, date: r.postingDate })),
  ];
}

export type InvoiceInput = { kind: 'zoll' | 'eust'; amount: number; dueDate: string };
export type CreateInput = { atc: string; date: string; description: string; invoices: InvoiceInput[]; force?: boolean };

const bc = bcRequest;

// Crea en BC (sin registrar) una factura de compra por importe. La API custom (purchaseHeaders/purchaseLines) es
// de solo lectura: cabecera y líneas por la API v2 (purchaseInvoices + purchaseInvoiceLines: Description 2 y taxCode =
// VAT Prod. Posting Group) y la Posting Description, que v2 no tiene, por la página OData purchaseDocuments (por SystemId).
// Devuelve las creadas, avisos y, si una falla, el error (las anteriores se quedan creadas)
// pdf: el Einfuhrabgabenbescheid, que se adjunta a cada factura (Attachments de BC, v2 documentAttachments)
export async function createInvoices(ctx: BcContext, input: CreateInput, cfg: CustomsConfig, pdf?: { name: string; data: Uint8Array }) {
  const created: { kind: string; no: string; amount: number }[] = [];
  const warnings: string[] = [];
  const description = input.description.substring(0, 100);
  const description2 = input.description.substring(0, 50);
  try {
    for (const inv of input.invoices) {
      if (!(inv.amount > 0)) continue;
      const zoll = inv.kind === 'zoll';
      const head = await bc('POST', `${ctx.apiBase}/purchaseInvoices`, ctx.token, {
        vendorNumber: zoll ? cfg.zollVendor : cfg.eustVendor, invoiceDate: input.date, postingDate: input.date, vendorInvoiceNumber: input.atc,
      });
      const id: string = head.id, no: string = head.number;
      const headUrl = `${ctx.apiBase}/purchaseInvoices(${id})`;
      try {
        // Vencimiento después de la fecha (la fecha de factura lo recalcula con los términos de pago del proveedor)
        if (inv.dueDate) await bc('PATCH', headUrl, ctx.token, { dueDate: inv.dueDate });
        // Al poner el proveedor, BC añade sus líneas estándar (códigos de compra estándar del proveedor: 3,90 en ZOLL,
        // ±21,64 en EUST); en las facturas registradas no están, así que se quitan antes de añadir las nuestras
        const auto = await bc('GET', `${headUrl}/purchaseInvoiceLines?$select=id`, ctx.token);
        for (const l of auto?.value || []) await bc('DELETE', `${headUrl}/purchaseInvoiceLines(${l.id})`, ctx.token);
        const lines = zoll
          ? [{ quantity: 1, vat: cfg.zollVat }]
          : [{ quantity: 1, vat: cfg.eustVat }, { quantity: -1, vat: cfg.noVat }];
        for (const l of lines) {
          await bc('POST', `${headUrl}/purchaseInvoiceLines`, ctx.token, {
            lineType: 'Item', lineObjectNumber: zoll ? cfg.zollItem : cfg.eustItem,
            quantity: l.quantity, unitCost: inv.amount, description2, taxCode: l.vat,
          });
        }
      } catch (e) {
        // No dejar una factura a medias
        await bc('DELETE', headUrl, ctx.token).catch(() => {});
        throw e;
      }
      created.push({ kind: inv.kind, no, amount: inv.amount });
      if (pdf) {
        try {
          await attachFile(ctx, id, pdf);
        } catch (e: any) {
          warnings.push(`${no}: no se ha podido adjuntar el PDF (${String(e.message).substring(0, 160)}); adjúntalo en BC.`);
        }
      }
      try {
        await bc('PATCH', `${ctx.odataCompanyBase}/purchaseDocuments(${id})`, ctx.token, { postingDescription: description });
      } catch (e: any) {
        warnings.push(`${no}: no se ha podido poner la Posting Description (${String(e.message).substring(0, 160)}); escríbela en BC.`);
      }
    }
  } catch (e: any) {
    return { created, warnings, error: e.message as string };
  }
  return { created, warnings, error: null };
}

// ---------- Códigos arancelarios ----------
// Compara el código arancelario aplicado en cada posición con el Tariff No. de la ficha de los artículos importados.
// Los artículos salen de la factura de China del pedido (Unterlagen N380 = Vendor Invoice No. de la factura con forma de
// pago CHINA TRF, mismas tres partes en cualquier orden: "MRM-254-2248" = "2248-MRM-254"), registrada o pendiente, con los
// componentes de los displays (BOM de ensamblado: el FSDU se declara desglosado en su contenido). Cada artículo se
// asigna a una posición por el "Artikel Nr." que trae la posición, si solo hay una posición a esa, y si no por descripción.

export type TariffItem = {
  no: string; description: string; qty: number; parent?: string; inInvoice: boolean; display: boolean;
  bcTariff: string; bcRate: number | null; via: 'artikel' | 'unica' | 'descripcion' | ''; score?: number;
  status: 'ok' | 'ok8' | 'distinto' | 'sin_codigo' | 'sin_ficha';
};
export type TariffPosition = CustomsPosition & { items: TariffItem[]; qty: number };
export type TariffCheck = {
  invoices: { no: string; vendorInvoiceNo: string; vendor: string; posted: boolean; paymentMethod: string }[];
  positions: TariffPosition[]; unassigned: TariffItem[]; warnings: string[];
};

const orderKey = (s: string) => {
  const letters = s.match(/[A-Z]{2,4}/i)?.[0]?.toUpperCase(), n3 = s.match(/(?<!\d)\d{3}(?!\d)/)?.[0], n4 = s.match(/(?<!\d)\d{4}(?!\d)/)?.[0];
  return letters && n3 && n4 ? `${letters}-${n3}-${n4}` : s.trim().toUpperCase();
};
const digits = (s: string) => (s || '').replace(/\D/g, '');
const baseNo = (no: string) => no.match(/^\d+/)?.[0] || no;
const inFilter = (field: string, values: string[]) => values.map(v => `${field} eq '${q(v)}'`).join(' or ');
async function chunked<T>(values: string[], size: number, fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const parts: string[][] = [];
  for (let i = 0; i < values.length; i += size) parts.push(values.slice(i, i + size));
  return (await Promise.all(parts.map(fn))).flat();
}

// Palabras de la descripción del artículo que aparecen en la de la posición (sin espacios: el PDF parte palabras)
const GENERIC = new Set(['inkee', 'top', 'fashion', 'craze', 'the', 'and', 'for', 'with', 'mit', 'und', 'der', 'die', 'das', 'pcs', 'set', 'new']);
const squash = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
function descScore(texts: string[], target: string) {
  let best = 0;
  for (const text of texts) {
    const words = Array.from(new Set(text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)))
      .filter(w => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w));
    if (!words.length) continue;
    const total = words.reduce((s, w) => s + w.length, 0);
    const found = words.filter(w => target.includes(w)).reduce((s, w) => s + w.length, 0);
    best = Math.max(best, found / total);
  }
  return best;
}

export async function checkTariffs(ctx: BcContext, orders: string[], positions: CustomsPosition[]): Promise<TariffCheck> {
  const warnings: string[] = [];
  const keys = new Set(orders.map(orderKey));
  const n4s = Array.from(new Set(orders.map(o => o.match(/(?<!\d)\d{4}(?!\d)/)?.[0]).filter(Boolean) as string[]));

  // Facturas de China del pedido: registradas y pendientes de registrar
  const [posted, open] = await Promise.all([
    chunked(n4s, 5, part => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Posted_Purchase_Invoice_Excel`, {
      $filter: part.map(n => `contains(Vendor_Invoice_No,'${n}')`).join(' or '),
      $select: 'No,Vendor_Invoice_No,Buy_from_Vendor_Name,Payment_Method_Code',
    }), ctx.token)),
    chunked(n4s, 5, part => bcFetchAll(odataUrl(`${ctx.customApiBase}/purchaseHeaders`, {
      $filter: `documentType eq 'Invoice' and (${part.map(n => `contains(vendorInvoiceNo,'${n}')`).join(' or ')})`,
      $select: 'no,vendorInvoiceNo,buyFromVendorName,paymentMethodCode',
    }), ctx.token).catch(() => [] as any[])),
  ]);
  let invoices = [
    ...posted.map((r: any) => ({ no: r.No, vendorInvoiceNo: r.Vendor_Invoice_No, vendor: r.Buy_from_Vendor_Name, posted: true, paymentMethod: r.Payment_Method_Code || '' })),
    ...open.map((r: any) => ({ no: r.no, vendorInvoiceNo: r.vendorInvoiceNo, vendor: r.buyFromVendorName, posted: false, paymentMethod: r.paymentMethodCode || '' })),
  ].filter(i => keys.has(orderKey(i.vendorInvoiceNo)));
  if (invoices.some(i => i.paymentMethod === 'CHINA TRF')) invoices = invoices.filter(i => i.paymentMethod === 'CHINA TRF');
  if (!orders.length) warnings.push('El PDF no trae el pedido (N380): solo se comparan los artículos con "Artikel Nr.".');
  else if (!invoices.length) warnings.push(`No se ha encontrado en BC la factura de China ${orders.join(', ')}: solo se comparan los artículos con "Artikel Nr.".`);
  else if (invoices.length > keys.size) warnings.push(`Hay varias facturas con el mismo nº (${invoices.map(i => `${i.no} ${i.vendorInvoiceNo}`).join(', ')}): sus cantidades se suman.`);

  // Líneas de artículo de esas facturas
  const lines = (await Promise.all(invoices.map(inv => bcFetchAll(odataUrl(inv.posted ? `${ctx.customApiBase}/purchInvLines` : `${ctx.customApiBase}/purchaseLines`, {
    $filter: `${inv.posted ? '' : "documentType eq 'Invoice' and "}documentNo eq '${q(inv.no)}' and type eq 'Item'`,
    $select: 'no,description,quantity',
  }), ctx.token)))).flat();
  const qtyByItem = new Map<string, number>();
  for (const l of lines) if (l.no) qtyByItem.set(l.no, (qtyByItem.get(l.no) || 0) + (Number(l.quantity) || 0));

  // Componentes de los displays (un nivel)
  const invoiceItems = Array.from(qtyByItem.keys());
  const bom = invoiceItems.length ? await chunked(invoiceItems, 15, part => bcFetchAll(odataUrl(`${ctx.customApiBase}/bomComponents`, {
    $filter: inFilter('parentItemNo', part), $select: 'parentItemNo,type,no,quantityPer',
  }), ctx.token)) : [];
  const displays = new Set(bom.map((c: any) => c.parentItemNo));
  const candidates = new Map<string, { no: string; qty: number; parent?: string; inInvoice: boolean }>();
  for (const [no, qty] of qtyByItem) candidates.set(no, { no, qty, inInvoice: true });
  for (const c of bom.filter((c: any) => c.type === 'Item' && c.no)) {
    const qty = (qtyByItem.get(c.parentItemNo) || 0) * (Number(c.quantityPer) || 0);
    const prev = candidates.get(c.no);
    if (prev) prev.qty += qty;
    else candidates.set(c.no, { no: c.no, qty, parent: c.parentItemNo, inInvoice: true });
  }

  // Asignación: 1) Artikel Nr. de la posición (nº exacto o nº base sin sufijo: 76613 → 76613W2X)
  const assigned = new Map<string, { pos: number; via: TariffItem['via']; score?: number }>();
  const extra = new Map<string, number>(); // nº de artículo del PDF que no está en la factura → posición
  for (const p of positions) {
    for (const a of p.articles) {
      const hits = Array.from(candidates.values()).filter(c => c.no === a || baseNo(c.no) === a);
      for (const h of hits) if (!assigned.has(h.no)) assigned.set(h.no, { pos: p.pos, via: 'artikel' });
      if (!hits.length && !extra.has(a)) extra.set(a, p.pos);
    }
  }

  // Fichas de artículo (Tariff No., % arancel y descripciones para comparar)
  const allNos = Array.from(new Set([...candidates.keys(), ...extra.keys()]));
  const cards = new Map<string, any>();
  for (const it of await chunked(allNos, 15, part => bcFetchAll(odataUrl(`${ctx.customApiBase}/items`, {
    $filter: inFilter('no', part), $select: 'no,description,descriptionInGerman,shortDescriptionInGerman,shortDescriptionInEnglish,tariffNo,tariff',
  }), ctx.token))) cards.set(it.no, it);

  // 2) una sola posición: todo a ella; 3) por descripción (la posición que más palabras del artículo contiene)
  const squashed = new Map(positions.map(p => [p.pos, squash(p.description)]));
  for (const c of candidates.values()) {
    if (assigned.has(c.no) || !positions.length) continue;
    if (positions.length === 1) { assigned.set(c.no, { pos: positions[0].pos, via: 'unica' }); continue; }
    const card = cards.get(c.no) || {};
    const texts = [card.description, card.descriptionInGerman, card.shortDescriptionInGerman, card.shortDescriptionInEnglish].filter(Boolean);
    let best = { pos: 0, score: 0 };
    for (const p of positions) {
      const score = descScore(texts, squashed.get(p.pos) || '');
      if (score > best.score) best = { pos: p.pos, score };
    }
    if (best.score >= 0.5) assigned.set(c.no, { pos: best.pos, via: 'descripcion', score: Math.round(best.score * 100) / 100 });
  }

  const toItem = (no: string, qty: number, inInvoice: boolean, parent: string | undefined, tariff: string): TariffItem => {
    const card = cards.get(no);
    const a = assigned.get(no);
    const bcTariff = digits(card?.tariffNo);
    const status: TariffItem['status'] = !card ? 'sin_ficha' : !bcTariff ? 'sin_codigo'
      : !tariff ? 'ok' : bcTariff === tariff || (bcTariff.length < tariff.length && tariff.startsWith(bcTariff)) ? 'ok'
      : bcTariff.slice(0, 8) === tariff.slice(0, 8) ? 'ok8' : 'distinto';
    return {
      no, description: card?.description || '', qty, parent, inInvoice, display: displays.has(no), bcTariff,
      bcRate: card?.tariff != null && card.tariff !== '' ? Number(card.tariff) : null, via: a?.via || '', score: a?.score, status,
    };
  };
  const result: TariffPosition[] = positions.map(p => ({ ...p, items: [], qty: 0 }));
  const byPos = new Map(result.map(p => [p.pos, p]));
  const unassigned: TariffItem[] = [];
  for (const c of candidates.values()) {
    const a = assigned.get(c.no);
    const p = a && byPos.get(a.pos);
    if (p) { p.items.push(toItem(c.no, c.qty, true, c.parent, p.tariff)); p.qty += c.qty; }
    else unassigned.push(toItem(c.no, c.qty, true, c.parent, ''));
  }
  for (const [no, pos] of extra) {
    const p = byPos.get(pos)!;
    assigned.set(no, { pos, via: 'artikel' });
    p.items.push(toItem(no, 0, false, undefined, p.tariff));
  }
  return { invoices, positions: result, unassigned, warnings };
}
