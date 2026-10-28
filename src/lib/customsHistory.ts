import prisma from '@/lib/prisma';
import { BcContext, bcFetchAll, odataUrl } from '@/lib/bcClient';
import { checkTariffs, customsConfig, parseCustomsPdf, TariffCheck } from '@/lib/customs';

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

async function analyse(ctx: BcContext, inv: { id: string; atc: string }): Promise<HistoryAnalysis> {
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
    const check = doc.positions.length ? await checkTariffs(ctx, doc.orders, doc.positions) : null;
    return {
      ...base, file: doc.file, date: doc.date, orders: doc.orders, transport: doc.transport, zoll: doc.zoll, eust: doc.eust, check,
      warnings: [...(normAtc(doc.atc) !== inv.atc ? [`El PDF adjunto es de ${doc.atc || 'otro AT/C'}`] : []), ...doc.warnings],
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
      const a = await analyse(ctx, inv);
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
  return { company: ctx.companyName, year, vendor: cfg.zollVendor, total: byAtc.size, pending, entries };
}
