import { getDocumentProxy, extractText } from 'unpdf';
import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { attachFile, bcRequest } from '@/lib/bcWrite';
import { cached, readSetting, writeSetting, HOUR } from '@/lib/reporting/cache';
import { companyCurrency } from '@/lib/royalties';
import { embeddedEInvoice, eInvoiceIds, eInvoiceSummary, eInvoiceText, looksXml, parseEInvoice, xmlText, type EInvoice, type EInvoiceSummary } from '@/lib/einvoice';

// OCR de facturas de compra: del PDF de un proveedor a una Purchase Invoice sin registrar en BC.
// Sin IA: reglas sobre el texto y las facturas ya registradas del proveedor.
// 1. Texto del PDF con unpdf. Un escaneo o una captura sin texto lo lee la página con Tesseract en el navegador y lo
//    manda como "text" (ocrText).
// 2. Proveedor: identificadores del PDF (NIF/VAT, IBAN, dominio de correo/web) aprendidos de las facturas ya creadas
//    desde aquí (setting ocr:hints:<empresa>), el VAT y el correo de la ficha del proveedor, las palabras de su nombre,
//    la divisa y cuántas facturas suyas hay en el último año (los habituales primero).
// 3. Sus facturas registradas más recientes (líneas y el texto del PDF adjunto) son el modelo: ver propose().

export type OcrLine = {
  lineType: string; number: string; description: string; description2: string;
  quantity: number; unitCost: number; taxCode: string;
};
export type VendorCandidate = { number: string; name: string; currency: string; score: number; reasons: string[]; invoices: number };
export type HistoryInvoice = {
  number: string; vendorInvoiceNumber: string; invoiceDate: string; postingDate: string; dueDate: string;
  currency: string; net: number; total: number; postingDescription: string; lines: OcrLine[];
};
export type OcrSuggestion = {
  documentType: 'invoice' | 'credit_note'; invoiceNo: string; invoiceDate: string; postingDate: string; dueDate: string; postingDescription: string;
  currency: string; net: number | null; vat: number | null; total: number | null; lines: OcrLine[]; comment: string;
  itemFromPdf?: { number: string; model: string; modelDescription: string }; vatBusPostingGroup?: string;
};
export type OcrResult = {
  file: string; scanned: boolean; ocr: boolean; currency: string; ids: string[]; vatRates: Record<string, number>;
  candidates: VendorCandidate[]; vendor: VendorCandidate | null; history: HistoryInvoice[];
  suggestion: OcrSuggestion | null; existing: { no: string; status: string }[]; warnings: string[];
  einvoice?: EInvoiceSummary | null;
};

const q = (s: string) => s.replace(/'/g, "''");
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss');
const squash = (s: string) => s.replace(/[\s.\-/]/g, '').toUpperCase();

export async function pdfText(data: Uint8Array) {
  const { text } = await extractText(await getDocumentProxy(data), { mergePages: true });
  return String(text).replace(/[ \t]+/g, ' ').trim();
}

// ---------- Identificadores del PDF ----------
const VAT_RE = /\b(ATU ?\d{8}|BE ?0?\d{9}|CHE[- ]?\d{3}\.?\d{3}\.?\d{3}|CZ ?\d{8,10}|DE ?\d{3} ?\d{3} ?\d{3}|DK ?\d{8}|ES ?[A-Z0-9]\d{7}[A-Z0-9]|FR ?[A-Z0-9]{2} ?\d{9}|GB ?\d{3} ?\d{4} ?\d{2}(?:\d{3})?|IE ?\d[A-Z0-9]\d{5}[A-Z]{1,2}|IT ?\d{11}|LU ?\d{8}|NL ?\d{9}B\d{2}|PL ?\d{10}|PT ?\d{9}|SE ?\d{12})\b/g;
const IBAN_RE = /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?)\b/g;
const MAIL_RE = /[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})/gi;
const WEB_RE = /\bwww\.((?:[\w-]+\.)+[a-z]{2,})/gi;
// Dominios que no identifican a un proveedor
const GENERIC_DOMAINS = /^(gmail|googlemail|outlook|hotmail|yahoo|gmx|web|icloud|live|t-online|craze-group|craze)\./i;

// VAT, IBAN y dominios (correo/web) que aparecen en el texto, normalizados: "vat:DE814584193", "iban:…", "dom:fms-logistics.com"
export function identifiers(text: string) {
  const ids = new Set<string>();
  for (const m of text.matchAll(VAT_RE)) ids.add(`vat:${squash(m[1])}`);
  for (const m of text.matchAll(IBAN_RE)) {
    const iban = squash(m[1]);
    if (iban.length >= 15 && iban.length <= 34) ids.add(`iban:${iban}`);
  }
  for (const re of [MAIL_RE, WEB_RE]) {
    for (const m of text.matchAll(re)) {
      const dom = m[1].toLowerCase().split('.').slice(-2).join('.');
      if (!GENERIC_DOMAINS.test(dom)) ids.add(`dom:${dom}`);
    }
  }
  return [...ids];
}

const ISO_CURRENCIES = ['AED', 'AUD', 'BGN', 'BRL', 'CAD', 'CLP', 'COP', 'CZK', 'DKK', 'EGP', 'HKD', 'HRK', 'HUF', 'IDR', 'ILS', 'INR', 'ISK',
  'JPY', 'KRW', 'KWD', 'MAD', 'MOP', 'MXN', 'MYR', 'NOK', 'NZD', 'PEN', 'PHP', 'PKR', 'PLN', 'QAR', 'RON', 'RSD', 'SAR', 'SEK', 'SGD', 'THB',
  'TND', 'TRY', 'TWD', 'UAH', 'VND', 'ZAR'];

// Divisa del documento: la que más aparece
export function detectCurrency(text: string) {
  const count = (re: RegExp) => (text.match(re) || []).length;
  const scores: [string, number][] = [
    ['EUR', count(/\bEUR\b|€/g)], ['USD', count(/\bUSD\b|US\$/g)], ['GBP', count(/\bGBP\b|£/g)],
    ['CHF', count(/\bCHF\b/g)], ['CNY', count(/\bCNY\b|\bRMB\b/g)],
    // Las demás (MOP, AED, HKD…): solo junto a un importe ("71,00 MOP", "MOP 71.00"), para no confundir palabras
    ...ISO_CURRENCIES.map(c => [c, count(new RegExp(`\\d[.,]\\d{2}\\s?${c}\\b|\\b${c}\\s?\\d[\\d.,]*[.,]\\d{2}`, 'g'))] as [string, number]),
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] ? scores[0][0] : '';
}

// ---------- Proveedores ----------
type VendorRow = { number: string; name: string; email: string; website: string; vat: string; currency: string; blocked: boolean; invoices: number };

// Proveedores de la empresa con su nº de facturas del último año y nuestro propio VAT (caché 6 h)
async function vendorIndex(ctx: BcContext): Promise<{ vendors: VendorRow[]; ownVat: string }> {
  return cached(`ocr:vendors2:${ctx.companyName}`, 6 * HOUR, async () => {
    const since = new Date(Date.now() - 365 * 24 * HOUR).toISOString().substring(0, 10);
    const [vendors, invoices, info] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, { $select: 'number,displayName,email,website,taxRegistrationNumber,currencyCode,blocked' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.apiBase}/purchaseInvoices`, { $filter: `postingDate ge ${since}`, $select: 'vendorNumber' }), ctx.token).catch(() => []),
      bcFetchAll(odataUrl(`${ctx.apiBase}/companyInformation`, { $select: 'taxRegistrationNumber' }), ctx.token).catch(() => []),
    ]);
    const count = new Map<string, number>();
    for (const i of invoices) count.set(i.vendorNumber, (count.get(i.vendorNumber) || 0) + 1);
    const rows = vendors.map((v: any) => ({
      number: v.number, name: v.displayName || '', email: v.email || '', website: v.website || '', vat: squash(v.taxRegistrationNumber || ''),
      currency: v.currencyCode || '', blocked: !!v.blocked && v.blocked.trim?.() !== '' && v.blocked !== '_x0020_', invoices: count.get(v.number) || 0,
    }));
    return { vendors: rows, ownVat: squash(info[0]?.taxRegistrationNumber || '') };
  });
}

// Palabras que no distinguen a un proveedor
const STOP = new Set(['gmbh', 'co', 'kg', 'ltd', 'limited', 'llc', 'inc', 'sl', 'slu', 'sa', 'sas', 'sarl', 'srl', 'ag', 'se', 'bv', 'nv', 'ab', 'oy', 'as',
  'the', 'and', 'und', 'de', 'del', 'la', 'el', 'les', 'der', 'die', 'das', 'en', 'et', 'of', 'for', 'mbh', 'ohg', 'ug', 'plc', 'spa',
  'eur', 'usd', 'gbp', 'chf', 'cny', 'rmb', 'sepa', 'lastschrift', 'credit', 'card', 'paypal', 'kreditkarte', 'craze']);
const nameWords = (name: string) => norm(name.replace(/\([^)]*\)/g, ' ')).split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !STOP.has(w));
const vendorCurrency = (v: VendorRow) => v.currency || v.name.match(/\((USD|EUR|GBP|CHF|CNY|AED)\)/i)?.[1]?.toUpperCase() || '';

type Hints = Record<string, string | null>;
const hintsKey = (company: string) => `ocr:hints:${company}`;

export async function matchVendors(ctx: BcContext, text: string, ids: string[], currency: string): Promise<VendorCandidate[]> {
  const [{ vendors, ownVat }, hints] = await Promise.all([vendorIndex(ctx), readSetting<Hints>(hintsKey(ctx.companyName), {})]);
  // Nuestro VAT sale en todas las facturas: no identifica al proveedor
  ids = ids.filter(id => id !== `vat:${ownVat}`);
  const words = new Set(norm(text).split(/[^a-z0-9]+/));
  const flat = norm(text).replace(/[^a-z0-9]+/g, ' ');
  const lcy = companyCurrency(ctx.companyName);
  const out: VendorCandidate[] = [];
  for (const v of vendors) {
    let score = 0;
    const reasons: string[] = [];
    // Identificadores ya asociados a este proveedor al crear facturas desde el OCR
    const learnt = ids.filter(id => hints[id] === v.number);
    if (learnt.length) { score += 5; reasons.push(`recognised by ${learnt.map(i => i.split(':')[1]).join(', ')} (previous invoices)`); }
    if (v.vat.length >= 8 && ids.includes(`vat:${v.vat}`)) { score += 4; reasons.push(`VAT ${v.vat}`); }
    const doms = [v.email.split('@')[1], v.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]]
      .filter(Boolean).map(d => d!.toLowerCase().split('.').slice(-2).join('.'));
    const dom = doms.find(d => !GENERIC_DOMAINS.test(d) && ids.includes(`dom:${d}`));
    if (dom) { score += 3; reasons.push(`domain ${dom}`); }
    const nw = nameWords(v.name);
    const hit = nw.filter(w => words.has(w));
    if (hit.length && hit.some(w => w.length >= 4)) {
      // Más palabras coincidentes = nombre más concreto ("Amazon EU SARL, Niederlassung Deutschland" frente a "Amazon EU SARL")
      score += 3 * hit.length / nw.length + 0.5 * (hit.length - 1);
      const full = norm(v.name.replace(/\([^)]*\)/g, ' ')).replace(/[^a-z0-9]+/g, ' ').trim();
      if (full.split(' ').length > 1 && flat.includes(full)) score += 1;
      reasons.push(`name (${hit.length}/${nw.length} words)`);
    }
    if (score < 1) continue;
    // Craze como proveedor (intercompañía) solo si lo identifican VAT/IBAN/dominio: el PDF siempre lleva nuestro nombre
    if (/^craze/i.test(v.name) && !learnt.length && !dom && !reasons.some(r => r.startsWith('VAT'))) continue;
    const cur = vendorCurrency(v) || lcy;
    if (currency) {
      if (cur === currency) { score += 0.5; } else { score -= 1; reasons.push(`currency ${cur} ≠ PDF currency ${currency}`); }
    }
    if (v.blocked) { score -= 2; reasons.push('blocked'); }
    score += Math.min(0.6, Math.log10(1 + v.invoices) / 4);
    out.push({ number: v.number, name: v.name, currency: cur, score: Math.round(score * 100) / 100, reasons, invoices: v.invoices });
  }
  return out.sort((a, b) => b.score - a.score || b.invoices - a.invoices).slice(0, 8);
}

// Guarda los identificadores del PDF con el proveedor elegido. Uno que ya apunte a otro proveedor (p. ej. nuestro
// propio VAT, que sale en todas las facturas) deja de servir (null)
export async function learnVendor(company: string, ids: string[], vendor: string) {
  if (!ids.length || !vendor) return;
  const hints = await readSetting<Hints>(hintsKey(company), {});
  for (const id of ids) hints[id] = id in hints && hints[id] !== vendor ? null : vendor;
  await writeSetting(hintsKey(company), hints);
}

export async function vendorByNumber(ctx: BcContext, number: string): Promise<VendorCandidate | null> {
  const v = (await vendorIndex(ctx)).vendors.find(x => x.number.toLowerCase() === number.trim().toLowerCase());
  return v ? { number: v.number, name: v.name, currency: vendorCurrency(v) || companyCurrency(ctx.companyName), score: 0, reasons: ['chosen manually'], invoices: v.invoices } : null;
}

// Búsqueda por nº o nombre para elegir el proveedor a mano
export async function searchVendors(ctx: BcContext, term: string) {
  const t = norm(term.trim());
  if (t.length < 2) return [];
  return (await vendorIndex(ctx)).vendors
    .filter(v => v.number.toLowerCase().includes(t) || norm(v.name).includes(t))
    .sort((a, b) => b.invoices - a.invoices)
    .slice(0, 20)
    .map(v => ({ number: v.number, name: v.name, currency: vendorCurrency(v) || companyCurrency(ctx.companyName), invoices: v.invoices }));
}

// ---------- Facturas anteriores del proveedor ----------
// Línea registrada (custom purchInvLines = Posted Purchase Invoice Lines) en el formato de la API v2 para crearla:
// tipo v2 y taxCode = VAT Prod. Posting Group
const LINE_TYPE: Record<string, string> = { Item: 'Item', G_x002F_L_x0020_Account: 'Account', 'G/L Account': 'Account', Resource: 'Resource', Fixed_x0020_Asset: 'Fixed Asset', 'Fixed Asset': 'Fixed Asset', Charge_x0020__x0028_Item_x0029_: 'Charge', 'Charge (Item)': 'Charge', _x0020_: 'Comment', '': 'Comment' };
const toLine = (l: any): OcrLine => ({
  lineType: LINE_TYPE[l.type] ?? String(l.type), number: l.no || '', description: l.description || '', description2: l.description2 || '',
  quantity: l.quantity, unitCost: l.directUnitCost ?? 0, taxCode: l.vatProdPostingGroup || '',
});

async function bcGet(ctx: BcContext, url: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`BC ${res.status}: ${(await res.text()).substring(0, 200)}`);
  return res.json();
}

// Últimas facturas registradas del proveedor con sus líneas, y el texto del PDF adjunto de hasta 3 con líneas distintas
export async function vendorHistory(ctx: BcContext, vendor: string) {
  const data = await bcGet(ctx, odataUrl(`${ctx.apiBase}/purchaseInvoices`, {
    $filter: `vendorNumber eq '${q(vendor)}' and status ne 'Draft' and status ne 'Canceled'`,
    $orderby: 'postingDate desc', $top: '30',
  }));
  // La más reciente primero por nº de documento (BC lo numera al registrar; la fecha de registro puede ser anterior):
  // la forma de registrarlas va mejorando y la última es el modelo
  const raw: any[] = (data.value || []).sort((a: any, b: any) => b.number.localeCompare(a.number, undefined, { numeric: true })).slice(0, 15);
  if (!raw.length) return { history: [] as HistoryInvoice[], examples: [] as { number: string; text: string }[] };
  // Líneas de Posted Purchase Invoice Lines y Posting Description = descripción del movimiento de proveedor
  // (la cabecera registrada no la publica)
  const oldest = raw.map(i => i.postingDate as string).sort()[0];
  const [lines, entries] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.customApiBase}/purchInvLines`, {
      $filter: raw.map(i => `documentNo eq '${q(i.number)}'`).join(' or '),
      $select: 'documentNo,lineNo,type,no,description,description2,quantity,directUnitCost,vatProdPostingGroup',
    }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, {
      $filter: `vendorNo eq '${q(vendor)}' and documentType eq 'Invoice' and postingDate ge ${oldest}`, $select: 'documentNo,description',
    }), ctx.token).catch(() => []),
  ]);
  const linesBy = new Map<string, any[]>();
  for (const l of lines.sort((a: any, b: any) => a.lineNo - b.lineNo)) linesBy.set(l.documentNo, [...(linesBy.get(l.documentNo) || []), l]);
  const descBy = new Map<string, string>(entries.map((e: any) => [e.documentNo, String(e.description || '').replace(/[\x00-\x1f]/g, '')]));
  const history: HistoryInvoice[] = raw.map(i => ({
    number: i.number, vendorInvoiceNumber: i.vendorInvoiceNumber, invoiceDate: i.invoiceDate, postingDate: i.postingDate, dueDate: i.dueDate,
    currency: i.currencyCode, net: i.totalAmountExcludingTax, total: i.totalAmountIncludingTax, postingDescription: descBy.get(i.number) || '',
    lines: (linesBy.get(i.number) || []).map(toLine).filter((l: OcrLine) => l.lineType !== 'Comment' || l.description),
  }));
  // Ejemplos con PDF: uno por cada combinación distinta de artículos/cuentas, de las más recientes
  const seen = new Set<string>();
  const picks = raw.filter(i => {
    const sig = (linesBy.get(i.number) || []).map((l: any) => l.no).sort().join('|');
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  }).slice(0, 5);
  const examples = (await Promise.all(picks.map(async i => {
    try {
      const atts = (await bcGet(ctx, odataUrl(`${ctx.apiBase}/documentAttachments`, {
        $filter: `parentType eq 'Purchase Invoice' and parentId eq ${i.id}`, $select: 'id,fileName',
      }))).value || [];
      const pdf = atts.find((a: any) => /\.pdf$/i.test(a.fileName));
      if (!pdf) return null;
      const res = await fetch(`${ctx.apiBase}/documentAttachments(${pdf.id})/attachmentContent`, { headers: { Authorization: `Bearer ${ctx.token}` } });
      if (!res.ok) return null;
      const text = await pdfText(new Uint8Array(await res.arrayBuffer()));
      return text ? { number: i.number as string, text: text.substring(0, 20000) } : null;
    } catch {
      return null;
    }
  }))).filter((e): e is { number: string; text: string } => !!e);
  return { history, examples };
}

// Facturas del proveedor con ese Vendor Invoice No. (registradas o pendientes), también con un punto al final
export async function existingFor(ctx: BcContext, vendor: string, invoiceNo: string, credit = false) {
  if (!vendor || !invoiceNo) return [];
  const field = credit ? 'vendorCreditMemoNumber' : 'vendorInvoiceNumber';
  const variants = [invoiceNo, `${invoiceNo}.`].map(v => `${field} eq '${q(v)}'`).join(' or ');
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/${credit ? 'purchaseCreditMemos' : 'purchaseInvoices'}`, {
    $filter: `vendorNumber eq '${q(vendor)}' and (${variants})`, $select: 'number,status',
  }), ctx.token).catch(() => []);
  return rows.filter((r: any) => r.status !== 'Canceled').map((r: any) => ({ no: r.number as string, status: r.status as string }));
}

// Abono (Purchase Credit Memo) y no factura: el documento se llama así (Gutschrift, Storno-Rechnung, Rechnungskorrektur,
// Credit Note/Memo, Nota de crédito, Factura rectificativa, Avoir, Abono) o su total es negativo. Las palabras que también
// aparecen en facturas normales (Gutschrift de un pago, "abono" de una cuenta) solo cuentan si el documento no se
// presenta antes como factura.
const STRONG_CREDIT = /\b(storno[\s-]*rechnung|stornorechnung|storno|rechnungskorrektur|korrekturrechnung|credit[\s-]*memo|factura rectificativa|nota de cr[eé]dito)\b/i;
const WEAK_CREDIT = /\b(credit note|gutschrift|avoir|abono)\b/i;
// Total negativo: una línea de total (no de descuento) con el importe en negativo
const TOTAL_LINE = /(rechnungsbetrag|gesamtbetrag|endbetrag|brutto|grand total|total amount|amount due|invoice total|importe total|total factura)[^\n\d-]{0,40}-\s?\d/i;
const negativeTotal = (text: string) => text.split(/\n/).some(l => TOTAL_LINE.test(l) && !/rabatt|discount|skonto|nachlass|descuento|remise/i.test(l));
export function isCreditNote(text: string) {
  const head = text.slice(0, 3000);
  if (STRONG_CREDIT.test(head) || negativeTotal(text)) return true;
  return WEAK_CREDIT.test(text.slice(0, 1500)) && !/\b(invoice|rechnung|factura|facture)\b/i.test(text.slice(0, 300));
}

// ---------- Propuesta sin IA ----------
// Modelo = la factura anterior cuyo PDF más se parece al nuevo (entre las más recientes con líneas distintas; la más
// reciente si no hay PDFs). De ella salen las líneas, y los datos variables (nº de factura, fecha, vencimiento,
// referencias de Description 2 / Posting Description) se leen en el PDF nuevo en el mismo sitio que en el suyo.
// Importes: solo los totales (sin IVA y con IVA), por coherencia neto + IVA = total.

export type Example = { number: string; text: string };
const flat = (t: string) => t.replace(/\s+/g, ' ');

const MONTHS: Record<string, string> = {
  jan: '01', ene: '01', feb: '02', mar: '03', mär: '03', mae: '03', apr: '04', abr: '04', may: '05', mai: '05', jun: '06', jul: '07',
  aug: '08', ago: '08', sep: '09', oct: '10', okt: '10', nov: '11', dec: '12', dez: '12', dic: '12',
};
// Fechas: 2026-10-24, 24.10.2026, 24/10/26, 24-OCT-26, 24 Aug 2026, Aug 24, 2026
const DATE_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{1,2}[ -][A-Za-zä]{3,9}\.?[ -]\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}/g;
function parseDate(s: string) {
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[ -]([A-Za-zä]{3})[A-Za-zä]*\.?[ -](\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}),? (\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, '0')}`;
  return '';
}
// Lo que parece una fecha y no lo es ("105,97 AED 25.09.26": "97 AED 25") no se come la fecha de detrás
function dates(t: string) {
  const out: { index: number; raw: string; iso: string }[] = [];
  const re = new RegExp(DATE_RE.source, 'g');
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const iso = parseDate(m[0]);
    if (iso) out.push({ index: m.index, raw: m[0], iso });
    else re.lastIndex = m.index + 1;
  }
  return out;
}

// Texto que precede a la posición i (la etiqueta: "Invoice Number:", "Your reference:"…)
const before = (t: string, i: number) => t.slice(Math.max(0, i - 30), i).replace(/^\S*\s/, '');
// Valor con la misma etiqueta en el texto nuevo: prueba la etiqueta entera y luego sus finales (≥ 6 caracteres)
function sameSpot(text: string, label: string, read: (rest: string) => string | null) {
  for (let n = label.length; n >= 4; n--) {
    const l = label.slice(-n);
    if (!/[A-Za-z]{3}/.test(l)) break;
    for (let i = text.indexOf(l); i >= 0; i = text.indexOf(l, i + 1)) {
      const v = read(text.slice(i + l.length).replace(/^\s+/, ''));
      if (v) return v;
    }
  }
  return null;
}
// Patrón con la forma de un valor: letras → letras, dígitos → dígitos, separadores tal cual
const shapeOf = (v: string, exact = false) => new RegExp('^' + v.replace(/[A-Za-z]+|\d+|[^A-Za-z\d]/g, p =>
  /^[A-Za-z]/.test(p) ? (exact ? `[A-Za-z]{${p.length}}` : '[A-Za-z]+') : /^\d/.test(p) ? (exact ? `\\d{${p.length}}` : '\\d+') : `\\${p}`) + '(?![A-Za-z\\d])');

// Tablas que el PDF saca por columnas (WIRmachenDRUCK: "Bestelldatum: Rechnungsdatum: Referenz: 400209-1023 …
// 28.10.2026 02.11.2026"): la fecha de la etiqueta es la que ocupa entre las fechas de los valores el mismo puesto que
// ella entre las etiquetas de fecha
const LABELS = '(?:[A-Za-zÄÖÜäöüß][\\wÄÖÜäöüß.\\-]*:\\s+)';
function columnDate(t: string, start: number, end: number) {
  const next = t.slice(end).match(new RegExp(`^${LABELS}+`))?.[0];
  if (!next) return '';
  const prev = t.slice(Math.max(0, start - 300), start).match(new RegExp(`${LABELS}*$`))![0];
  const j = (prev.match(/(?:datum|date|fecha)[^:\s]*:/gi) || []).length;
  return dates(t.slice(end + next.length, end + next.length + 200))[j]?.iso || '';
}

// El valor como palabra entera del texto
const token = (v: string) => new RegExp(`(?<![A-Za-z\\d])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z\\d])`);

// Etiquetas genéricas, si no hay PDF modelo o no se encuentra su etiqueta
export function guessHeader(t: string) {
  const invoiceNo = (t.match(/(?:Invoice|Rechnungs?|Debit Note|Credit Note|Gutschrift|Factura|Facture|Beleg)[ -]?(?:Number|No\.?|Nr\.?|nummer|n[º°o]\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]{3,})/i)
    // Notas de débito de Amazon: "Numéro Note de Débit:", "Número de Nota de Débito:", "Numero Nota di Debito:"
    || t.match(/N[uú]m[eé]ro (?:de (?:la )?)?Not[ae] (?:de |di )D[eéè]bit[oa]?\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]{3,})/i)
    // Italiano: "Numero Fattura: 2222652428" (Amazon EU SARL, Succursale Italiana), "Fattura n. 123"
    || t.match(/(?:Numero (?:della )?Fattura|N\. ?Fattura|Fattura (?:n\.?|nr\.?|numero))\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]{3,})/i))?.[1]?.replace(/\.$/, '') || '';
  let invoiceDate = '';
  // Las etiquetas concretas, en todas sus apariciones (la primera puede ser texto: "der Monat des Rechnungsdatums");
  // la genérica, solo la primera
  const specific = /(?:Invoice Date|Debit Note Date|Rechnungsdatum|Belegdatum|Fecha(?: de)? (?:la )?factura|Date de (?:la )?facture|Date (?:de la )?Note de D[ée]bit|Fecha (?:de (?:la )?)?Nota de D[ée]bito|Data (?:della )?Nota di Debito|Data (?:della )?fattura)(?![A-Za-zäöü])\s*[:;]?\s*/gi;
  for (const m of [...t.matchAll(specific), ...[t.match(/(?:Datum|Date|Fecha)\s*:?\s*/i)].filter(x => x)]) {
    const end = m!.index! + m![0].length;
    invoiceDate = columnDate(t, m!.index!, end) || dates(t.slice(end, end + 25))[0]?.iso || '';
    if (invoiceDate) break;
  }
  return { invoiceNo, invoiceDate };
}

// Importes con 2 decimales ("1,454.67", "1.454,67", "4150.00"); los separadores de miles no pueden ser espacios
// (en las tablas "1 108.80" es cantidad + precio)
function amounts(t: string) {
  const out: number[] = [];
  for (const m of t.matchAll(/(?<![\d.,])\d{1,3}(?:([.,'])\d{3})*[.,]\d{2}(?![\d.,]?\d)|(?<![\d.,])\d+[.,]\d{2}(?![\d.,]?\d)/g)) {
    const s = m[0], dec = s.length - 3;
    const v = parseFloat(s.slice(0, dec).replace(/[.,']/g, '') + '.' + s.slice(dec + 1));
    if (isFinite(v)) out.push(Math.round(v * 100) / 100);
  }
  return out;
}
const RATES = [0.19, 0.07, 0.21, 0.2, 0.22, 0.1, 0.081, 0.077, 0.05, 0.16];
const r2 = (v: number) => Math.round(v * 100) / 100;

// Líneas con IVA del modelo y su tipo: el subconjunto de líneas cuyo importe × tipo = IVA de la factura (p. ej.
// Meyer's Sohn GmbH: 1.816,80 con IVA (KZ. 66.2) + 45,00 OHNE MWST). Sin IVA: ninguna línea con IVA
function modelSplit(model: HistoryInvoice) {
  const priced = model.lines.map((l, i) => ({ i, amount: l.quantity * l.unitCost, comment: l.lineType === 'Comment' })).filter(l => !l.comment);
  const vat = r2(model.total - model.net);
  if (Math.abs(vat) < 0.01) return { rate: 0, taxed: new Set<number>() };
  if (priced.length <= 8) {
    for (const rate of RATES) {
      for (let mask = (1 << priced.length) - 1; mask > 0; mask--) {
        const sum = priced.filter((_, k) => mask & (1 << k)).reduce((x, l) => x + l.amount, 0);
        if (Math.abs(sum * rate - vat) <= 0.02) return { rate, taxed: new Set(priced.filter((_, k) => mask & (1 << k)).map(l => l.i)) };
      }
    }
  }
  return { rate: model.net ? Math.round((vat / model.net) * 1000) / 1000 : 0, taxed: new Set(priced.map(l => l.i)) };
}

// Totales: base con IVA + IVA (+ parte exenta) = total, y los tres (o cuatro) importes aparecen en el texto; el tipo
// del modelo primero. Si el modelo no lleva IVA (o el PDF dice que está exento), neto = total = el importe que más se
// repite entre los mayores
// rate: el % de IVA de los grupos de IVA de las líneas (VAT Posting Setup), si se sabe: solo ese (0 = sin IVA)
export function totals(t: string, model: HistoryInvoice | undefined, rate?: number) {
  const list = amounts(t);
  const set = [...new Set(list)].filter(v => v > 0).sort((a, b) => b - a);
  const near = (v: number) => set.find(x => Math.abs(x - v) <= Math.max(0.02, v * 0.0002));
  const split = model ? modelSplit(model) : null;
  const taxFree = rate != null ? rate === 0 : split?.rate === 0 || /tax ?free|steuerfrei|exento|reverse charge|nicht steuerbar|0[.,]00 ?%/i.test(t);
  const rates = rate != null ? (rate ? [rate] : []) : [...new Set([...(split?.rate ? [split.rate] : []), ...RATES])];
  // Sin parte exenta primero; luego con una parte exenta que también aparezca ("MwSt frei")
  for (const withFree of [false, true]) {
    for (const r of rates) {
      for (const taxable of set) {
        const vat = near(r2(taxable * r));
        if (vat == null || vat === taxable) continue;
        if (!withFree) {
          const total = near(r2(taxable + vat));
          if (total != null && total !== vat) return { net: taxable, vat, total, taxable, free: 0 };
          continue;
        }
        for (const free of set) {
          if (free === taxable || free === vat) continue;
          const total = near(r2(taxable + vat + free));
          if (total != null && total !== taxable && total !== free) return { net: r2(taxable + free), vat, total, taxable, free };
        }
      }
    }
  }
  if (taxFree && set.length) {
    const top = set.slice(0, 5);
    const count = (v: number) => list.filter(x => x === v).length;
    const best = top.reduce((a, b) => (count(b) > count(a) ? b : a), top[0]);
    return { net: best, vat: 0, total: best, taxable: 0, free: best };
  }
  return { net: null, vat: null, total: null, taxable: null, free: null };
}

// Parecido entre dos textos: palabras en común (Jaccard)
function similarity(a: string, b: string) {
  const words = (t: string) => new Set(norm(t).split(/[^a-z]+/).filter(w => w.length >= 3));
  const A = words(a), B = words(b);
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / (A.size + B.size - common || 1);
}

// Adapta un texto del modelo (Description 2, Posting Description…) al PDF nuevo: cada referencia del modelo que salía
// en su PDF se busca en el PDF nuevo junto a la misma etiqueta, o con exactamente la misma forma si solo hay una.
// Lo que no estaba en su PDF (textos fijos) se deja igual. ok = false si alguna referencia no se ha encontrado
function adapt(value: string, oldText: string, newText: string) {
  let ok = true;
  const out = value.replace(/[A-Za-z0-9][A-Za-z0-9\-\/.]*\d[A-Za-z0-9\-\/.]*/g, token => {
    const t = token.replace(/[.\/-]+$/, '');
    if (t.length < 5) return token;
    const i = oldText.indexOf(t);
    if (i < 0) return token;
    const found = sameSpot(newText, before(oldText, i), rest => rest.match(shapeOf(t))?.[0] ?? null);
    if (found) return token.replace(t, found);
    const exact = shapeOf(t, true);
    const same = [...new Set(newText.split(/\s+/).map(w => w.replace(/[,;:]+$/, '')).filter(w => exact.test(w)))];
    if (same.length === 1) return token.replace(t, same[0]);
    ok = false;
    return token;
  });
  return { value: out, ok };
}

// Factura de acuerdo: su único artículo está escrito en su PDF (Amazon: "MDF# 99009045")
const ownItem = (h: HistoryInvoice | undefined, text: string) => {
  const ls = (h?.lines || []).filter(l => l.lineType !== 'Comment');
  return ls.length === 1 && ls[0].lineType === 'Item' && /\d{5}/.test(ls[0].number) && token(ls[0].number).test(text) ? ls[0].number : '';
};

// Nº de factura hecho con la fecha (Uber: "UBER_30/10/26", "28092026/6"): la fecha del modelo en su mismo formato,
// cambiada por la nueva; lo que va detrás (el contador del día) no se copia
function numberFromDate(model: HistoryInvoice, iso: string) {
  const [y, m, d] = model.invoiceDate.split('-'), [ny, nm, nd] = iso.split('-');
  if (!y || !ny) return '';
  const formats = [(Y: string, M: string, D: string) => `${D}${M}${Y}`, (Y: string, M: string, D: string) => `${D}/${M}/${Y.slice(2)}`,
    (Y: string, M: string, D: string) => `${D}/${M}/${Y}`, (Y: string, M: string, D: string) => `${D}.${M}.${Y}`,
    (Y: string, M: string, D: string) => `${D}.${M}.${Y.slice(2)}`, (Y: string, M: string, D: string) => `${Y}-${M}-${D}`,
    (Y: string, M: string, D: string) => `${Y}${M}${D}`];
  for (const f of formats) {
    const i = model.vendorInvoiceNumber.indexOf(f(y, m, d));
    if (i >= 0) return model.vendorInvoiceNumber.slice(0, i) + f(ny, nm, nd);
  }
  return '';
}

// noAgreements: sin facturas de acuerdo como modelo (el nº del sitio de su artículo no es un artículo de BC)
// currency: divisa del PDF, si el proveedor tiene facturas en ella (Uber: AED, CHF, EUR): el modelo, de esas
// ocr: texto leído de una imagen con Tesseract; sin fecha con etiqueta, la última del texto (Uber: la del pago)
type ProposeOptions = { noAgreements?: boolean; currency?: string; ocr?: boolean };
export function propose(text: string, history: HistoryInvoice[], examples: Example[], opts: ProposeOptions = {}): OcrSuggestion | null {
  const { noAgreements = false, currency = '', ocr = false } = opts;
  const sameCurrency = history.filter(h => h.currency === currency);
  if (currency && sameCurrency.length) {
    history = sameCurrency;
    examples = examples.filter(e => history.some(h => h.number === e.number));
  }
  if (!history.length) return null;
  const t = flat(text);
  const warnings: string[] = [];
  // Modelo: el PDF anterior más parecido; a igualdad, el más reciente (examples va de más reciente a más antiguo)
  // Antes que eso, la factura cuyo único artículo aparece en el PDF nuevo (Amazon: un artículo por acuerdo, "MDF# 99009045")
  const byItem = history.find(h => ownItem(h, t));
  const scored = examples
    .filter(e => !noAgreements || !ownItem(history.find(h => h.number === e.number), flat(e.text)))
    .map(e => ({ e, s: similarity(t, e.text) }));
  const best = byItem ? scored.find(x => x.e.number === byItem.number) ?? null
    : scored.reduce<{ e: Example; s: number } | null>((a, b) => (!a || b.s > a.s + 0.02 ? b : a), null);
  // Sin PDF parecido, la más reciente (sin facturas de acuerdo si noAgreements: las de un artículo de los ejemplos de acuerdo)
  const agreementItems = new Set(examples.map(e => ownItem(history.find(h => h.number === e.number), flat(e.text))).filter(Boolean));
  const newest = noAgreements ? history.find(h => !h.lines.some(l => agreementItems.has(l.number))) : history[0];
  const model = byItem || (best && history.find(h => h.number === best.e.number)) || newest || history[0];
  const oldText = best && model.number === best.e.number ? flat(best.e.text) : '';

  // Nº de factura y fechas: en el mismo sitio que en el PDF del modelo, si no por las etiquetas habituales
  const generic = guessHeader(t);
  let invoiceNo = '';
  if (oldText && model.vendorInvoiceNumber) {
    const i = oldText.indexOf(model.vendorInvoiceNumber);
    if (i >= 0) invoiceNo = sameSpot(t, before(oldText, i), rest => rest.match(shapeOf(model.vendorInvoiceNumber))?.[0] ?? null) || '';
  }
  // Estimada o real es la misma fecha de transporte: ETS = ATS, ETD = ATD, ETA = ATA
  const transport = (x: string) => x.replace(/\b[EA]T([SDA])\b/g, 'ET$1');
  const tDates = transport(t), oldDates = transport(oldText);
  const dateAt = (iso: string) => {
    if (!oldText || !iso) return '';
    const d = dates(oldDates).find(x => x.iso === iso);
    return d ? sameSpot(tDates, before(oldDates, d.index), rest => { const m = dates(rest.slice(0, 30))[0]; return m && m.index === 0 ? m.iso : null; }) || '' : '';
  };
  const invoiceDate = dateAt(model.invoiceDate) || generic.invoiceDate || (ocr ? dates(t).pop()?.iso || '' : '');
  // Vencimiento solo si el PDF del modelo lo traía; si no, BC lo calcula con los términos de pago
  const dueDate = dateAt(model.dueDate);
  // Fecha de registro: la del sitio del PDF donde estaba la del modelo (p. ej. Meyer's Sohn GmbH: ETS/ATS), si no la
  // fecha de factura
  const postingDate = (model.postingDate !== model.invoiceDate && dateAt(model.postingDate)) || invoiceDate;

  const { net, vat, total, taxable, free } = totals(t, model);
  if (net == null) warnings.push('No totals found in the PDF: enter the amounts.');
  // Líneas del modelo: la base con IVA se reparte entre sus líneas con IVA y la parte exenta entre las exentas, en la
  // misma proporción que en el modelo; si el modelo no las distingue, el neto entre todas
  const lines = model.lines.map(l => ({ ...l }));
  const idx = lines.map((l, i) => i).filter(i => lines[i].lineType !== 'Comment');
  const share = (group: number[], amount: number) => {
    const sum = group.reduce((a, i) => a + lines[i].quantity * lines[i].unitCost, 0);
    let rest = amount;
    group.forEach((i, k) => {
      const l = lines[i];
      const part = k === group.length - 1 ? r2(rest) : r2(sum ? amount * (l.quantity * l.unitCost) / sum : amount / group.length);
      rest -= part;
      l.unitCost = r2(part / (l.quantity || 1));
    });
  };
  if (net == null) idx.forEach(i => { lines[i].unitCost = 0; });
  else {
    const { taxed } = modelSplit(model);
    const withVat = idx.filter(i => taxed.has(i)), noVat = idx.filter(i => !taxed.has(i));
    if (withVat.length && noVat.length && taxable != null && free != null) {
      share(withVat, taxable);
      share(noVat, free);
      if (free === 0) warnings.push('The PDF has no VAT-exempt part but the model does: check the line without VAT.');
    } else {
      share(idx, net);
      if (free && !noVat.length && vat) warnings.push(`The PDF has a part without VAT (${free}) that the model does not have: check the lines.`);
    }
  }

  // Artículo que estaba en el PDF del modelo (Amazon: el artículo es el nº de acuerdo, "MDF# 99009045: … Accrual
  // (Damage Allowance)"): el del mismo sitio en el PDF nuevo; processPdf comprueba que exista en BC. Solo con una
  // línea, para no cruzar artículos
  let itemFromPdf: OcrSuggestion['itemFromPdf'];
  if (oldText && idx.length === 1 && lines[idx[0]].lineType === 'Item') {
    const l = lines[idx[0]];
    const m = token(l.number).exec(oldText);
    const found = m && sameSpot(t, before(oldText, m.index), rest => rest.match(shapeOf(l.number))?.[0] ?? null);
    if (found && found !== l.number) {
      itemFromPdf = { number: found, model: l.number, modelDescription: l.description };
      l.number = found;
    } else if (m && !found && !byItem && !noAgreements) {
      // Factura de acuerdo como modelo, pero el PDF nuevo no trae ni su acuerdo ni otro en su sitio: no es de acuerdo
      return propose(text, history, examples, { ...opts, noAgreements: true });
    }
  }

  // Referencias de las descripciones; la Posting Description por defecto de BC ("Invoice 10044") no se copia
  let refsOk = true;
  const fix = (v: string) => { if (!oldText) return v; const r = adapt(v, oldText, t); refsOk &&= r.ok; return r.value; };
  for (const l of lines) { l.description = fix(l.description); l.description2 = fix(l.description2); }
  const postingDescription = /^(Invoice|Rechnung|Factura|Facture|Credit Memo|Gutschrift)\s+\S+$/i.test(model.postingDescription) ? '' : fix(model.postingDescription);
  if (!refsOk) warnings.push('Some Description 2 / Posting Description references are not in the PDF: check them.');
  if (!oldText && model.lines.some(l => /\d{3,}/.test(l.description2)) ) warnings.push('The model invoice has no PDF attached: check the Description 2 / Posting Description references.');

  const creditNote = isCreditNote(t);
  let docNo = invoiceNo || generic.invoiceNo || (invoiceDate ? numberFromDate(model, invoiceDate) : '');
  // Abono: el nº lleva a menudo un sufijo que la forma del nº de las facturas no recoge ("400209-1020.S")
  if (creditNote && docNo) {
    const m = t.match(new RegExp(`${docNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([.\\-/][A-Z0-9]{1,4})(?![A-Z0-9])`, 'i'));
    if (m) docNo += m[1];
  }
  return {
    documentType: creditNote ? 'credit_note' : 'invoice',
    invoiceNo: docNo, invoiceDate, postingDate, dueDate, postingDescription,
    currency: model.currency, net, vat, total, lines, itemFromPdf,
    comment: [`Model: invoice ${model.number} (${model.postingDate})${best && oldText ? `, the closest to the PDF (${Math.round(best.s * 100)} %)` : ', the most recent'}.`, ...warnings].join(' · '),
  };
}

// Recibos de Uber (capturas sin nº de factura): la fecha y hora del pago ("Zahlungen … 20.10.26 18:29") es la fecha
// de documento, de registro y de vencimiento, y también el Vendor Invoice No. (lo único que identifica el recibo); sin
// IVA (OHNE MWST)
function uberRules(s: OcrSuggestion, text: string, vendorName: string) {
  if (!/\buber\b/i.test(vendorName)) return;
  const pay = Math.max(0, text.search(/Zahlungen|Payments|Pagos/i));
  const m = text.slice(pay).match(/(?<![\d.\/])(\d{1,2}[./]\d{1,2}[./]\d{2,4})\s+(\d{1,2}:\d{2})/);
  const iso = m ? parseDate(m[1]) : '';
  if (iso) {
    s.invoiceDate = s.postingDate = s.dueDate = iso;
    s.invoiceNo = `${m![1]} ${m![2]}`;
  }
  for (const l of s.lines) if (l.lineType !== 'Comment') l.taxCode = 'OHNE MWST';
}

// % de IVA de cada VAT Prod. Posting Group con el VAT Bus. Posting Group de la factura (VAT Posting Setup): el IVA que
// cobra el proveedor; inversión del sujeto pasivo = 0. Sin la combinación (o Full VAT…), no se sabe
async function vatRates(ctx: BcContext, vendorNo: string, busGroup?: string) {
  const [setup, bus] = await Promise.all([
    cached(`ocr:vatsetup:${ctx.companyName}`, 6 * HOUR, async () =>
      (await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/VAT_Posting_Setup_Excel`, {
        $select: 'VAT_Bus_Posting_Group,VAT_Prod_Posting_Group,VAT_Percent,VAT_Calculation_Type',
      }), ctx.token)).map((r: any) => {
        const calc = String(r.VAT_Calculation_Type || '').replace(/_x0020_/g, ' ');
        return { bus: String(r.VAT_Bus_Posting_Group || ''), prod: String(r.VAT_Prod_Posting_Group || ''), pct: calc === 'Normal VAT' ? Number(r.VAT_Percent) || 0 : calc === 'Reverse Charge VAT' ? 0 : null };
      })),
    busGroup?.trim() ? Promise.resolve(busGroup.trim()) : bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Vendor_Card_Excel`, {
      $filter: `No eq '${q(vendorNo)}'`, $select: 'No,VAT_Bus_Posting_Group',
    }), ctx.token).then(r => String(r[0]?.VAT_Bus_Posting_Group || '')).catch(() => ''),
  ]);
  const rates: Record<string, number> = {};
  for (const r of setup) if (r.bus === bus && r.pct != null) rates[r.prod] = r.pct;
  return rates;
}

// Importes con el % de IVA de los grupos de las líneas (OHNE MWST = 0 %: el total del PDF es el neto). Solo si todas las
// líneas tienen el mismo %; las líneas se reparten el neto nuevo en su proporción
function applyVatRates(s: OcrSuggestion, text: string, rates: Record<string, number>) {
  const ls = s.lines.filter(l => l.lineType !== 'Comment');
  const pcts = [...new Set(ls.map(l => rates[l.taxCode]))];
  if (!ls.length || pcts.length !== 1 || pcts[0] == null) return;
  const r = totals(flat(text), undefined, pcts[0] / 100);
  if (r.net == null || (r.net === s.net && r.vat === s.vat)) return;
  const sum = ls.reduce((a, l) => a + l.quantity * l.unitCost, 0);
  let rest = r.net;
  ls.forEach((l, k) => {
    const part = k === ls.length - 1 ? r2(rest) : r2(sum ? r.net! * (l.quantity * l.unitCost) / sum : r.net! / ls.length);
    rest -= part;
    l.unitCost = r2(part / (l.quantity || 1));
  });
  s.net = r.net; s.vat = r.vat; s.total = r.total;
}

// VAT Product Posting Groups de la empresa (v2 taxGroups), para elegir el Grupo IVA de cada línea en la página
export async function vatGroups(ctx: BcContext) {
  return cached(`ocr:vatgroups:${ctx.companyName}`, 6 * HOUR, async () => {
    const data = await bcGet(ctx, odataUrl(`${ctx.apiBase}/taxGroups`, { $select: 'code,displayName' }));
    return ((data.value || []) as any[]).map(g => ({ code: String(g.code), name: String(g.displayName || '') }))
      .sort((a, b) => a.code.localeCompare(b.code));
  });
}

// Reglas de Amazon que no salen de la factura modelo (los PDFs se parecen demasiado entre sí):
// - promociones con "Rebate" o "Flexible" → AA-00069 FLEXIBLE ASIN BASED (las demás siguen al modelo: AA-00108…)
// - Amazon Ads (AA-00015): inversión del sujeto pasivo, 19% SERVICES con VAT Bus. Posting Group UE
const AMZ_FLEXIBLE = { number: 'AA-00069', description: 'AMZ AGREEMENT - FLEXIBLE ASIN BASED (Rebate Per Unit)', taxCode: '19% DEBIT NOTE' };
// - devoluciones de distribuidor (nota de débito con RMA / Return ID, en cualquier idioma): una línea AA-00132 por el
//   total, 19% DEBIT NOTE y el VAT Bus. Posting Group del proveedor (UE las sucursales, NAC la alemana), como
//   CRZ-PI26-06221 (Amazon France, "Ship To: CRAZE GMBH(CS5A9)"). Sin IVA: "No VAT Applied"
const AMZ_RETURN = { number: 'AA-00132', description: 'AMZ AGREEMENT - Distributor Returns', taxCode: '19% DEBIT NOTE' };
export function amazonReturn(text: string) {
  const t = flat(text);
  const rma = t.match(/(?:RMA[- ]?(?:Number|Nummer|Nr\.?)|Num[eé]ro (?:de )?RMA|N[uú]mero (?:de )?RMA|Numero RMA)\s*[:;]?\s*([A-Z0-9]{6,})/i);
  if (!rma && !/(?:Return|Retour|Rücksende|Rückgabe|Devoluci[oó]n|Reso)[- ]?ID|ID (?:de )?(?:devoluci[oó]n|reso|retour)/i.test(t)) return null;
  const total = Math.max(0, ...amounts(t));
  return { rma: rma?.[1] || '', total };
}
function amazonRules(s: OcrSuggestion, text: string, vendorName: string, warnings: string[]) {
  if (!/amazon/i.test(vendorName)) return false;
  const ret = amazonReturn(text);
  if (ret && ret.total > 0) {
    s.documentType = 'invoice';
    s.lines = [{ lineType: 'Item', ...AMZ_RETURN, description2: '', quantity: 1, unitCost: ret.total }];
    s.net = ret.total; s.vat = 0; s.total = ret.total;
    s.comment = s.comment.replace(/ · No totals found in the PDF: enter the amounts\./, '');
    s.comment += ` · Amazon: distributor return${ret.rma ? ` (RMA ${ret.rma})` : ''} → AA-00132 for the total, like CRZ-PI26-06221.`;
    return true;
  }
  const items = s.lines.filter(l => l.lineType !== 'Comment');
  if (items.length === 1 && /rebate|flexible/i.test(text) && items[0].number !== AMZ_FLEXIBLE.number) {
    Object.assign(items[0], { lineType: 'Item', ...AMZ_FLEXIBLE });
    s.comment += ' · Amazon: the PDF mentions Rebate/Flexible → AA-00069.';
  }
  if (items.some(l => l.number === 'AA-00015')) {
    for (const l of items) if (l.number === 'AA-00015') l.taxCode = '19% SERVICES';
    s.vatBusPostingGroup = 'UE';
  }
  return false;
}

// Otros proveedores Amazon de la empresa (sucursales), primero los "Amazon EU SARL" (mismo formato de factura), sin los
// de tarjeta, Business, Web Services ni Seller Central
async function amazonSiblings(ctx: BcContext, exclude: string) {
  return cached(`ocr:amazon-siblings2:${ctx.companyName}`, 6 * HOUR, async () => {
    const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, {
      $filter: `contains(displayName,'mazon') or contains(displayName,'MAZON')`, $select: 'number,displayName,blocked',
    }), ctx.token);
    return (rows as any[]).filter(v => !String(v.blocked || '').replace(/_x0020_/g, '').trim() && !/credit card|business|web services|seller|provisions|arvato/i.test(v.displayName))
      .map(v => ({ number: String(v.number), name: String(v.displayName) }))
      .sort((a, b) => Number(!/eu s\.?(?:a|à)\.? ?r/i.test(a.name)) - Number(!/eu s\.?(?:a|à)\.? ?r/i.test(b.name)));
  }).then(list => list.filter(v => v.number !== exclude));
}

// Todo el proceso para un PDF. vendorNo: proveedor elegido a mano (si no, el mejor candidato)
// ocrText: el texto de la imagen leído con Tesseract en la página, si el PDF no trae texto
export async function processPdf(ctx: BcContext, file: string, data: Uint8Array, vendorNo?: string, ocrText?: string): Promise<OcrResult> {
  const warnings: string[] = [];
  let text = '';
  // Factura electrónica: XRechnung (fichero XML) o ZUGFeRD / Factur-X (el XML dentro del PDF). Sus datos son exactos:
  // el texto del PDF solo sirve para el modelo; sin PDF, el texto se hace con el XML
  let einv: { file: string; invoice: EInvoice } | null = null;
  const isXml = looksXml(file, data);
  if (isXml) {
    const invoice = parseEInvoice(xmlText(data));
    if (!invoice) throw new Error('The XML file is not an e-invoice (XRechnung / ZUGFeRD: CII or UBL).');
    einv = { file, invoice };
    text = eInvoiceText(invoice);
  } else {
    try { text = await pdfText(data); } catch (e: any) { warnings.push(`Could not read the text of the PDF (${e.message}).`); }
    einv = await embeddedEInvoice(data).catch(() => null);
    if (einv && text.replace(/\s/g, '').length < 40) text = eInvoiceText(einv.invoice);
  }
  const scanned = !einv && text.replace(/\s/g, '').length < 40;
  const ocr = scanned && !!ocrText && ocrText.replace(/\s/g, '').length >= 20;
  if (ocr) { text = ocrText!.replace(/[ \t]+/g, ' ').trim(); warnings.push('PDF without text: read from the image with OCR (Tesseract). Check the date, invoice no. and amounts.'); }
  else if (scanned) { text = ''; warnings.push(ocrText == null ? 'Scanned PDF (no text): it cannot be read. Choose the vendor and enter the data manually.' : 'Scanned PDF: OCR (Tesseract) did not extract readable text. Choose the vendor and enter the data manually.'); }
  const ids = [...new Set([...identifiers(text), ...(einv ? eInvoiceIds(einv.invoice) : [])])];
  const currency = einv?.invoice.currency || detectCurrency(text);
  const candidates = text ? await matchVendors(ctx, text, ids, currency) : [];
  const vendor = vendorNo ? await vendorByNumber(ctx, vendorNo) : candidates[0] || null;
  if (vendorNo && !vendor) warnings.push(`Vendor ${vendorNo} does not exist in ${ctx.companyName}.`);
  if (!vendor && text) warnings.push('The vendor was not recognised: choose it manually.');
  else if (vendor && !vendorNo && candidates[1] && candidates[1].score >= candidates[0].score - 0.5) {
    warnings.push(`Uncertain vendor: ${candidates[1].number} ${candidates[1].name} also fits. Check it.`);
  }

  let { history, examples } = vendor ? await vendorHistory(ctx, vendor.number) : { history: [] as HistoryInvoice[], examples: [] as { number: string; text: string }[] };
  // Amazon sin facturas propias (una sucursal nueva: Amazon EU SARL (PL)): las de otras sucursales de Amazon como
  // modelo, porque sus facturas y debit notes son iguales. El VAT Bus. Posting Group sigue siendo el del proveedor
  const borrowed: string[] = [];
  if (vendor && !history.length && /amazon/i.test(vendor.name)) {
    const siblings = await amazonSiblings(ctx, vendor.number).catch(() => [] as { number: string; name: string }[]);
    for (const sib of siblings) {
      const h = await vendorHistory(ctx, sib.number).catch(() => null);
      if (!h?.history.length) continue;
      history = [...history, ...h.history]; examples = [...examples, ...h.examples]; borrowed.push(`${sib.number} ${sib.name}`);
      if (borrowed.length >= 2) break;
    }
    if (borrowed.length) warnings.push(`${vendor.number} has no posted invoices: proposal based on those of ${borrowed.join(' and ')}, which are identical. Check item and VAT.`);
  }
  if (vendor && !history.length) warnings.push('This vendor has no posted invoices: fill in item/account and VAT group manually.');

  // Proveedor con facturas en varias divisas (Uber: AED, CHF, EUR): la del PDF
  const known = !!currency && history.some(h => h.currency === currency);
  const opts: ProposeOptions = { currency: known ? currency : '', ocr };
  let suggestion = propose(text, history, examples, opts);
  // Artículo leído en el PDF, con su descripción de BC. Si no es un artículo (Amazon: el MDF# de una promoción o de un
  // Born To Run), el documento no es de acuerdo: se propone otra vez sin facturas de acuerdo como modelo
  const pdfItem = suggestion?.itemFromPdf;
  if (suggestion && pdfItem) {
    const item = ((await bcGet(ctx, odataUrl(`${ctx.apiBase}/items`, {
      $filter: `number eq '${q(pdfItem.number)}'`, $select: 'number,displayName',
    })).catch(() => ({ value: [] }))).value || [])[0];
    if (item) {
      const line = suggestion.lines.find(l => l.number === pdfItem.number)!;
      line.description = item.displayName || line.description;
    } else {
      suggestion = propose(text, history, examples, { ...opts, noAgreements: true });
      if (suggestion) suggestion.comment += ` · The PDF shows ${pdfItem.number} where the agreement invoices show their item (${pdfItem.model}), and it is not a BC item: if it is a new agreement, create item ${pdfItem.number}.`;
    }
  }
  const amazonReturnDoc = !!suggestion && !!vendor && amazonRules(suggestion, text, vendor.name, warnings);
  if (suggestion && vendor) uberRules(suggestion, text, vendor.name);
  // Importes con el % de IVA de los grupos de IVA propuestos (y los % para recalcular en la página al cambiar de grupo)
  const rates = vendor ? await vatRates(ctx, vendor.number, suggestion?.vatBusPostingGroup).catch(() => ({} as Record<string, number>)) : {};
  // (devolución de Amazon: el importe es el total, sin IVA)
  if (einv && vendor) {
    // Sin facturas del proveedor: las líneas de la factura electrónica, sin cuenta (se elige en la página)
    if (!suggestion) suggestion = fromEInvoiceLines(einv.invoice);
    applyEInvoice(suggestion, einv.invoice, rates, warnings);
  } else if (suggestion && text && !amazonReturnDoc) applyVatRates(suggestion, text, rates);
  if (suggestion?.documentType === 'credit_note') warnings.push('This is a credit note: it will be created as a Purchase Credit Memo (change the document type if it is an invoice).');
  // La divisa del PDF manda aunque el proveedor no tenga facturas en ella (Uber en Macao: MOP; el modelo puede estar en
  // CHF); la local va vacía al crearla. Se avisa si no existe en BC
  if (suggestion && currency && suggestion.currency !== currency) {
    const lcy = companyCurrency(ctx.companyName);
    const found = currency === lcy ? null : await bcGet(ctx, odataUrl(`${ctx.apiBase}/currencies`, { $filter: `code eq '${q(currency)}'`, $select: 'code' })).catch(() => null);
    const exists = currency === lcy || !!found?.value?.length;
    warnings.push(`Currency ${currency} (from the PDF): this vendor has no previous invoices in ${currency} (the model is in ${suggestion.currency || lcy}).${exists ? '' : ` ${currency} does not exist in BC: create it in Currencies or change the currency.`}`);
    suggestion.currency = currency;
  } else if (vendor && currency && currency !== vendor.currency && !known) {
    warnings.push(`The invoice is in ${currency} and vendor ${vendor.number} in ${vendor.currency}: is it another vendor (e.g. the card in ${currency})?`);
  }
  const existing = vendor && suggestion?.invoiceNo ? await existingFor(ctx, vendor.number, suggestion.invoiceNo, suggestion.documentType === 'credit_note') : [];
  const einvoice = einv ? eInvoiceSummary(einv.invoice, einv.file) : null;
  return { file, scanned, ocr, currency, ids, vatRates: rates, candidates, vendor, history, suggestion, existing, warnings, einvoice };
}

// ---------- Factura electrónica (ZUGFeRD / XRechnung) ----------
// Propuesta con las líneas del XML cuando el proveedor no tiene facturas en BC: cuenta y grupo de IVA, a mano
function fromEInvoiceLines(e: EInvoice): OcrSuggestion {
  return {
    documentType: e.creditNote ? 'credit_note' : 'invoice', invoiceNo: e.number, invoiceDate: e.issueDate, postingDate: e.issueDate,
    dueDate: e.dueDate, postingDescription: '', currency: e.currency, net: e.net, vat: e.vat, total: e.total,
    lines: e.lines.map(l => ({ lineType: 'Account', number: '', description: l.name.substring(0, 100), description2: (l.sellerId || '').substring(0, 50), quantity: Math.abs(l.quantity) || 1, unitCost: r2(Math.abs(l.amount) / (Math.abs(l.quantity) || 1)), taxCode: '' })),
    comment: `Lines taken from the e-invoice (${e.format}): choose the account and VAT group of each line.`,
  };
}

// Cabecera e importes exactos del XML sobre la propuesta del modelo: nº, fechas, divisa, tipo de documento y totales.
// Las líneas del modelo se reparten la base de cada % de IVA del XML según el % de su grupo de IVA (VAT Posting Setup);
// si los % no casan, el neto entero en la proporción del modelo
function applyEInvoice(s: OcrSuggestion, e: EInvoice, rates: Record<string, number>, warnings: string[]) {
  const sign = e.creditNote && (e.total ?? 0) < 0 ? -1 : 1;
  if (e.number) s.invoiceNo = e.number;
  if (e.issueDate) {
    // La fecha de registro solo se queda si el modelo la toma de otro sitio (ETS/ATS…)
    if (!s.postingDate || s.postingDate === s.invoiceDate) s.postingDate = e.issueDate;
    s.invoiceDate = e.issueDate;
  }
  if (e.dueDate) s.dueDate = e.dueDate;
  if (e.currency) s.currency = e.currency;
  s.documentType = e.creditNote ? 'credit_note' : 'invoice';
  const net = e.net != null ? r2(e.net * sign) : null;
  s.net = net; s.vat = e.vat != null ? r2(e.vat * sign) : null; s.total = e.total != null ? r2(e.total * sign) : null;
  const ls = s.lines.filter(l => l.lineType !== 'Comment');
  if (net == null || !ls.length) return;
  const spread = (group: OcrLine[], amount: number) => {
    const sum = group.reduce((a, l) => a + l.quantity * l.unitCost, 0);
    let rest = amount;
    group.forEach((l, k) => {
      const part = k === group.length - 1 ? r2(rest) : r2(sum ? amount * (l.quantity * l.unitCost) / sum : amount / group.length);
      rest -= part;
      l.unitCost = r2(part / (l.quantity || 1));
    });
  };
  // Las líneas que salen del propio XML ya traen su importe
  if (ls.every(l => !l.number)) return;
  const taxes = e.taxes.filter(t => Math.abs(t.basis) >= 0.005);
  const byPct = new Map<number, OcrLine[]>();
  for (const l of ls) { const p = rates[l.taxCode]; if (p != null) byPct.set(p, [...(byPct.get(p) || []), l]); }
  const matched = taxes.length > 0 && taxes.every(t => byPct.has(t.pct)) && byPct.size === new Set(taxes.map(t => t.pct)).size && [...byPct.values()].flat().length === ls.length;
  if (matched) for (const t of taxes) spread(byPct.get(t.pct)!, r2(taxes.filter(x => x.pct === t.pct).reduce((a, x) => a + x.basis, 0) * sign));
  else {
    spread(ls, net);
    const xmlPcts = [...new Set(taxes.map(t => t.pct))].join(' / ');
    const linePcts = [...new Set(ls.map(l => rates[l.taxCode]).filter(p => p != null))].join(' / ');
    if (xmlPcts && linePcts && xmlPcts !== linePcts) warnings.push(`The e-invoice has VAT ${xmlPcts} % and the proposed VAT groups ${linePcts} %: check the VAT group of the lines.`);
  }
}

// ---------- Crear en BC ----------
export type OcrCreateInput = {
  vendor: string; invoiceNo: string; invoiceDate: string; postingDate: string; dueDate: string; postingDescription?: string;
  vatBusPostingGroup?: string; currency?: string; lines: OcrLine[]; ids?: string[]; force?: boolean;
  documentType?: 'invoice' | 'credit_note';
};

// Crea la Purchase Invoice, o el Purchase Credit Memo si es un abono, sin registrar (API v2) con las líneas de la
// página y el PDF adjunto. En el abono las cantidades e importes van en positivo, como en BC.
export async function createOcrInvoice(ctx: BcContext, input: OcrCreateInput, pdf?: { name: string; data: Uint8Array }) {
  const warnings: string[] = [];
  const credit = input.documentType === 'credit_note';
  const entity = credit ? 'purchaseCreditMemos' : 'purchaseInvoices';
  const linesEntity = credit ? 'purchaseCreditMemoLines' : 'purchaseInvoiceLines';
  const head = await bcRequest('POST', `${ctx.apiBase}/${entity}`, ctx.token, {
    vendorNumber: input.vendor, ...(credit ? { vendorCreditMemoNumber: input.invoiceNo } : { vendorInvoiceNumber: input.invoiceNo }),
    ...(input.invoiceDate ? (credit ? { creditMemoDate: input.invoiceDate } : { invoiceDate: input.invoiceDate }) : {}),
    ...(input.postingDate ? { postingDate: input.postingDate } : {}),
  });
  const id: string = head.id, no: string = head.number;
  const headUrl = `${ctx.apiBase}/${entity}(${id})`;
  const desc2: { sequence: number; text: string }[] = [];
  try {
    // Divisa de la factura si no es la del proveedor (Uber: AED); la divisa local va vacía. Antes de las líneas
    const lcy = companyCurrency(ctx.companyName);
    const want = input.currency?.trim().toUpperCase();
    if (want && want !== (head.currencyCode || lcy)) await bcRequest('PATCH', headUrl, ctx.token, { currencyCode: want === lcy ? '' : want });
    // Vencimiento después de la fecha (la fecha de factura lo recalcula con los términos de pago del proveedor)
    if (input.dueDate) await bcRequest('PATCH', headUrl, ctx.token, { dueDate: input.dueDate });
    // Las líneas estándar que BC añade al poner el proveedor no están en las facturas registradas: fuera
    const auto = await bcRequest('GET', `${headUrl}/${linesEntity}?$select=id`, ctx.token);
    for (const l of auto?.value || []) await bcRequest('DELETE', `${headUrl}/${linesEntity}(${l.id})`, ctx.token);
    // VAT Bus. Posting Group (Amazon Ads: UE) antes de las líneas, que lo toman de la cabecera; no está en v2
    if (input.vatBusPostingGroup?.trim()) {
      await bcRequest('PATCH', `${ctx.odataCompanyBase}/purchaseDocuments(${id})`, ctx.token, { vatBusPostingGroup: input.vatBusPostingGroup.trim() });
    }
    for (const l of input.lines) {
      const comment = l.lineType === 'Comment';
      const row = await bcRequest('POST', `${headUrl}/${linesEntity}`, ctx.token, comment
        ? { lineType: 'Comment', description: l.description }
        : {
          lineType: l.lineType, lineObjectNumber: l.number,
          // Abono: en positivo (BC ya lo resta); el PDF puede traerlo en negativo
          quantity: credit ? Math.abs(l.quantity) : l.quantity, unitCost: credit ? Math.abs(l.unitCost) : l.unitCost,
          ...(l.description ? { description: l.description } : {}), ...(l.description2 && !credit ? { description2: l.description2 } : {}),
          ...(l.taxCode ? { taxCode: l.taxCode } : {}),
        });
      // Las líneas de abono de la API v2 no tienen Description 2: se pone después por OData
      if (credit && l.description2 && row?.sequence) desc2.push({ sequence: row.sequence, text: l.description2 });
    }
  } catch (e) {
    // No dejar una factura a medias
    await bcRequest('DELETE', headUrl, ctx.token).catch(() => {});
    throw e;
  }
  if (desc2.length) {
    const w = await setCreditMemoDescription2(ctx, no, desc2).catch((e: any) => `Description 2 could not be set (${String(e.message).substring(0, 120)}), enter it in BC.`);
    if (w) warnings.push(w);
  }
  // La Posting Description no está en v2: por la página OData purchaseDocuments (por SystemId), como en Aduanas
  if (input.postingDescription?.trim()) {
    try {
      await bcRequest('PATCH', `${ctx.odataCompanyBase}/purchaseDocuments(${id})`, ctx.token, { postingDescription: input.postingDescription.trim().substring(0, 100) });
    } catch (e: any) {
      warnings.push(`Could not set the Posting Description (${String(e.message).substring(0, 160)}), enter it in BC.`);
    }
  }
  if (pdf) {
    try {
      await attachFile(ctx, id, pdf, credit ? 'Purchase Credit Memo' : 'Purchase Invoice');
    } catch (e: any) {
      warnings.push(`Could not attach the PDF (${String(e.message).substring(0, 160)}), attach it in BC.`);
    }
  }
  const after = await bcRequest('GET', headUrl, ctx.token).catch(() => null);
  return { id, no, net: after?.totalAmountExcludingTax ?? null, total: after?.totalAmountIncludingTax ?? null, currency: after?.currencyCode || '', warnings };
}

// Description 2 de las líneas de un abono (no está en las líneas de abono de la API v2): por el servicio OData de
// líneas de compra que la tenga (purchaseDocumentLines…), línea a línea por Document No. + Line No. (= sequence de v2)
async function setCreditMemoDescription2(ctx: BcContext, docNo: string, lines: { sequence: number; text: string }[]): Promise<string> {
  const root = ctx.odataCompanyBase.replace(/\/Company\(.*$/, '');
  const res = await fetch(root, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
  const names: string[] = res.ok ? ((await res.json()).value || []).map((s: any) => s.name) : [];
  const late = (n: string) => Number(/excel/i.test(n) && !/editable/i.test(n));
  const services = names.filter(n => /^purch(ase)?.?(document.?)?lines?/i.test(n) && !/posted|archiv|shipment|receipt/i.test(n)).sort((a, b) => late(a) - late(b));
  for (const name of services) {
    for (const [docField, lineField] of [['Document_No', 'Line_No'], ['documentNumber', 'lineNumber'], ['documentNo', 'lineNo']]) {
      const r = await fetch(odataUrl(`${ctx.odataCompanyBase}/${name}`, { $filter: `${docField} eq '${q(docNo)}'` }), {
        headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json;odata.metadata=full' },
      });
      if (!r.ok) continue;
      const rows: any[] = (await r.json()).value || [];
      if (!rows.length) continue;
      const field = Object.keys(rows[0]).find(k => /^description_?2$/i.test(k));
      if (!field) break;
      let done = 0;
      for (const l of lines) {
        const row = rows.find(x => Number(x[lineField]) === l.sequence);
        const link: string | undefined = row?.['@odata.editLink'];
        if (!link) continue;
        const url = /^https?:/.test(link) ? link : /^Company\(/i.test(link) ? `${root}/${link}` : `${ctx.odataCompanyBase}/${link}`;
        try { await bcRequest('PATCH', url, ctx.token, { [field]: l.text.substring(0, 50) }); done++; } catch { /* siguiente servicio */ }
      }
      if (done === lines.length) return '';
    }
  }
  return 'Description 2 could not be set on the credit memo lines, enter it in BC.';
}
