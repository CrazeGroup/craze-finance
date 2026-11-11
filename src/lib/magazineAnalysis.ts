import { bcFetchAll, getBcContext, odataUrl, type BcContext } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
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

export type MagEntry = {
  task: string; qty: number; value: number;
  kind: 'salesInv' | 'salesCrMemo' | 'purchInv' | 'purchCrMemo';
  doc: string; date: string; partner: string; no: string; description: string; location: string;
};
export type MagLocation = { location: string; soldQty: number; soldAmount: number; retQty: number; retAmount: number };
export type Magazine = {
  item: string; project: string; projects: string[]; title: string; issue: string; description: string;
  onSaleDate: string; printRun: number; status: string;
  tasks: Record<string, { qty: number; value: number }>;
  locations: MagLocation[];
  entries: MagEntry[];
};
export type Unassigned = { reason: string; kind: MagEntry['kind']; doc: string; date: string; partner: string; no: string; description: string; project: string; task: string; qty: number; amount: number };
export type MagazineAnalysis = {
  magazines: Magazine[];
  taskNames: Record<string, string>;
  unassigned: Unassigned[];
  mismatches: { doc: string; item: string; project: string; location: string; qty: number; amount: number }[];
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
  const [salesInv, salesCr, purchInv, purchCr, tasks, projects, customers, vendors] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.customApiBase}/salesInvoiceLines`, { $select: `${sel},sellToCustomerNo,aitJobNo,aitJobTaskNo` }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/salesCrMemoLines`, { $select: `${sel},sellToCustomerNo,aitJobNo,aitJobTaskNo,returnReasonCode` }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/purchInvLines`, { $select: `${sel},buyFromVendorNo,jobNo,jobTaskNo` }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/purchCrMemoLines`, { $select: 'documentNo,lineNo,type,no,description,quantity,amount,buyFromVendorNo,jobNo,jobTaskNo' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/jobTasks`, { $select: 'jobNo,jobTaskNo,description' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Project_Card_CRZ`, { $select: 'No,Description,On_Sale_Date_BCT,Print_Run_BCT,Status' }), ctx.token)
      .catch(() => [] as any[]),
    bcFetchAll(odataUrl(`${ctx.apiBase}/customers`, { $select: 'number,displayName' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, { $select: 'number,displayName' }), ctx.token),
  ]);
  return { salesInv, salesCr, purchInv, purchCr, tasks, projects, customers, vendors };
}

// Las líneas de abono de compra no traen fecha: se toma de la cabecera
async function purchCrDates(ctx: BcContext) {
  const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/purchCrMemoHeaders`, { $select: 'no,postingDate' }), ctx.token).catch(() => [] as any[]);
  return new Map(rows.map((r: any) => [s(r.no), s(r.postingDate)]));
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
  const mismatches: MagazineAnalysis['mismatches'] = [];

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
        addProject(m, project);
        const pm = magazineOfProject(project);
        if (project && pm && pm !== item) mismatches.push({ doc: base.doc, item, project, location: normLocation(r.description2), qty, amount });
        const t = task === TASK_SALES || task === TASK_RETURNS ? task : kind === 'salesInv' ? TASK_SALES : TASK_RETURNS;
        const location = normLocation(r.description2);
        push(m, { ...base, task: t, qty: sign * qty, value: sign * amount, location });
        const byLoc = locs.get(item) || new Map<string, MagLocation>();
        locs.set(item, byLoc);
        const l = byLoc.get(location) || { location, soldQty: 0, soldAmount: 0, retQty: 0, retAmount: 0 };
        byLoc.set(location, l);
        if (t === TASK_SALES) { l.soldQty += sign * qty; l.soldAmount += sign * amount; }
        else { l.retQty -= sign * qty; l.retAmount -= sign * amount; }
        continue;
      }
      if (!amount) continue;
      // Resto de líneas de venta (Magazine Ads a CRAZE GmbH, costes de D-FORCE en sus documentos de venta): por proyecto
      const item = magazineOfProject(project);
      if (!item || !task) {
        // Solo interesan las de revistas: D-FORCE o con aspecto de anuncio / proyecto
        if (isDforce || project || /magazine|galupy|inkee/i.test(s(r.description))) {
          unassigned.push({
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

  // ---- Compras (facturas y abonos registrados) ----
  const projectVendors = new Set<string>();
  [...raw.purchInv, ...raw.purchCr].forEach((r: any) => { if (magazineOfProject(s(r.jobNo))) projectVendors.add(s(r.buyFromVendorNo)); });
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
      if (!item || !task) {
        // Sin proyecto: solo se avisa de los proveedores que trabajan para las revistas (los que tienen otras líneas con proyecto)
        if (project || projectVendors.has(vendor)) {
          unassigned.push({
            reason: !project ? 'Sin Project No.' : !item ? 'Proyecto que no es de revista' : 'Sin Project Task No.',
            kind, doc: base.doc, date: base.date, partner: base.partner, no: base.no, description: base.description, project, task, qty: n(r.quantity), amount: -sign * amount,
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

  return { magazines, taskNames, unassigned: unassigned.sort((a, b) => b.date.localeCompare(a.date)), mismatches, generatedAt: new Date().toISOString() };
}

export async function magazineAnalysis(force = false) {
  return cached('magazines:analysis', HOUR, async () => computeMagazineAnalysis(await getBcContext(DFORCE_COMPANY)), force);
}
