import { getDocumentProxy, extractText } from 'unpdf';
import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { attachFile, bcRequest } from '@/lib/bcWrite';
import { cached, readSetting, writeSetting, HOUR } from '@/lib/reporting/cache';
import { aiConfigured, generateText, type AiPart } from '@/lib/ai';
import { companyCurrency } from '@/lib/royalties';

// OCR de facturas de compra: del PDF de un proveedor a una Purchase Invoice sin registrar en BC.
// 1. Texto del PDF con unpdf (si es un escaneo no hay texto y la IA lee el PDF).
// 2. Proveedor: identificadores del PDF (NIF/VAT, IBAN, dominio de correo/web) aprendidos de las facturas ya creadas
//    desde aquí (setting ocr:hints:<empresa>), el VAT y el correo de la ficha del proveedor, las palabras de su nombre,
//    la divisa y cuántas facturas suyas hay en el último año (los habituales primero).
// 3. Las últimas facturas registradas de ese proveedor (líneas y el texto del PDF adjunto de unas cuantas) son el
//    modelo: la IA lee cabecera e importes del PDF nuevo y propone las líneas igual que en esas facturas
//    (mismo tipo, artículo/cuenta, descripción y grupo de IVA).

export type OcrLine = {
  lineType: string; number: string; description: string; description2: string;
  quantity: number; unitCost: number; taxCode: string;
};
export type VendorCandidate = { number: string; name: string; currency: string; score: number; reasons: string[]; invoices: number };
export type HistoryInvoice = {
  number: string; vendorInvoiceNumber: string; invoiceDate: string; postingDate: string; dueDate: string;
  currency: string; net: number; total: number; lines: OcrLine[];
};
export type OcrSuggestion = {
  documentType: 'invoice' | 'credit_note'; invoiceNo: string; invoiceDate: string; postingDate: string; dueDate: string;
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

// Proveedores de la empresa con su nº de facturas del último año (caché 6 h)
async function vendorIndex(ctx: BcContext): Promise<VendorRow[]> {
  return cached(`ocr:vendors:${ctx.companyName}`, 6 * HOUR, async () => {
    const since = new Date(Date.now() - 365 * 24 * HOUR).toISOString().substring(0, 10);
    const [vendors, invoices] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, { $select: 'number,displayName,email,website,taxRegistrationNumber,currencyCode,blocked' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.apiBase}/purchaseInvoices`, { $filter: `postingDate ge ${since}`, $select: 'vendorNumber' }), ctx.token).catch(() => []),
    ]);
    const count = new Map<string, number>();
    for (const i of invoices) count.set(i.vendorNumber, (count.get(i.vendorNumber) || 0) + 1);
    return vendors.map((v: any) => ({
      number: v.number, name: v.displayName || '', email: v.email || '', website: v.website || '', vat: squash(v.taxRegistrationNumber || ''),
      currency: v.currencyCode || '', blocked: !!v.blocked && v.blocked.trim?.() !== '' && v.blocked !== '_x0020_', invoices: count.get(v.number) || 0,
    }));
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
  const [vendors, hints] = await Promise.all([vendorIndex(ctx), readSetting<Hints>(hintsKey(ctx.companyName), {})]);
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
      score += 3 * hit.length / nw.length;
      if (nw.length > 1 && flat.includes(nw.join(' '))) score += 1;
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
  const v = (await vendorIndex(ctx)).find(x => x.number.toLowerCase() === number.trim().toLowerCase());
  return v ? { number: v.number, name: v.name, currency: vendorCurrency(v) || companyCurrency(ctx.companyName), score: 0, reasons: ['elegido a mano'], invoices: v.invoices } : null;
}

// Búsqueda por nº o nombre para elegir el proveedor a mano
export async function searchVendors(ctx: BcContext, term: string) {
  const t = norm(term.trim());
  if (t.length < 2) return [];
  return (await vendorIndex(ctx))
    .filter(v => v.number.toLowerCase().includes(t) || norm(v.name).includes(t))
    .sort((a, b) => b.invoices - a.invoices)
    .slice(0, 20)
    .map(v => ({ number: v.number, name: v.name, currency: vendorCurrency(v) || companyCurrency(ctx.companyName), invoices: v.invoices }));
}

// ---------- Facturas anteriores del proveedor ----------
const toLine = (l: any): OcrLine => ({
  lineType: l.lineType, number: l.lineObjectNumber || '', description: l.description || '', description2: l.description2 || '',
  quantity: l.quantity, unitCost: l.unitCost ?? l.directUnitCost ?? 0, taxCode: l.taxCode || '',
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
    $orderby: 'postingDate desc', $top: '15', $expand: 'purchaseInvoiceLines',
  }));
  const raw: any[] = data.value || [];
  const history: HistoryInvoice[] = raw.map(i => ({
    number: i.number, vendorInvoiceNumber: i.vendorInvoiceNumber, invoiceDate: i.invoiceDate, postingDate: i.postingDate, dueDate: i.dueDate,
    currency: i.currencyCode, net: i.totalAmountExcludingTax, total: i.totalAmountIncludingTax,
    lines: (i.purchaseInvoiceLines || []).sort((a: any, b: any) => a.sequence - b.sequence).map(toLine).filter((l: OcrLine) => l.lineType !== 'Comment' || l.description),
  }));
  // Ejemplos con PDF: uno por cada combinación distinta de artículos/cuentas, de las más recientes
  const seen = new Set<string>();
  const picks = raw.filter(i => {
    const sig = (i.purchaseInvoiceLines || []).map((l: any) => l.lineObjectNumber).sort().join('|');
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  }).slice(0, 3);
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
      return text ? { number: i.number as string, text: text.substring(0, 3500) } : null;
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

// ---------- Propuesta con IA ----------
const isDate = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() && isFinite(Number(v)) ? Number(v) : null);

export async function suggest(text: string, pdf: Uint8Array | null, vendor: VendorCandidate | null, history: HistoryInvoice[], examples: { number: string; text: string }[]): Promise<OcrSuggestion> {
  const hist = history.map(h => ({
    invoice: h.number, vendorInvoiceNo: h.vendorInvoiceNumber, invoiceDate: h.invoiceDate, postingDate: h.postingDate, dueDate: h.dueDate,
    currency: h.currency, netAmount: h.net, totalAmount: h.total,
    lines: h.lines.map(l => ({ type: l.lineType, no: l.number, description: l.description, description2: l.description2, quantity: l.quantity, unitCost: l.unitCost, vatGroup: l.taxCode })),
  }));
  const prompt = `Eres contable de CRAZE y registras facturas de proveedor en Microsoft Dynamics 365 Business Central como Purchase Invoice.
Lee la factura nueva y propón la cabecera y las líneas EXACTAMENTE como se han registrado las facturas anteriores de este proveedor.

Proveedor: ${vendor ? `${vendor.number} ${vendor.name} (divisa ${vendor.currency})` : 'desconocido'}

Facturas anteriores registradas de este proveedor (más recientes primero), con sus líneas en BC:
${hist.length ? JSON.stringify(hist) : 'ninguna'}

${examples.map(e => `Texto del PDF de la factura anterior ${e.number} (para ver cómo se pasó del PDF a las líneas):\n"""\n${e.text}\n"""`).join('\n\n')}

${text ? `Texto de la factura NUEVA:\n"""\n${text.substring(0, 15000)}\n"""` : 'La factura NUEVA es el PDF adjunto (escaneado).'}

Reglas:
- Usa solo combinaciones de tipo (type), nº (no) y grupo de IVA (vatGroup) que aparezcan en las facturas anteriores; elige la que corresponda al concepto de cada cargo de la factura nueva (compara con los PDFs anteriores). Si no hay facturas anteriores, deja "no" y "vatGroup" vacíos.
- Descripción y Description 2 con el mismo estilo que las anteriores, adaptando lo que cambie (periodo, nº de contenedor, referencia…).
- Misma forma de cantidades que las anteriores (p. ej. 1 × importe). unitCost en la divisa de la factura, SIN IVA (los importes de las líneas no llevan IVA).
- La suma de quantity × unitCost debe ser el importe neto (sin IVA) de la factura nueva.
- postingDate: sigue la costumbre de las anteriores (normalmente = invoiceDate). dueDate: el vencimiento que indique la factura, o "" si no lo indica.
- documentType "credit_note" si el documento es un abono (Gutschrift, credit note, nota de crédito), si no "invoice".
- Fechas en formato YYYY-MM-DD; importes como números con punto decimal.

Responde SOLO con este JSON:
{"documentType":"invoice","invoiceNo":"","invoiceDate":"","postingDate":"","dueDate":"","currency":"","net":0,"vat":0,"total":0,"lines":[{"type":"Item","no":"","description":"","description2":"","quantity":1,"unitCost":0,"vatGroup":""}],"comment":"breve explicación en español de cómo has elegido las líneas o de lo que haya que revisar"}`;
  const parts: AiPart[] = [prompt];
  if (!text && pdf) parts.push({ inlineData: { data: Buffer.from(pdf).toString('base64'), mimeType: 'application/pdf' } });
  const raw = await generateText(parts, { json: true, timeoutMs: 40_000 });
  const j = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  return {
    documentType: j.documentType === 'credit_note' ? 'credit_note' : 'invoice',
    invoiceNo: String(j.invoiceNo || '').trim(),
    invoiceDate: isDate(j.invoiceDate) ? j.invoiceDate : '',
    postingDate: isDate(j.postingDate) ? j.postingDate : isDate(j.invoiceDate) ? j.invoiceDate : '',
    dueDate: isDate(j.dueDate) ? j.dueDate : '',
    currency: String(j.currency || '').toUpperCase(),
    net: num(j.net), vat: num(j.vat), total: num(j.total),
    lines: (Array.isArray(j.lines) ? j.lines : []).map((l: any) => ({
      lineType: String(l.type || 'Item'), number: String(l.no || ''), description: String(l.description || '').substring(0, 100),
      description2: String(l.description2 || '').substring(0, 50), quantity: num(l.quantity) ?? 1, unitCost: num(l.unitCost) ?? 0, taxCode: String(l.vatGroup || ''),
    })),
    comment: String(j.comment || ''),
  };
}

// Sin IA: las líneas de la última factura del proveedor, a revisar a mano
function fromLastInvoice(history: HistoryInvoice[]): OcrSuggestion {
  const last = history[0];
  return {
    documentType: 'invoice', invoiceNo: '', invoiceDate: '', postingDate: '', dueDate: '', currency: last?.currency || '',
    net: null, vat: null, total: null, lines: last ? last.lines.map(l => ({ ...l })) : [],
    comment: last ? `Líneas copiadas de la última factura ${last.number}: revisa importes y datos.` : '',
  };
}

// Todo el proceso para un PDF. vendorNo: proveedor elegido a mano (si no, el mejor candidato)
export async function processPdf(ctx: BcContext, file: string, data: Uint8Array, vendorNo?: string): Promise<OcrResult> {
  const warnings: string[] = [];
  let text = '';
  try { text = await pdfText(data); } catch (e: any) { warnings.push(`No se ha podido leer el texto del PDF (${e.message}).`); }
  const scanned = text.replace(/\s/g, '').length < 40;
  if (scanned) text = '';
  const ids = identifiers(text);
  const currency = detectCurrency(text);
  const candidates = text ? await matchVendors(ctx, text, ids, currency) : [];
  const vendor = vendorNo ? await vendorByNumber(ctx, vendorNo) : candidates[0] || null;
  if (vendorNo && !vendor) warnings.push(`El proveedor ${vendorNo} no existe en ${ctx.companyName}.`);
  if (!vendor) warnings.push(scanned ? 'PDF escaneado: elige el proveedor a mano.' : 'No se ha reconocido el proveedor: elígelo a mano.');
  else if (!vendorNo && candidates[1] && candidates[1].score >= candidates[0].score - 0.5) {
    warnings.push(`Proveedor dudoso: ${candidates[1].number} ${candidates[1].name} también encaja. Revísalo.`);
  }

  const { history, examples } = vendor ? await vendorHistory(ctx, vendor.number) : { history: [], examples: [] };
  if (vendor && !history.length) warnings.push('Este proveedor no tiene facturas registradas: completa artículo/cuenta y grupo de IVA a mano.');

  let suggestion: OcrSuggestion | null = null;
  if (aiConfigured()) {
    try {
      suggestion = await suggest(text, scanned ? data : null, vendor, history, examples);
    } catch (e: any) {
      warnings.push(`La IA no ha podido proponer la factura (${String(e.message).substring(0, 200)}).`);
    }
  } else {
    warnings.push('Sin IA configurada (OPENROUTER_API_KEY): se copian las líneas de la última factura.');
  }
  if (!suggestion && vendor) suggestion = fromLastInvoice(history);
  if (suggestion?.documentType === 'credit_note') warnings.push('Parece un abono (credit note): aquí solo se crean facturas; regístralo como Credit Memo en BC.');
  if (suggestion && vendor && suggestion.currency && suggestion.currency !== vendor.currency) {
    warnings.push(`La factura está en ${suggestion.currency} y el proveedor ${vendor.number} en ${vendor.currency}: ¿es otro proveedor (p. ej. la ficha en ${suggestion.currency})?`);
  }
  const existing = vendor && suggestion?.invoiceNo ? await existingFor(ctx, vendor.number, suggestion.invoiceNo) : [];
  return { file, scanned, currency, ids, candidates, vendor, history, suggestion, existing, warnings };
}

// ---------- Crear en BC ----------
export type OcrCreateInput = {
  vendor: string; invoiceNo: string; invoiceDate: string; postingDate: string; dueDate: string;
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
  if (pdf) {
    try {
      await attachFile(ctx, id, pdf);
    } catch (e: any) {
      warnings.push(`No se ha podido adjuntar el PDF (${String(e.message).substring(0, 160)}); adjúntalo en BC.`);
    }
  }
  const after = await bcRequest('GET', headUrl, ctx.token).catch(() => null);
  return { no, net: after?.totalAmountExcludingTax ?? null, total: after?.totalAmountIncludingTax ?? null, currency: after?.currencyCode || '', warnings };
}
