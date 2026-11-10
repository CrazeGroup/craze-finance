import prisma from '@/lib/prisma';
import { BcContext, bcFetchAll, odataUrl } from '@/lib/bcClient';
import { checkTariffs, customsConfig, figureTariffs, itemTariffCard, parseCustomsPdf, TariffCheck, tariffStatus } from '@/lib/customs';

// Aduanas · Histórico: las facturas del proveedor Zoll (7300184, setting customsConfig) de un año, una por nº AT/C
// (Vendor Invoice No.). De cada una se lee el Einfuhrabgabenbescheid adjunto (v2 documentAttachments), se sacan sus
// posiciones y se comparan con el Tariff No. de los artículos de la factura de China (checkTariffs, lo mismo que al
// subir el PDF). El resultado se guarda por AT/C en ApiConfig (customs:tariffs:<empresa>:<AT/C>) y no se recalcula:
// cada llamada solo procesa los AT/C nuevos, los que caben en el tiempo de la función; el resto queda pendiente
// para la siguiente llamada (la página va llamando hasta terminar).

export type HistoryAnalysis = {
  atc: string; file: string; date: string; orders: string[]; transport: string[];
  zoll: number; eust: number; check: TariffCheck | null; warnings: string[]; error?: string; computedAt: string;
};
export type HistoryEntry = HistoryAnalysis & { invoiceNo: string; postingDate: string; status: string; amount: number };

const PREFIX = 'customs:tariffs:';
const BUDGET_MS = 40_000;
const PARALLEL = 4;
const q = (s: string) => s.replace(/'/g, "''");
const normAtc = (s: string) => (s || '').trim().replace(/\.+$/, '');
const key = (company: string, atc: string) => `${PREFIX}${company}:${atc}`;

async function stored(company: string): Promise<Map<string, HistoryAnalysis>> {
  const rows = await prisma.apiConfig.findMany({ where: { key: { startsWith: `${PREFIX}${company}:` } } });
  const out = new Map<string, HistoryAnalysis>();
  for (const r of rows) {
    try { const a = JSON.parse(r.config || ''); out.set(a.atc, a); } catch { /* fila dañada: se recalcula */ }
  }
  return out;
}

// Pedido / factura de China y contenedor indicados a mano para un AT/C (cuando el PDF no los trae o están mal)
export type HistoryManual = { orders: string[]; transport: string[]; by?: string; at: string };
const manualKey = (company: string) => `customs:tariff-manual:${company}`;
export async function historyManual(company: string): Promise<Record<string, HistoryManual>> {
  const row = await prisma.apiConfig.findUnique({ where: { key: manualKey(company) } });
  try { return row?.config ? JSON.parse(row.config) : {}; } catch { return {}; }
}
export async function setHistoryManual(company: string, atc: string, m: { orders: string[]; transport: string[]; by?: string }) {
  const all = await historyManual(company);
  const clean = (l: string[]) => l.map(x => String(x).trim()).filter(Boolean).slice(0, 10);
  const orders = clean(m.orders), transport = clean(m.transport);
  if (!orders.length && !transport.length) delete all[atc];
  else all[atc] = { orders, transport, by: m.by, at: new Date().toISOString() };
  const config = JSON.stringify(all);
  await prisma.apiConfig.upsert({ where: { key: manualKey(company) }, update: { config }, create: { key: manualKey(company), url: '', config } });
  return all;
}
// Un nº de factura de BC (CRZ-PI26-04421) se traduce a su Vendor Invoice No. (el nº de pedido de China, 2365-GWM-389)
async function resolveOrders(ctx: BcContext, orders: string[]) {
  return Promise.all(orders.map(async o => {
    if (!/^[A-Z]{2,4}-P[IC]\d{2}-\d+$/i.test(o) && !/^PI-\d+$/i.test(o)) return o;
    const posted = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Posted_Purchase_Invoice_Excel`, { $filter: `No eq '${q(o.toUpperCase())}'`, $select: 'No,Vendor_Invoice_No' }), ctx.token).catch(() => []);
    if (posted[0]?.Vendor_Invoice_No) return String(posted[0].Vendor_Invoice_No);
    const open = await bcFetchAll(odataUrl(`${ctx.customApiBase}/purchaseHeaders`, { $filter: `documentType eq 'Invoice' and no eq '${q(o.toUpperCase())}'`, $select: 'no,vendorInvoiceNo' }), ctx.token).catch(() => []);
    return String(open[0]?.vendorInvoiceNo || o);
  }));
}

async function analyse(ctx: BcContext, inv: { id: string; atc: string }, manual?: HistoryManual): Promise<HistoryAnalysis> {
  const base = { atc: inv.atc, file: '', date: '', orders: [], transport: [], zoll: 0, eust: 0, check: null, warnings: [] as string[], computedAt: new Date().toISOString() };
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`BC ${res.status}: ${(await res.text()).substring(0, 200)}`);
    return res;
  };
  try {
    const atts: any[] = (await (await get(odataUrl(`${ctx.apiBase}/documentAttachments`, {
      $filter: `parentType eq 'Purchase Invoice' and parentId eq ${inv.id}`, $select: 'id,fileName',
    }))).json()).value || [];
    const pdfs = atts.filter(a => /\.pdf$/i.test(a.fileName || ''));
    if (!pdfs.length) return { ...base, error: atts.length ? 'El adjunto no es un PDF' : 'Sin PDF adjunto en BC' };
    // Si hay varios PDF, el que trae ese AT/C (o el primero con posiciones)
    let doc: Awaited<ReturnType<typeof parseCustomsPdf>> | null = null;
    for (const a of pdfs) {
      const data = new Uint8Array(await (await get(`${ctx.apiBase}/documentAttachments(${a.id})/attachmentContent`)).arrayBuffer());
      const d = await parseCustomsPdf(a.fileName, data);
      if (normAtc(d.atc) === inv.atc) { doc = d; break; }
      if (!doc && d.positions.length) doc = d;
    }
    if (!doc) return { ...base, error: 'El PDF adjunto no es un Einfuhrabgabenbescheid (sin posiciones)' };
    // Lo indicado a mano manda sobre lo leído del PDF
    const orders = manual?.orders.length ? await resolveOrders(ctx, manual.orders) : doc.orders;
    const transport = manual?.transport.length ? manual.transport : doc.transport;
    const docWarnings = doc.warnings.filter(w => !(manual?.orders.length && /pedido/i.test(w)) && !(manual?.transport.length && /contenedor/i.test(w)));
    // Sin posiciones en el PDF pero con la factura de China: se listan sus artículos (sin posición) con su Tariff No.
    const check = doc.positions.length || (manual?.orders.length && orders.length) ? await checkTariffs(ctx, orders, doc.positions) : null;
    return {
      ...base, file: doc.file, date: doc.date, orders, transport, zoll: doc.zoll, eust: doc.eust, check,
      warnings: [
        ...(normAtc(doc.atc) !== inv.atc ? [`El PDF adjunto es de ${doc.atc || 'otro AT/C'}`] : []),
        ...(manual ? [`Pedido / contenedor indicados a mano${manual.by ? ` por ${manual.by}` : ''} (${manual.at.substring(0, 10)})`] : []),
        ...docWarnings,
      ],
    };
  } catch (e: any) {
    return { ...base, error: String(e.message).substring(0, 300) };
  }
}

// recompute: AT/C a recalcular ('*' = todos los del año, también los que dieron error)
export async function customsHistory(ctx: BcContext, company: string, year: number, recompute?: string) {
  const started = Date.now();
  const cfg = await customsConfig();
  const invoices = await bcFetchAll(odataUrl(`${ctx.apiBase}/purchaseInvoices`, {
    $filter: `vendorNumber eq '${q(cfg.zollVendor)}' and postingDate ge ${year}-01-01 and postingDate le ${year}-12-31`,
    $select: 'id,number,vendorInvoiceNumber,postingDate,status,totalAmountExcludingTax',
  }), ctx.token);
  // Una por AT/C (sin el punto final que a veces se escribe); la registrada antes que el borrador
  const byAtc = new Map<string, any>();
  for (const inv of invoices) {
    const atc = normAtc(inv.vendorInvoiceNumber);
    if (!atc) continue;
    const prev = byAtc.get(atc);
    if (!prev || (prev.status === 'Draft' && inv.status !== 'Draft')) byAtc.set(atc, { ...inv, atc });
  }

  const cache = await stored(company);
  const manual = await historyManual(company);
  // Recalcular todo = borrar lo guardado de ese año; las siguientes llamadas siguen como con AT/C nuevos
  if (recompute === '*') {
    await prisma.apiConfig.deleteMany({ where: { key: { in: Array.from(byAtc.keys()).map(atc => key(company, atc)) } } });
    for (const atc of byAtc.keys()) cache.delete(atc);
  }
  const todo = Array.from(byAtc.values()).filter(i => !cache.has(i.atc) || recompute === i.atc)
    .sort((a, b) => String(b.postingDate).localeCompare(String(a.postingDate)));
  let next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() - started < BUDGET_MS) {
      const inv = todo[next++];
      const a = await analyse(ctx, inv, manual[inv.atc]);
      const config = JSON.stringify(a);
      await prisma.apiConfig.upsert({ where: { key: key(company, inv.atc) }, update: { config }, create: { key: key(company, inv.atc), url: '', config } });
      cache.set(inv.atc, a);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const entries: HistoryEntry[] = Array.from(byAtc.values()).filter(i => cache.has(i.atc)).map(i => ({
    ...cache.get(i.atc)!, invoiceNo: i.number, postingDate: String(i.postingDate || '').substring(0, 10), status: i.status, amount: Number(i.totalAmountExcludingTax) || 0,
  })).sort((a, b) => b.postingDate.localeCompare(a.postingDate) || b.atc.localeCompare(a.atc));
  const pending = todo.length - Math.min(next, todo.length);
  return { company: ctx.companyName, year, vendor: cfg.zollVendor, total: byAtc.size, pending, entries, notes: await historyNotes(company), manual };
}

// Actualiza un artículo en todas las declaraciones guardadas de la empresa con su ficha actual de BC (Tariff No., %,
// descripción y estado), sin volver a leer los PDFs
export async function refreshHistoryItem(ctx: BcContext, company: string, no: string) {
  const card = await itemTariffCard(ctx, no);
  const rows = await prisma.apiConfig.findMany({ where: { key: { startsWith: `${PREFIX}${company}:` } } });
  let updated = 0;
  const checks: Record<string, TariffCheck> = {};
  const writes: Promise<unknown>[] = [];
  for (const row of rows) {
    let a: HistoryAnalysis;
    try { a = JSON.parse(row.config || ''); } catch { continue; }
    if (!a.check) continue;
    let changed = false;
    const figures = figureTariffs(a.check.positions);
    const fix = (i: any, tariff: string, pos: number | null) => {
      if (i.no !== no) return;
      i.bcTariff = card?.bcTariff || ''; i.bcRate = card?.bcRate ?? null;
      if (card?.description) i.description = card.description;
      const st = tariffStatus(!!card, i.bcTariff, tariff, pos != null ? figures.get(pos) : null);
      i.status = st.status;
      if (st.note) i.note = st.note; else delete i.note;
      changed = true;
    };
    for (const p of a.check.positions) for (const i of p.items) fix(i, p.tariff, p.pos);
    for (const i of a.check.unassigned) fix(i, '', null);
    if (changed) {
      writes.push(prisma.apiConfig.update({ where: { key: row.key }, data: { config: JSON.stringify(a) } }));
      checks[a.atc] = a.check;
      updated++;
    }
  }
  // Las escrituras en paralelo; la página recibe solo las declaraciones cambiadas
  await Promise.all(writes);
  return { no, card, updated, checks };
}

// Notas por línea (AT/C | posición | artículo): descartada (error de la declaración) y/o comentario. Aparte del
// análisis, para que no se pierdan al volver a leer los PDFs
export type HistoryNote = { ignored?: boolean; approved?: boolean; comment?: string; by?: string; at: string };
const notesKey = (company: string) => `customs:tariff-notes:${company}`;
export async function historyNotes(company: string): Promise<Record<string, HistoryNote>> {
  const row = await prisma.apiConfig.findUnique({ where: { key: notesKey(company) } });
  try { return row?.config ? JSON.parse(row.config) : {}; } catch { return {}; }
}
export async function setHistoryNote(company: string, lineKey: string, note: { ignored?: boolean; approved?: boolean; comment?: string; by?: string }) {
  const notes = await historyNotes(company);
  const comment = (note.comment || '').trim().slice(0, 500);
  // Descartada (error de la declaración) o dada por buena (p. ej. un artículo sin posición correcto): una u otra
  const approved = !!note.approved && !note.ignored;
  if (!note.ignored && !approved && !comment) delete notes[lineKey];
  else notes[lineKey] = { ignored: !!note.ignored, approved, comment, by: note.by, at: new Date().toISOString() };
  const config = JSON.stringify(notes);
  await prisma.apiConfig.upsert({ where: { key: notesKey(company) }, update: { config }, create: { key: notesKey(company), url: '', config } });
  return notes;
}
