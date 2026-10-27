import { getDocumentProxy, extractText } from 'unpdf';
import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { readSetting } from '@/lib/reporting/cache';

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
export type CustomsDoc = {
  file: string; atc: string; registration: string; lrn: string; date: string;
  orders: string[]; transport: string[]; duties: Duty[];
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

  const description = [orders.join(', '), transport.join(', ')].filter(Boolean).join(' / ');
  return {
    file, atc, registration, lrn, date, orders, transport, duties,
    zoll, zollDue: zollDuties[0]?.due || '', eust, eustDue: eustDuties[0]?.due || '', total, description, warnings,
  };
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

async function bc(method: string, url: string, token: string, body?: any) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(method === 'PATCH' || method === 'DELETE' ? { 'If-Match': '*' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* texto */ }
    throw new Error(`BC ${method} ${url.split('/').pop()?.split('?')[0]}: ${msg.substring(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Crea en BC (sin registrar) una factura de compra por importe. La API custom (purchaseHeaders/purchaseLines) es
// de solo lectura: cabecera y líneas por la API v2 (purchaseInvoices + purchaseInvoiceLines: Description 2 y taxCode =
// VAT Prod. Posting Group) y la Posting Description, que v2 no tiene, por la página OData purchaseDocuments (por SystemId).
// Devuelve las creadas, avisos y, si una falla, el error (las anteriores se quedan creadas)
export async function createInvoices(ctx: BcContext, input: CreateInput, cfg: CustomsConfig) {
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
        const lines = zoll
          ? [{ quantity: 1, vat: cfg.zollVat }]
          : [{ quantity: 1, vat: cfg.eustVat }, { quantity: -1, vat: cfg.noVat }];
        for (const l of lines) {
          await bc('POST', `${headUrl}/purchaseInvoiceLines`, ctx.token, {
            lineType: 'Item', lineObjectNumber: zoll ? cfg.zollItem : cfg.eustItem,
            quantity: l.quantity, directUnitCost: inv.amount, description2, taxCode: l.vat,
          });
        }
      } catch (e) {
        // No dejar una factura a medias
        await bc('DELETE', headUrl, ctx.token).catch(() => {});
        throw e;
      }
      created.push({ kind: inv.kind, no, amount: inv.amount });
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
