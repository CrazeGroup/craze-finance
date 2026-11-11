import { bcFetchAll, getBcContext, odataUrl, type BcContext } from '@/lib/bcClient';
import { cached, HOUR, readSetting, writeSetting } from '@/lib/reporting/cache';
import { pdfText } from '@/lib/ocr';
import { CUSTOMER_NO, DFORCE_COMPANY } from '@/lib/dforce';

// MAGAZINES › ANALYSIS (Craze Entertainment): beneficio de cada revista, con la estructura de tareas del Project Card.
// - Ventas y devoluciones: líneas de facturas y abonos de venta registrados a D-FORCE (300353) de artículos cuya
//   descripción empieza por "MAGAZINE - ". La revista es el artículo (05995_2507); la localización, Description 2
//   (canal de D-FORCE). Tarea 001.001 = venta, 001.003 = devolución (sin tarea: factura = venta, abono = devolución);
//   una factura en 001.003 anula devoluciones. Las líneas negativas que BC genera en los abonos NON-REC (sin tarea ni
//   Description 2) no cuentan, igual que en el Project Card.
// - El resto se asigna por Project No. + Project Task No. de la línea: Magazine Ads (facturas a CRAZE GmbH, campos AIT),
//   costes de distribución (facturas de compra de D-FORCE y, en 2024/25, líneas de coste en sus facturas/abonos de venta)
//   y el resto de costes (Posted Purchase Invoice / Cr. Memo Lines: gadget, foilbag, diseño, imprenta…).
// - Proyecto → revista: 05995_AAMM = artículo 05995_AAMM; desde 2026 35420_AAMM → 05995_AAMM (Galupy),
//   38791_AAMM → 05993_AAMM (Inkee) y 35420_AAMM_SPECIAL → 05994_AAMM (Galupy Special).
// Importes en signo de resultado: ingresos +, costes −; beneficio = suma de todo.

const MAGAZINE_DESC = /^MAGAZINE\s*-\s*/i;
const ITEM_RE = /^0599\d_\d{4}$/;
const TASK_SALES = '001.001';
const TASK_RETURNS = '001.003';
const TASK_ADS = '001.004';

export type MagEntry = {
  task: string; qty: number; value: number;
  kind: 'salesInv' | 'salesCrMemo' | 'purchInv' | 'purchCrMemo';
  doc: string; date: string; partner: string; no: string; description: string; location: string;
  fixed?: string;   // corrección hecha en la app (proyecto equivocado o sin proyecto)
};
// Línea que la app asigna a otra revista que la de su Project No. en BC (o que no lo tenía)
export type Correction = {
  reason: string; kind: MagEntry['kind']; doc: string; date: string; partner: string; no: string; description: string;
  location: string; qty: number; amount: number; bcProject: string; bcTask: string; magazine: string; task: string;
  key?: string; manual?: boolean;   // asignada a mano en la app (se puede quitar)
};
export type MagLocation = { location: string; soldQty: number; soldAmount: number; retQty: number; retAmount: number };
export type Magazine = {
  item: string; project: string; projects: string[]; title: string; issue: string; description: string;
  onSaleDate: string; printRun: number; status: string;
  tasks: Record<string, { qty: number; value: number }>;
  locations: MagLocation[];
  entries: MagEntry[];
};
export type Unassigned = { key: string; pdf?: string; suggestedTask?: string; reason: string; kind: MagEntry['kind']; doc: string; date: string; partner: string; no: string; description: string; project: string; task: string; qty: number; amount: number };
export type MagazineAnalysis = {
  magazines: Magazine[];
  taskNames: Record<string, string>;
  unassigned: Unassigned[];
  corrections: Correction[];
  generatedAt: string;
};

const TITLES: Record<string, string> = { '05995': 'Galupy', '05993': 'Inkee', '05994': 'Galupy Special' };

// Proyecto → artículo de la revista
export function magazineOfProject(project: string): string {
  const p = project.trim().toUpperCase();
  let m = p.match(/^(0599\d)_(\d{4})$/);
  if (m) return `${m[1]}_${m[2]}`;
  m = p.match(/^(35420|38791)_(\d{4})(_SPECIAL)?$/);
  if (m) return `${m[3] ? '05994' : m[1] === '35420' ? '05995' : '05993'}_${m[2]}`;
  return '';
}

// Revista escrita en un texto: "MAGAZINE - INKEE 01/25 ADS", "MAGAZINE - GALUPY 01/26 SPECIAL ADS", "(Magazine - Galupy 04/25)"
export function magazineFromText(text: string): string {
  const m = String(text || '').match(/MAGAZINE\s*-\s*(GALUPY|INKEE)\s*(SPECIAL\s*)?(\d{1,2})\s*\/\s*(\d{2})(\s*SPECIAL)?/i);
  if (!m) return '';
  const prefix = m[1].toUpperCase() === 'INKEE' ? '05993' : m[2] || m[5] ? '05994' : '05995';
  return `${prefix}_${m[4]}${m[3].padStart(2, '0')}`;
}
const isAds = (description: string) => /magazine\s*ads?\b/i.test(description);
// Almacenaje y handling sin proyecto son costes generales, no de una revista
const isGeneralCost = (no: string, description: string) => /^AA-0000(9|10)$/.test(no) || /storage|handling/i.test(description);

// Description 2 de D-FORCE con variantes de escritura → un nombre
function normLocation(s: string) {
  const t = String(s || '').trim().replace(/\s+/g, ' ').replace(/^Grosso\s*-\s*/i, 'Grosso - ');
  if (!t) return '(sin localización)';
  if (/^bahnhofsbu[s]?chhandel$/i.test(t)) return 'Bahnhofsbuchhandel';
  return t;
}

const s = (v: any) => String(v ?? '').trim();
const n = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);

async function readAll(ctx: BcContext) {
  const sel = 'documentNo,lineNo,type,no,description,description2,quantity,amount,postingDate';
  const [salesInv, salesCr, purchInv, purchCr, tasks, projects, customers, vendors, invHeads, crHeads] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.customApiBase}/salesInvoiceLines`, { $select: `${sel},sellToCustomerNo,aitJobNo,aitJobTaskNo` }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/salesCrMemoLines`, { $select: `${sel},sellToCustomerNo,aitJobNo,aitJobTaskNo,returnReasonCode` }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/purchInvLines`, { $select: `${sel},buyFromVendorNo,jobNo,jobTaskNo` }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/purchCrMemoLines`, { $select: 'documentNo,lineNo,type,no,description,quantity,amount,buyFromVendorNo,jobNo,jobTaskNo' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/jobTasks`, { $select: 'jobNo,jobTaskNo,description' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Project_Card_CRZ`, { $select: 'No,Description,On_Sale_Date_BCT,Print_Run_BCT,Status' }), ctx.token)
      .catch(() => [] as any[]),
    bcFetchAll(odataUrl(`${ctx.apiBase}/customers`, { $select: 'number,displayName' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, { $select: 'number,displayName' }), ctx.token),
    // External Document No. de las facturas/abonos de venta: en los Magazine Ads dice la revista ("MAGAZINE - INKEE 01/25 ADS")
    bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, { $filter: `customerNumber ne '${CUSTOMER_NO}'`, $select: 'number,externalDocumentNumber' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.apiBase}/salesCreditMemos`, { $filter: `customerNumber ne '${CUSTOMER_NO}'`, $select: 'number,externalDocumentNumber' }), ctx.token),
  ]);
  const extDoc = new Map<string, string>([...invHeads, ...crHeads].map((h: any) => [s(h.number), s(h.externalDocumentNumber)]));
  return { salesInv, salesCr, purchInv, purchCr, tasks, projects, customers, vendors, extDoc };
}

// Las líneas de abono de compra no traen fecha: se toma de la cabecera
async function purchCrDates(ctx: BcContext) {
  const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/purchCrMemoHeaders`, { $select: 'no,postingDate' }), ctx.token).catch(() => [] as any[]);
  return new Map(rows.map((r: any) => [s(r.no), s(r.postingDate)]));
}

// Revistas que cita un texto: "INKEE“, Ausgabe 0225", "Galupy 07/25", "GALUPY SPECIAL 01/2026" → artículos
export function magazinesInText(text: string) {
  const out = new Map<string, string>();
  const re = /(GALUPY|INKEE)(\s*SPECIAL)?[^\n\d]{0,40}?(\d{1,2})\s*[\/\-.]?\s*(?:20)?(\d{2})(?!\d)/gi;
  for (const m of String(text || '').replace(/\s+/g, ' ').matchAll(re)) {
    const mm = +m[3];
    if (mm < 1 || mm > 12) continue;
    const item = `${m[1].toUpperCase() === 'INKEE' ? '05993' : m[2] ? '05994' : '05995'}_${m[4]}${String(mm).padStart(2, '0')}`;
    if (!out.has(item)) {
      const i = m.index || 0;
      out.set(item, text.replace(/\s+/g, ' ').substring(Math.max(0, i - 40), i + m[0].length + 10).trim());
    }
  }
  return out;
}

type PdfMags = { mags: string[]; snippet: string; error?: string };
// Lee (una sola vez: se guarda por documento en el ajuste magazines:pdf-mags) el PDF adjunto de cada compra
async function pdfMagazines(ctx: BcContext, docs: [string, MagEntry['kind']][]): Promise<Record<string, PdfMags>> {
  const stored = await readSetting<Record<string, PdfMags>>('magazines:pdf-mags', {});
  const todo = docs.filter(([doc]) => !stored[doc]);
  if (!todo.length) return stored;
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`BC ${res.status}`);
    return res;
  };
  const transient: Record<string, PdfMags> = {};
  for (const [doc, kind] of todo.slice(0, 40)) {
    const credit = kind === 'purchCrMemo';
    try {
      const head = (await (await get(odataUrl(`${ctx.apiBase}/${credit ? 'purchaseCreditMemos' : 'purchaseInvoices'}`, { $filter: `number eq '${doc.replace(/'/g, "''")}'`, $select: 'id' }))).json()).value?.[0];
      if (!head) { stored[doc] = { mags: [], snippet: '', error: 'Documento no encontrado en BC' }; continue; }
      const atts: any[] = (await (await get(odataUrl(`${ctx.apiBase}/documentAttachments`, {
        $filter: `parentType eq '${credit ? 'Purchase Credit Memo' : 'Purchase Invoice'}' and parentId eq ${head.id}`, $select: 'id,fileName',
      }))).json()).value || [];
      const files = atts.filter(a => /\.pdf$/i.test(a.fileName || ''));
      if (!files.length) { stored[doc] = { mags: [], snippet: '', error: 'Sin PDF adjunto en BC' }; continue; }
      const found = new Map<string, string>();
      for (const a of files) {
        const text = await pdfText(new Uint8Array(await (await get(`${ctx.apiBase}/documentAttachments(${a.id})/attachmentContent`)).arrayBuffer())).catch(() => '');
        magazinesInText(text).forEach((v, k) => { if (!found.has(k)) found.set(k, v); });
      }
      stored[doc] = { mags: Array.from(found.keys()), snippet: Array.from(found.values())[0] || '' };
    } catch (e: any) {
      // Error de BC: no se guarda, se reintenta en el próximo cálculo
      transient[doc] = { mags: [], snippet: '', error: `No se ha podido leer el PDF: ${String(e.message).substring(0, 80)}` };
    }
  }
  await writeSetting('magazines:pdf-mags', stored);
  return { ...stored, ...transient };
}

export async function computeMagazineAnalysis(ctx: BcContext): Promise<MagazineAnalysis> {
  const [raw, crDates] = await Promise.all([readAll(ctx), purchCrDates(ctx)]);
  const custName = new Map(raw.customers.map((c: any) => [s(c.number), s(c.displayName)]));
  const vendName = new Map(raw.vendors.map((v: any) => [s(v.number), s(v.displayName)]));

  const mags = new Map<string, Magazine>();
  const projectInfo = new Map(raw.projects.map((p: any) => [s(p.No).toUpperCase(), p]));
  const mag = (item: string): Magazine => {
    let m = mags.get(item);
    if (!m) {
      m = {
        item, project: '', projects: [], title: TITLES[item.substring(0, 5)] || item.substring(0, 5),
        issue: item.substring(6), description: '', onSaleDate: '', printRun: 0, status: '', tasks: {}, locations: [], entries: [],
      };
      mags.set(item, m);
    }
    return m;
  };
  const addProject = (m: Magazine, project: string) => { if (project && !m.projects.includes(project)) m.projects.push(project); };
  const locs = new Map<string, Map<string, MagLocation>>();
  const unassigned: Unassigned[] = [];
  const corrections: Correction[] = [];
  // Magazine Ads sin revista en el proyecto ni en el External Document No. (IN-CE-00009…): se asignan después por fecha
  const pendingAds: { key: string; base: Omit<MagEntry, 'task' | 'qty' | 'value' | 'location'>; qty: number; amount: number; project: string; task: string }[] = [];

  const push = (m: Magazine, e: MagEntry) => {
    m.entries.push(e);
    const t = (m.tasks[e.task] ||= { qty: 0, value: 0 });
    t.qty += e.qty; t.value += e.value;
  };

  // ---- Ventas (facturas y abonos) ----
  const sales = (rows: any[], kind: 'salesInv' | 'salesCrMemo') => {
    const sign = kind === 'salesInv' ? 1 : -1;
    for (const r of rows) {
      if (s(r.type) !== 'Item' && !s(r.no)) continue;
      const customer = s(r.sellToCustomerNo);
      const project = s(r.aitJobNo);
      const task = s(r.aitJobTaskNo);
      const amount = n(r.amount), qty = n(r.quantity);
      const isDforce = customer === CUSTOMER_NO;
      const partner = custName.get(customer) || customer;
      const base = { kind, doc: s(r.documentNo), date: s(r.postingDate), partner, no: s(r.no), description: s(r.description) };

      if (isDforce && MAGAZINE_DESC.test(s(r.description))) {
        // Contrapartida que BC genera en los abonos NON-REC: no es una devolución
        if (kind === 'salesCrMemo' && s(r.returnReasonCode) === 'NON-REC' && qty < 0 && !task) continue;
        const item = ITEM_RE.test(s(r.no)) ? s(r.no) : magazineOfProject(project) || s(r.no);
        const m = mag(item);
        if (!m.description) m.description = s(r.description);
        // Proyecto de otra revista: manda el artículo (en todas coincide con la revista de la descripción)
        const pm = magazineOfProject(project);
        const wrong = !!project && !!pm && pm !== item;
        if (!wrong) addProject(m, project);
        const t = task === TASK_SALES || task === TASK_RETURNS ? task : kind === 'salesInv' ? TASK_SALES : TASK_RETURNS;
        const location = normLocation(r.description2);
        const fixed = wrong ? `En BC con el proyecto ${project} (${pm}); se cuenta en ${item}, la revista del artículo` : undefined;
        if (wrong) corrections.push({ reason: 'Proyecto de otra revista', ...base, location, qty: sign * qty, amount: sign * amount, bcProject: project, bcTask: task, magazine: item, task: t });
        push(m, { ...base, task: t, qty: sign * qty, value: sign * amount, location, fixed });
        const byLoc = locs.get(item) || new Map<string, MagLocation>();
        locs.set(item, byLoc);
        const l = byLoc.get(location) || { location, soldQty: 0, soldAmount: 0, retQty: 0, retAmount: 0 };
        byLoc.set(location, l);
        if (t === TASK_SALES) { l.soldQty += sign * qty; l.soldAmount += sign * amount; }
        else { l.retQty -= sign * qty; l.retAmount -= sign * amount; }
        continue;
      }
      if (!amount) continue;
      // Resto de líneas de venta (Magazine Ads a CRAZE GmbH, costes de D-FORCE en sus documentos de venta): por proyecto.
      // Magazine Ads: la revista del External Document No. manda (corrige un proyecto equivocado o que falta).
      const ads = isAds(base.description);
      const fromText = ads ? magazineFromText(raw.extDoc.get(base.doc) || '') || magazineFromText(base.description) : '';
      const pm = magazineOfProject(project);
      const item = fromText || pm;
      const lineTask = task || (ads ? TASK_ADS : '');
      if (item && lineTask && (item !== pm || lineTask !== task)) {
        const reason = !project ? 'Sin Project No.: revista del External Document No.' : item !== pm ? 'Proyecto de otra revista según el External Document No.' : 'Sin Project Task No.: Magazine Ads';
        corrections.push({ reason, ...base, location: '', qty: sign * qty, amount: sign * amount, bcProject: project, bcTask: task, magazine: item, task: lineTask });
        const m = mag(item);
        push(m, { ...base, task: lineTask, qty: sign * qty, value: sign * amount, location: '', fixed: `${reason} (${raw.extDoc.get(base.doc) || base.description})` });
        continue;
      }
      if (ads && !item) { pendingAds.push({ key: `${kind}|${base.doc}|${s(r.lineNo)}`, base, qty: sign * qty, amount: sign * amount, project, task }); continue; }
      if (!item || !task) {
        // Solo interesan las de revistas: D-FORCE o con aspecto de anuncio / proyecto (almacenaje y handling sin proyecto no)
        if (isGeneralCost(base.no, base.description) && !project) continue;
        if (isDforce || project || /magazine|galupy|inkee/i.test(s(r.description))) {
          unassigned.push({
            key: `${kind}|${base.doc}|${s(r.lineNo)}`,
            reason: !project ? 'Sin Project No.' : !item ? 'Proyecto que no es de revista' : 'Sin Project Task No.',
            kind, doc: base.doc, date: base.date, partner, no: base.no, description: base.description, project, task, qty: sign * qty, amount: sign * amount,
          });
        }
        continue;
      }
      const m = mag(item);
      addProject(m, project);
      push(m, { ...base, task, qty: sign * qty, value: sign * amount, location: '' });
    }
  };
  sales(raw.salesInv, 'salesInv');
  sales(raw.salesCr, 'salesCrMemo');

  // Los Magazine Ads se facturan el día On Sale de su revista: la del mismo título (según la descripción) con la fecha
  // On Sale más cercana (máx. 21 días), prefiriendo las que aún no tienen Ads
  const onSale = new Map<string, string>();
  raw.projects.forEach((p: any) => {
    const item = magazineOfProject(s(p.No)), d = s(p.On_Sale_Date_BCT);
    if (item && d && !d.startsWith('0001') && !onSale.has(item)) onSale.set(item, d);
  });
  const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
  for (const a of pendingAds.sort((x, y) => x.base.date.localeCompare(y.base.date))) {
    const d = a.base.description;
    const prefix = /inkee/i.test(d) ? '05993' : /special/i.test(d) ? '05994' : /galupy/i.test(d) ? '05995' : '';
    const hasAds = (item: string) => Math.abs(mags.get(item)?.tasks[TASK_ADS]?.value || 0) > 0.01;
    const best = Array.from(onSale.entries())
      .filter(([item, date]) => item.startsWith(prefix) && prefix && a.base.date && days(date, a.base.date) <= 21)
      .sort((x, y) => Number(hasAds(x[0])) - Number(hasAds(y[0])) || days(x[1], a.base.date) - days(y[1], a.base.date))[0];
    if (!best) {
      unassigned.push({ key: a.key, suggestedTask: TASK_ADS, reason: 'Magazine Ads sin revista (ni proyecto ni External Document No.)', ...a.base, project: a.project, task: a.task, qty: a.qty, amount: a.amount });
      continue;
    }
    const reason = `Sin revista en BC: On Sale ${best[1].split('-').reverse().join('/')} (External Document No. ${raw.extDoc.get(a.base.doc) || '—'})`;
    corrections.push({ reason, ...a.base, location: '', qty: a.qty, amount: a.amount, bcProject: a.project, bcTask: a.task, magazine: best[0], task: TASK_ADS });
    push(mag(best[0]), { ...a.base, task: TASK_ADS, qty: a.qty, value: a.amount, location: '', fixed: reason });
  }

  // ---- Compras (facturas y abonos registrados) ----
  const projectVendors = new Set<string>();
  [...raw.purchInv, ...raw.purchCr].forEach((r: any) => { if (magazineOfProject(s(r.jobNo))) projectVendors.add(s(r.buyFromVendorNo)); });
  const pendingPurch: { sign: number; base: Omit<MagEntry, 'task' | 'qty' | 'value'>; u: Unassigned }[] = [];
  // Tarea habitual de cada artículo de compra en las líneas con proyecto (AA-00041 Proofreading → 004.004)
  const taskCount = new Map<string, Map<string, number>>();
  [...raw.purchInv, ...raw.purchCr].forEach((r: any) => {
    if (!magazineOfProject(s(r.jobNo)) || !s(r.jobTaskNo)) return;
    const c = taskCount.get(s(r.no)) || new Map<string, number>();
    c.set(s(r.jobTaskNo), (c.get(s(r.jobTaskNo)) || 0) + 1);
    taskCount.set(s(r.no), c);
  });
  const usualTask = (no: string) => Array.from(taskCount.get(no)?.entries() || []).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const purchases = (rows: any[], kind: 'purchInv' | 'purchCrMemo') => {
    const sign = kind === 'purchInv' ? -1 : 1;
    for (const r of rows) {
      const amount = n(r.amount);
      if (!amount) continue;
      const vendor = s(r.buyFromVendorNo);
      const project = s(r.jobNo), task = s(r.jobTaskNo);
      const item = magazineOfProject(project);
      const base = {
        kind, doc: s(r.documentNo), date: s(r.postingDate) || crDates.get(s(r.documentNo)) || '', partner: vendName.get(vendor) || vendor,
        no: s(r.no), description: s(r.description), location: '',
      };
      if ((!item || !task) && isGeneralCost(base.no, base.description)) continue;
      if (!item || !task) {
        // Sin proyecto: solo se avisa de los proveedores que trabajan para las revistas (los que tienen otras líneas con proyecto)
        if (project || projectVendors.has(vendor)) {
          pendingPurch.push({
            sign, base,
            u: {
              key: `${kind}|${base.doc}|${s(r.lineNo)}`,
              reason: !project ? 'Sin Project No.' : !item ? 'Proyecto que no es de revista' : 'Sin Project Task No.',
              kind, doc: base.doc, date: base.date, partner: base.partner, no: base.no, description: base.description, project, task, qty: n(r.quantity), amount: -sign * amount,
            },
          });
        }
        continue;
      }
      const m = mag(item);
      addProject(m, project);
      push(m, { ...base, task, qty: n(r.quantity) * -sign, value: sign * amount });
    }
  };
  purchases(raw.purchInv, 'purchInv');
  purchases(raw.purchCr, 'purchCrMemo');

  // Compras sin proyecto: la revista del PDF adjunto ("Korrektorat … des Magazins „INKEE“, Ausgabe 0225" → 05993_2502)
  const known = new Set<string>([...Array.from(mags.keys()), ...raw.projects.map((p: any) => magazineOfProject(s(p.No))).filter(Boolean)]);
  // Antes, fuera las facturas sin proyecto anuladas por un abono sin proyecto (mismo proveedor, artículo e importe):
  // se volvieron a registrar con proyecto, así que asignar solo la factura por su PDF contaría el coste dos veces
  const cancelled = new Set<number>();
  pendingPurch.forEach((p, i) => {
    if (cancelled.has(i)) return;
    const j = pendingPurch.findIndex((o, k) => k !== i && !cancelled.has(k) && o.u.partner === p.u.partner && o.u.no === p.u.no &&
      Math.abs(o.u.amount + p.u.amount) < 0.01 && o.u.kind !== p.u.kind);
    if (j >= 0) { cancelled.add(i); cancelled.add(j); }
  });
  pendingPurch.splice(0, pendingPurch.length, ...pendingPurch.filter((_, i) => !cancelled.has(i)));
  const pdfs = await pdfMagazines(ctx, Array.from(new Map(pendingPurch.map(p => [p.u.doc, p.u.kind])).entries()));
  for (const p of pendingPurch) {
    const found = pdfs[p.u.doc];
    const list = (found?.mags || []).filter(m => known.has(m));
    const task = p.u.task || usualTask(p.u.no);
    if (list.length === 1 && task) {
      const reason = `Sin Project No.: revista del PDF («${found.snippet}»)`;
      corrections.push({ reason, ...p.base, qty: p.u.qty, amount: p.u.amount, bcProject: p.u.project, bcTask: p.u.task, magazine: list[0], task });
      push(mag(list[0]), { ...p.base, task, qty: p.u.qty * -p.sign, value: -p.u.amount, fixed: reason });
      continue;
    }
    const pdf = !found ? undefined
      : found.error ? found.error
      : list.length > 1 ? `El PDF menciona varias revistas: ${list.join(', ')}`
      : list.length === 1 ? `El PDF dice ${list[0]}, pero no se sabe la tarea del artículo ${p.u.no}`
      : 'El PDF no dice la revista';
    unassigned.push({ ...p.u, pdf, suggestedTask: p.u.task || usualTask(p.u.no) });
  }

  // Proyectos de revista sin movimientos también aparecen (p. ej. números aún sin vender)
  for (const p of raw.projects) {
    const item = magazineOfProject(s(p.No));
    if (item && /^MAGAZINE/i.test(s(p.Description))) addProject(mag(item), s(p.No));
  }

  // Nombres de tarea: los del proyecto (estructura común a todas las revistas)
  const taskNames: Record<string, string> = {};
  const counts = new Map<string, Map<string, number>>();
  for (const t of raw.tasks) {
    if (!magazineOfProject(s(t.jobNo))) continue;
    const c = counts.get(s(t.jobTaskNo)) || new Map<string, number>();
    c.set(s(t.description), (c.get(s(t.description)) || 0) + 1);
    counts.set(s(t.jobTaskNo), c);
  }
  counts.forEach((c, k) => { taskNames[k] = Array.from(c.entries()).sort((a, b) => b[1] - a[1])[0][0]; });

  const magazines = Array.from(mags.values()).map(m => {
    // Proyecto principal: el que corresponde a la revista por la regla (el de ventas si hay varios)
    m.projects.sort();
    m.project = m.projects.find(p => magazineOfProject(p) === m.item && projectInfo.has(p.toUpperCase())) || m.projects.find(p => magazineOfProject(p) === m.item) || m.projects[0] || '';
    const info: any = projectInfo.get(m.project.toUpperCase());
    if (info) {
      m.description = s(info.Description) || m.description;
      m.onSaleDate = s(info.On_Sale_Date_BCT).startsWith('0001') ? '' : s(info.On_Sale_Date_BCT);
      m.printRun = n(info.Print_Run_BCT);
      m.status = s(info.Status);
    }
    m.locations = Array.from(locs.get(m.item)?.values() || []).sort((a, b) => b.soldQty - a.soldQty);
    m.entries.sort((a, b) => a.task.localeCompare(b.task) || a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));
    Object.values(m.tasks).forEach(t => { t.qty = Math.round(t.qty * 100) / 100; t.value = Math.round(t.value * 100) / 100; });
    return m;
  }).sort((a, b) => b.issue.localeCompare(a.issue) || a.item.localeCompare(b.item));

  // Sin asignar: fuera las facturas anuladas por un abono del mismo importe (mismo cliente/proveedor y nº)
  const used = new Set<number>();
  unassigned.forEach((u, i) => {
    if (used.has(i)) return;
    const j = unassigned.findIndex((v, k) => k !== i && !used.has(k) && v.partner === u.partner && v.no === u.no &&
      Math.abs(v.amount + u.amount) < 0.01 && (v.kind.endsWith('CrMemo') !== u.kind.endsWith('CrMemo')));
    if (j >= 0) { used.add(i); used.add(j); }
  });
  unassigned.splice(0, unassigned.length, ...unassigned.filter((_, i) => !used.has(i)));

  return { magazines, taskNames, unassigned: unassigned.sort((a, b) => b.date.localeCompare(a.date)),
    corrections: corrections.sort((a, b) => b.date.localeCompare(a.date)), generatedAt: new Date().toISOString() };
}

export async function magazineAnalysis(force = false) {
  return cached('magazines:analysis:v5', HOUR, async () => computeMagazineAnalysis(await getBcContext(DFORCE_COMPANY)), force);
}

// Líneas sin revista dadas por buenas (no son de ninguna revista): no se vuelven a avisar. Clave tipo|documento|línea.
export type Validation = { by: string; at: string; description: string; doc: string };
const VALIDATED_KEY = 'magazines:validated';
export const validatedLines = () => readSetting<Record<string, Validation>>(VALIDATED_KEY, {});
export async function setValidated(lines: { key: string; doc: string; description: string }[], validated: boolean, by: string) {
  const all = await validatedLines();
  for (const l of lines) {
    if (validated) all[l.key] = { by, at: new Date().toISOString(), description: l.description, doc: l.doc };
    else delete all[l.key];
  }
  await writeSetting(VALIDATED_KEY, all);
  return all;
}

// Asignación a mano de una línea sin revista (selector en la página): revista + tarea, guardada en la app
// (ajuste magazines:manual) y aplicada al servir los datos, sin esperar a que se renueve la caché.
export type Manual = { magazine: string; task: string; by: string; at: string };
const MANUAL_KEY = 'magazines:manual';
export const manualLines = () => readSetting<Record<string, Manual>>(MANUAL_KEY, {});
export async function setManual(key: string, value: { magazine: string; task: string } | null, by: string) {
  const all = await manualLines();
  if (value) all[key] = { ...value, by, at: new Date().toISOString() };
  else delete all[key];
  await writeSetting(MANUAL_KEY, all);
  return all;
}

export function applyManual(data: MagazineAnalysis, manual: Record<string, Manual>): MagazineAnalysis {
  if (!Object.keys(manual).length) return data;
  const out: MagazineAnalysis = JSON.parse(JSON.stringify(data));
  const rest: Unassigned[] = [];
  for (const u of out.unassigned) {
    const a = manual[u.key];
    let m = a && out.magazines.find(x => x.item === a.magazine);
    if (!a || !a.task) { rest.push(u); continue; }
    if (!m) {
      m = { item: a.magazine, project: '', projects: [], title: TITLES[a.magazine.substring(0, 5)] || a.magazine.substring(0, 5), issue: a.magazine.substring(6),
        description: '', onSaleDate: '', printRun: 0, status: '', tasks: {}, locations: [], entries: [] };
      out.magazines.push(m);
    }
    // Importe del aviso: ventas en signo de ingreso; compras en positivo = coste
    const purchase = u.kind === 'purchInv' || u.kind === 'purchCrMemo';
    const value = purchase ? -u.amount : u.amount;
    const qty = purchase ? (u.kind === 'purchInv' ? u.qty : -u.qty) : u.qty;
    const reason = `Asignada a mano en la app (${a.by || 'usuario'}, ${a.at.substring(0, 10).split('-').reverse().join('/')})`;
    m.entries.push({ task: a.task, qty, value, kind: u.kind, doc: u.doc, date: u.date, partner: u.partner, no: u.no, description: u.description, location: '', fixed: reason });
    const t = (m.tasks[a.task] ||= { qty: 0, value: 0 });
    t.qty += qty; t.value += value;
    out.corrections.unshift({ reason, kind: u.kind, doc: u.doc, date: u.date, partner: u.partner, no: u.no, description: u.description, location: '',
      qty: u.qty, amount: u.amount, bcProject: u.project, bcTask: u.task, magazine: a.magazine, task: a.task, key: u.key, manual: true });
  }
  out.unassigned = rest;
  out.magazines.sort((a, b) => b.issue.localeCompare(a.issue) || a.item.localeCompare(b.item));
  return out;
}
