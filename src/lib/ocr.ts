import { getDocumentProxy, extractText } from 'unpdf';
import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { attachFile, bcRequest } from '@/lib/bcWrite';
import { cached, readSetting, writeSetting, HOUR } from '@/lib/reporting/cache';
import { companyCurrency } from '@/lib/royalties';

// OCR de facturas de compra: del PDF de un proveedor a una Purchase Invoice sin registrar en BC.
// Sin IA: reglas sobre el texto y las facturas ya registradas del proveedor.
// 1. Texto del PDF con unpdf (un escaneo sin texto no se puede leer).
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
};
export type OcrResult = {
  file: string; scanned: boolean; currency: string; ids: string[];
  candidates: VendorCandidate[]; vendor: VendorCandidate | null; history: HistoryInvoice[];
  suggestion: OcrSuggestion | null; existing: { no: string; status: string }[]; warnings: string[];
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

// Divisa del documento: la que más aparece
export function detectCurrency(text: string) {
  const count = (re: RegExp) => (text.match(re) || []).length;
  const scores: [string, number][] = [
    ['EUR', count(/\bEUR\b|€/g)], ['USD', count(/\bUSD\b|US\$/g)], ['GBP', count(/\bGBP\b|£/g)],
    ['CHF', count(/\bCHF\b/g)], ['CNY', count(/\bCNY\b|\bRMB\b/g)],
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
const vendorCurrency = (v: VendorRow) => v.currency || v.name.match(/\((USD|EUR|GBP|CHF|CNY)\)/i)?.[1]?.toUpperCase() || '';

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
    if (learnt.length) { score += 5; reasons.push(`reconocido por ${learnt.map(i => i.split(':')[1]).join(', ')} (facturas anteriores)`); }
    if (v.vat.length >= 8 && ids.includes(`vat:${v.vat}`)) { score += 4; reasons.push(`VAT ${v.vat}`); }
    const doms = [v.email.split('@')[1], v.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]]
      .filter(Boolean).map(d => d!.toLowerCase().split('.').slice(-2).join('.'));
    const dom = doms.find(d => !GENERIC_DOMAINS.test(d) && ids.includes(`dom:${d}`));
    if (dom) { score += 3; reasons.push(`dominio ${dom}`); }
    const nw = nameWords(v.name);
    const hit = nw.filter(w => words.has(w));
    if (hit.length && hit.some(w => w.length >= 4)) {
      // Más palabras coincidentes = nombre más concreto ("Amazon EU SARL, Niederlassung Deutschland" frente a "Amazon EU SARL")
      score += 3 * hit.length / nw.length + 0.5 * (hit.length - 1);
      const full = norm(v.name.replace(/\([^)]*\)/g, ' ')).replace(/[^a-z0-9]+/g, ' ').trim();
      if (full.split(' ').length > 1 && flat.includes(full)) score += 1;
      reasons.push(`nombre (${hit.length}/${nw.length} palabras)`);
    }
    if (score < 1) continue;
    // Craze como proveedor (intercompañía) solo si lo identifican VAT/IBAN/dominio: el PDF siempre lleva nuestro nombre
    if (/^craze/i.test(v.name) && !learnt.length && !dom && !reasons.some(r => r.startsWith('VAT'))) continue;
    const cur = vendorCurrency(v) || lcy;
    if (currency) {
      if (cur === currency) { score += 0.5; } else { score -= 1; reasons.push(`divisa ${cur} ≠ ${currency} del PDF`); }
    }
    if (v.blocked) { score -= 2; reasons.push('bloqueado'); }
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
  return v ? { number: v.number, name: v.name, currency: vendorCurrency(v) || companyCurrency(ctx.companyName), score: 0, reasons: ['elegido a mano'], invoices: v.invoices } : null;
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
export async function existingFor(ctx: BcContext, vendor: string, invoiceNo: string) {
  if (!vendor || !invoiceNo) return [];
  const variants = [invoiceNo, `${invoiceNo}.`].map(v => `vendorInvoiceNumber eq '${q(v)}'`).join(' or ');
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/purchaseInvoices`, {
    $filter: `vendorNumber eq '${q(vendor)}' and (${variants})`, $select: 'number,status',
  }), ctx.token).catch(() => []);
  return rows.filter((r: any) => r.status !== 'Canceled').map((r: any) => ({ no: r.number as string, status: r.status as string }));
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
const dates = (t: string) => [...t.matchAll(DATE_RE)].map(m => ({ index: m.index!, raw: m[0], iso: parseDate(m[0]) })).filter(d => d.iso);

// Texto que precede a la posición i (la etiqueta: "Invoice Number:", "Your reference:"…)
const before = (t: string, i: number) => t.slice(Math.max(0, i - 30), i).replace(/^\S*\s/, '');
// Valor con la misma etiqueta en el texto nuevo: prueba la etiqueta entera y luego sus finales (≥ 6 caracteres)
function sameSpot(text: string, label: string, read: (rest: string) => string | null) {
  for (let n = label.length; n >= 6; n--) {
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

// Etiquetas genéricas, si no hay PDF modelo o no se encuentra su etiqueta
function guessHeader(t: string) {
  const invoiceNo = t.match(/(?:Invoice|Rechnungs?|Debit Note|Credit Note|Gutschrift|Factura|Facture|Beleg)[ -]?(?:Number|No\.?|Nr\.?|nummer|n[º°o]\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]{3,})/i)?.[1]?.replace(/\.$/, '') || '';
  let invoiceDate = '';
  for (const re of [/(?:Invoice Date|Debit Note Date|Rechnungsdatum|Belegdatum|Fecha(?: de)? (?:la )?factura|Date de (?:la )?facture)\s*:?\s*/i, /(?:Datum|Date|Fecha)\s*:?\s*/i]) {
    const m = t.match(re);
    if (m) { invoiceDate = dates(t.slice(m.index! + m[0].length, m.index! + m[0].length + 25))[0]?.iso || ''; if (invoiceDate) break; }
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
function totals(t: string, model: HistoryInvoice | undefined) {
  const list = amounts(t);
  const set = [...new Set(list)].filter(v => v > 0).sort((a, b) => b - a);
  const near = (v: number) => set.find(x => Math.abs(x - v) <= Math.max(0.02, v * 0.0002));
  const split = model ? modelSplit(model) : null;
  const taxFree = split?.rate === 0 || /tax ?free|steuerfrei|exento|reverse charge|nicht steuerbar|0[.,]00 ?%/i.test(t);
  const rates = [...new Set([...(split?.rate ? [split.rate] : []), ...RATES])];
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

export function propose(text: string, history: HistoryInvoice[], examples: Example[]): OcrSuggestion | null {
  if (!history.length) return null;
  const t = flat(text);
  const warnings: string[] = [];
  // Modelo: el PDF anterior más parecido; a igualdad, el más reciente (examples va de más reciente a más antiguo)
  const scored = examples.map(e => ({ e, s: similarity(t, e.text) }));
  const best = scored.reduce<{ e: Example; s: number } | null>((a, b) => (!a || b.s > a.s + 0.02 ? b : a), null);
  const model = (best && history.find(h => h.number === best.e.number)) || history[0];
  const oldText = best && model.number === best.e.number ? flat(best.e.text) : '';

  // Nº de factura y fechas: en el mismo sitio que en el PDF del modelo, si no por las etiquetas habituales
  const generic = guessHeader(t);
  let invoiceNo = '';
  if (oldText && model.vendorInvoiceNumber) {
    const i = oldText.indexOf(model.vendorInvoiceNumber);
    if (i >= 0) invoiceNo = sameSpot(t, before(oldText, i), rest => rest.match(shapeOf(model.vendorInvoiceNumber))?.[0] ?? null) || '';
  }
  const dateAt = (iso: string) => {
    if (!oldText || !iso) return '';
    const d = dates(oldText).find(x => x.iso === iso);
    return d ? sameSpot(t, before(oldText, d.index), rest => { const m = dates(rest.slice(0, 30))[0]; return m && m.index === 0 ? m.iso : null; }) || '' : '';
  };
  const invoiceDate = dateAt(model.invoiceDate) || generic.invoiceDate;
  // Vencimiento solo si el PDF del modelo lo traía; si no, BC lo calcula con los términos de pago
  const dueDate = dateAt(model.dueDate);
  const postingDate = invoiceDate;

  const { net, vat, total, taxable, free } = totals(t, model);
  if (net == null) warnings.push('No se han encontrado los totales en el PDF: escribe los importes.');
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
      if (free === 0) warnings.push('El PDF no tiene parte exenta y el modelo sí: revisa la línea sin IVA.');
    } else {
      share(idx, net);
      if (free && !noVat.length && vat) warnings.push(`El PDF tiene una parte sin IVA (${free}) que el modelo no tiene: revisa las líneas.`);
    }
  }

  // Referencias de las descripciones; la Posting Description por defecto de BC ("Invoice 10044") no se copia
  let refsOk = true;
  const fix = (v: string) => { if (!oldText) return v; const r = adapt(v, oldText, t); refsOk &&= r.ok; return r.value; };
  for (const l of lines) { l.description = fix(l.description); l.description2 = fix(l.description2); }
  const postingDescription = /^(Invoice|Rechnung|Factura|Facture|Credit Memo|Gutschrift)\s+\S+$/i.test(model.postingDescription) ? '' : fix(model.postingDescription);
  if (!refsOk) warnings.push('Alguna referencia de Description 2 / Posting Description no está en el PDF: revísalas.');
  if (!oldText && model.lines.some(l => /\d{3,}/.test(l.description2)) ) warnings.push('La factura modelo no tiene PDF adjunto: revisa las referencias de Description 2 / Posting Description.');

  const creditNote = /\b(credit note|gutschrift|nota de cr[eé]dito|avoir|abono)\b/i.test(t.slice(0, 1500)) && !/\b(invoice|rechnung|factura|facture)\b/i.test(t.slice(0, 300));
  return {
    documentType: creditNote ? 'credit_note' : 'invoice',
    invoiceNo: invoiceNo || generic.invoiceNo, invoiceDate, postingDate, dueDate, postingDescription,
    currency: model.currency, net, vat, total, lines,
    comment: `Modelo: factura ${model.number} (${model.postingDate})${best && oldText ? `, la más parecida al PDF (${Math.round(best.s * 100)} %)` : ', la más reciente'}.${warnings.length ? ' ' + warnings.join(' ') : ''}`,
  };
}

// Todo el proceso para un PDF. vendorNo: proveedor elegido a mano (si no, el mejor candidato)
export async function processPdf(ctx: BcContext, file: string, data: Uint8Array, vendorNo?: string): Promise<OcrResult> {
  const warnings: string[] = [];
  let text = '';
  try { text = await pdfText(data); } catch (e: any) { warnings.push(`No se ha podido leer el texto del PDF (${e.message}).`); }
  const scanned = text.replace(/\s/g, '').length < 40;
  if (scanned) { text = ''; warnings.push('PDF escaneado (sin texto): no se puede leer. Elige el proveedor y escribe los datos a mano.'); }
  const ids = identifiers(text);
  const currency = detectCurrency(text);
  const candidates = text ? await matchVendors(ctx, text, ids, currency) : [];
  const vendor = vendorNo ? await vendorByNumber(ctx, vendorNo) : candidates[0] || null;
  if (vendorNo && !vendor) warnings.push(`El proveedor ${vendorNo} no existe en ${ctx.companyName}.`);
  if (!vendor && !scanned) warnings.push('No se ha reconocido el proveedor: elígelo a mano.');
  else if (vendor && !vendorNo && candidates[1] && candidates[1].score >= candidates[0].score - 0.5) {
    warnings.push(`Proveedor dudoso: ${candidates[1].number} ${candidates[1].name} también encaja. Revísalo.`);
  }

  const { history, examples } = vendor ? await vendorHistory(ctx, vendor.number) : { history: [], examples: [] };
  if (vendor && !history.length) warnings.push('Este proveedor no tiene facturas registradas: completa artículo/cuenta y grupo de IVA a mano.');

  const suggestion = propose(text, history, examples);
  if (suggestion?.documentType === 'credit_note') warnings.push('Parece un abono (credit note): aquí solo se crean facturas; regístralo como Credit Memo en BC.');
  if (vendor && currency && currency !== vendor.currency) {
    warnings.push(`La factura está en ${currency} y el proveedor ${vendor.number} en ${vendor.currency}: ¿es otro proveedor (p. ej. la ficha en ${currency})?`);
  }
  const existing = vendor && suggestion?.invoiceNo ? await existingFor(ctx, vendor.number, suggestion.invoiceNo) : [];
  return { file, scanned, currency, ids, candidates, vendor, history, suggestion, existing, warnings };
}

// ---------- Crear en BC ----------
export type OcrCreateInput = {
  vendor: string; invoiceNo: string; invoiceDate: string; postingDate: string; dueDate: string; postingDescription?: string;
  lines: OcrLine[]; ids?: string[]; force?: boolean;
};

// Crea la Purchase Invoice sin registrar (API v2) con las líneas de la página y el PDF adjunto
export async function createOcrInvoice(ctx: BcContext, input: OcrCreateInput, pdf?: { name: string; data: Uint8Array }) {
  const warnings: string[] = [];
  const head = await bcRequest('POST', `${ctx.apiBase}/purchaseInvoices`, ctx.token, {
    vendorNumber: input.vendor, vendorInvoiceNumber: input.invoiceNo,
    ...(input.invoiceDate ? { invoiceDate: input.invoiceDate } : {}), ...(input.postingDate ? { postingDate: input.postingDate } : {}),
  });
  const id: string = head.id, no: string = head.number;
  const headUrl = `${ctx.apiBase}/purchaseInvoices(${id})`;
  try {
    // Vencimiento después de la fecha (la fecha de factura lo recalcula con los términos de pago del proveedor)
    if (input.dueDate) await bcRequest('PATCH', headUrl, ctx.token, { dueDate: input.dueDate });
    // Las líneas estándar que BC añade al poner el proveedor no están en las facturas registradas: fuera
    const auto = await bcRequest('GET', `${headUrl}/purchaseInvoiceLines?$select=id`, ctx.token);
    for (const l of auto?.value || []) await bcRequest('DELETE', `${headUrl}/purchaseInvoiceLines(${l.id})`, ctx.token);
    for (const l of input.lines) {
      const comment = l.lineType === 'Comment';
      await bcRequest('POST', `${headUrl}/purchaseInvoiceLines`, ctx.token, comment
        ? { lineType: 'Comment', description: l.description }
        : {
          lineType: l.lineType, lineObjectNumber: l.number, quantity: l.quantity, unitCost: l.unitCost,
          ...(l.description ? { description: l.description } : {}), ...(l.description2 ? { description2: l.description2 } : {}),
          ...(l.taxCode ? { taxCode: l.taxCode } : {}),
        });
    }
  } catch (e) {
    // No dejar una factura a medias
    await bcRequest('DELETE', headUrl, ctx.token).catch(() => {});
    throw e;
  }
  // La Posting Description no está en v2: por la página OData purchaseDocuments (por SystemId), como en Aduanas
  if (input.postingDescription?.trim()) {
    try {
      await bcRequest('PATCH', `${ctx.odataCompanyBase}/purchaseDocuments(${id})`, ctx.token, { postingDescription: input.postingDescription.trim().substring(0, 100) });
    } catch (e: any) {
      warnings.push(`No se ha podido poner la Posting Description (${String(e.message).substring(0, 160)}); escríbela en BC.`);
    }
  }
  if (pdf) {
    try {
      await attachFile(ctx, id, pdf);
    } catch (e: any) {
      warnings.push(`No se ha podido adjuntar el PDF (${String(e.message).substring(0, 160)}); adjúntalo en BC.`);
    }
  }
  const after = await bcRequest('GET', headUrl, ctx.token).catch(() => null);
  return { id, no, net: after?.totalAmountExcludingTax ?? null, total: after?.totalAmountIncludingTax ?? null, currency: after?.currencyCode || '', warnings };
}
