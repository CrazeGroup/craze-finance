import * as XLSX from 'xlsx';
import { bcFetchAll, odataUrl, type BcContext } from '@/lib/bcClient';
import { bcRequest } from '@/lib/bcWrite';
import { readSetting, writeSetting } from '@/lib/reporting/cache';

// MAGAZINES › MAILFINISH (Craze Entertainment): los gadgets que Mailfinish recupera de revistas devueltas se dan de alta
// con Assembly Orders (output = gadget, input = la revista de la que sale, 1:1), como las de julio/agosto de 2026:
// - Columna "I. Wahl" del informe de Mailfinish (recuperado en buen estado) → location MAILFINISH.
// - Columna "II.Wahl, UNVERBRAUCHBAR" (recuperado pero dañado) → location DESTR MAIL.
// La revista de entrada se sugiere con las últimas Posted Assembly Orders de ese gadget en esas dos locations (la misma
// revista y la location de su línea, normalmente D-FORCE) y el stock de cada revista (artículos "MAGAZINE …") a la
// fecha del fichero (nombre "20260929…"), repartido entre los gadgets en el orden del Excel.

export const LOC_GOOD = 'MAILFINISH';
export const LOC_DAMAGED = 'DESTR MAIL';
const DEFAULT_INPUT_LOCATION = 'D-FORCE';
const MAGAZINE_PREFIX = { galupy: '05995', inkee: '05993' } as const;

// Código del informe → artículo de BC que se da de alta cuando no es el mismo ni una variante con letras (84434 → 84434DE
// se deduce solo). Mailfinish reporta 18378 (sin revista) pero se recupera como 78440 (versión de revista Inkee 03/25),
// como en julio y agosto de 2026. Se completa con el ajuste mailfinishOutputs, que aprende al crear las órdenes.
const DEFAULT_OUTPUTS: Record<string, string> = { '18378': '78440' };
export async function outputMap() {
  return { ...DEFAULT_OUTPUTS, ...(await readSetting<Record<string, string>>('mailfinishOutputs', {})) };
}
export async function learnOutput(gadget: string, output: string) {
  const saved = await readSetting<Record<string, string>>('mailfinishOutputs', {});
  if ((saved[gadget] ?? DEFAULT_OUTPUTS[gadget]) === output) return;
  await writeSetting('mailfinishOutputs', { ...saved, [gadget]: output });
}

export type ExcelGadget = { code: string; sku: string; good: number; damaged: number };
export type Stock = { item: string; description: string; location: string; qty: number };
export type Candidate = { item: string; location: string; lastOrder: string; lastDate: string };
export type Suggestion = {
  key: string; gadget: string; output: string; outputDescription: string; location: string; quantity: number;
  input: string; inputLocation: string; candidates: Candidate[]; source: 'history' | 'description' | 'none'; shortage: number;
};
export type OpenOrder = { no: string; item: string; location: string; quantity: number; postingDate: string };

const q = (s: string) => s.replace(/'/g, "''");
const num = (v: any) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/\./g, '').replace(',', '.')) || 0);

// "Mailfinish_20260929.xlsx" → 2026-09-29
export function dateFromFileName(name: string) {
  const m = name.match(/(20\d{2})(\d{2})(\d{2})/);
  return m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

// Segunda tabla del informe: cabecera "Item code | SKU | I. Wahl | II.Wahl, UNVERBRAUCHBAR" y una fila por gadget
export function parseMailfinishExcel(data: ArrayBuffer | Uint8Array) {
  const wb = XLSX.read(data, { type: 'array' });
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, defval: null });
    const h = rows.findIndex(r => r?.some((c: any) => /^item\s*code$/i.test(String(c ?? '').trim())));
    if (h < 0) continue;
    const head = rows[h].map((c: any) => String(c ?? '').trim());
    const col = (re: RegExp) => head.findIndex((c: string) => re.test(c));
    const C = { code: col(/^item\s*code$/i), sku: col(/^sku$/i), good: col(/^i\.?\s*wahl/i), damaged: col(/^ii\.?\s*wahl/i) };
    if (C.good < 0) throw new Error('The Excel file does not have the "I. Wahl" column next to "Item code".');
    const gadgets: ExcelGadget[] = [];
    for (const r of rows.slice(h + 1)) {
      const code = String(r?.[C.code] ?? '').trim();
      if (!code) { if (gadgets.length) break; continue; }
      const g = { code, sku: C.sku >= 0 ? String(r[C.sku] ?? '').trim() : '', good: num(r[C.good]), damaged: C.damaged >= 0 ? num(r[C.damaged]) : 0 };
      if (g.good || g.damaged) gadgets.push(g);
    }
    return gadgets;
  }
  throw new Error('The gadget table (header "Item code") was not found in the Excel file.');
}

// ---------- Datos de BC ----------

async function history(ctx: BcContext) {
  const [orders, lines] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.apiBase}/postedAssemblyOrders`, {
      $filter: `locationCode eq '${LOC_GOOD}' or locationCode eq '${q(LOC_DAMAGED)}'`,
      $select: 'number,itemNumber,description,locationCode,postingDate,quantity,reversed',
    }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.apiBase}/postedAssemblyOrderLines`, {
      $filter: `lineType eq 'Item'`, $select: 'documentNumber,lineObjectNumber,locationCode,quantity',
    }), ctx.token),
  ]);
  const byDoc = new Map<string, any[]>();
  lines.forEach((l: any) => { const a = byDoc.get(l.documentNumber) || []; a.push(l); byDoc.set(l.documentNumber, a); });
  return orders.filter((o: any) => !o.reversed)
    .sort((a: any, b: any) => String(b.postingDate).localeCompare(String(a.postingDate)) || String(b.number).localeCompare(String(a.number)))
    .map((o: any) => ({ ...o, lines: byDoc.get(o.number) || [] }));
}

// Stock de las revistas (artículos con descripción "MAGAZINE…") por location a la fecha, de los movimientos de producto
async function magazineStock(ctx: BcContext, date: string) {
  const items = await bcFetchAll(odataUrl(`${ctx.apiBase}/items`, {
    $filter: `startswith(displayName,'MAGAZINE')`, $select: 'number,displayName',
  }), ctx.token);
  const names = new Map(items.map((i: any) => [String(i.number), String(i.displayName)]));
  const prefixes = Array.from(new Set(items.map((i: any) => String(i.number).substring(0, 5))));
  if (!prefixes.length) return { stock: [] as Stock[], names };
  const entries = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Item_Ledger_Entries_Excel`, {
    $filter: `Posting_Date le ${date} and (${prefixes.map(p => `startswith(Item_No,'${q(p)}')`).join(' or ')})`,
    $select: 'Item_No,Location_Code,Quantity',
  }), ctx.token);
  const sum = new Map<string, number>();
  for (const e of entries) {
    if (!names.has(e.Item_No)) continue;
    const k = `${e.Item_No}|${e.Location_Code}`;
    sum.set(k, (sum.get(k) || 0) + e.Quantity);
  }
  const stock: Stock[] = Array.from(sum.entries()).filter(([, v]) => Math.abs(v) > 0.0001).map(([k, qty]) => {
    const [item, location] = k.split('|');
    return { item, description: names.get(item) || '', location, qty };
  }).sort((a, b) => a.item.localeCompare(b.item) || a.location.localeCompare(b.location));
  return { stock, names };
}

// Assembly Orders sin registrar de MAILFINISH / DESTR MAIL (para no crearlas dos veces)
async function openOrders(ctx: BcContext): Promise<OpenOrder[]> {
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/assemblyOrders`, {
    $filter: `locationCode eq '${LOC_GOOD}' or locationCode eq '${q(LOC_DAMAGED)}'`, $select: 'number,itemNumber,locationCode,quantity,postingDate',
  }), ctx.token);
  return rows.map((r: any) => ({ no: r.number, item: r.itemNumber, location: r.locationCode, quantity: r.quantity, postingDate: r.postingDate }));
}

// Revista del número que indica la descripción del gadget: "(Magazine - Galupy 04/25)" → 05995_2504
function magazineFromDescription(text: string, names: Map<string, string>) {
  const m = text.match(/magazine\s*-\s*(galupy|inkee)\s*(\d{1,2})\s*\/\s*(\d{2})/i);
  if (!m) return null;
  const item = `${MAGAZINE_PREFIX[m[1].toLowerCase() as keyof typeof MAGAZINE_PREFIX]}_${m[3]}${m[2].padStart(2, '0')}`;
  return names.has(item) ? item : null;
}

// ---------- Sugerencia ----------

// overrides: artículo de BC elegido en la página para un código del informe (manda sobre la tabla de equivalencias)
export async function suggestOrders(ctx: BcContext, gadgets: ExcelGadget[], date: string, overrides: Record<string, string> = {}) {
  const warnings: string[] = [];
  const map = { ...(await outputMap()), ...overrides };
  const [hist, { stock, names }, open] = await Promise.all([history(ctx), magazineStock(ctx, date), openOrders(ctx).catch(e => {
    warnings.push(`Could not read the open Assembly Orders: ${String(e.message).substring(0, 160)}`);
    return [] as OpenOrder[];
  })]);
  const available = new Map(stock.map(s => [`${s.item}|${s.location}`, s.qty]));
  const suggestions: Suggestion[] = [];

  for (const g of gadgets) {
    // Artículo de BC: el de la tabla de equivalencias, o el código del Excel o su variante con letras (84434 → 84434DE)
    // que se ha usado en las recuperaciones
    const mapped = map[g.code];
    const own = mapped
      ? hist.filter((o: any) => o.itemNumber === mapped)
      : hist.filter((o: any) => o.itemNumber === g.code || new RegExp(`^${g.code.replace(/[^\w]/g, '')}[A-Z]+$`, 'i').test(o.itemNumber));
    const output = mapped || own.find((o: any) => o.itemNumber === g.code)?.itemNumber || own[0]?.itemNumber || g.code;
    const outputDescription = own[0]?.description || (mapped ? '' : g.sku);
    if (output !== g.code) warnings.push(`${g.code}: created as ${output}${mapped ? ' (saved equivalence)' : ', the item of its previous recoveries in BC'}.`);

    // Revistas de entrada: las de las últimas recuperaciones, de la más reciente a la más antigua
    const candidates: Candidate[] = [];
    for (const o of own) for (const l of o.lines) {
      if (!names.has(l.lineObjectNumber) || candidates.some(c => c.item === l.lineObjectNumber && c.location === l.locationCode)) continue;
      candidates.push({ item: l.lineObjectNumber, location: l.locationCode || DEFAULT_INPUT_LOCATION, lastOrder: o.number, lastDate: o.postingDate });
    }
    let source: Suggestion['source'] = candidates.length ? 'history' : 'none';
    if (!candidates.length) {
      const mag = magazineFromDescription(`${outputDescription} ${g.sku}`, names);
      if (mag) { candidates.push({ item: mag, location: DEFAULT_INPUT_LOCATION, lastOrder: '', lastDate: '' }); source = 'description'; }
    }
    if (source === 'none') warnings.push(`${g.code} ${g.sku}: no previous recoveries and no magazine in the description; pick the magazine manually.`);
    else if (source === 'description') warnings.push(`${g.code}: no previous recoveries; the magazine from its description is suggested (${candidates[0].item}).`);

    for (const [location, qty] of [[LOC_GOOD, g.good], [LOC_DAMAGED, g.damaged]] as const) {
      let rest = qty;
      if (rest <= 0) continue;
      // Se reparte entre las revistas candidatas con stock, en orden; lo que no cabe queda en la primera, marcado
      for (const c of candidates) {
        const k = `${c.item}|${c.location}`;
        const take = Math.min(rest, Math.max(0, available.get(k) || 0));
        if (take <= 0) continue;
        available.set(k, (available.get(k) || 0) - take);
        suggestions.push({ key: `${g.code}|${location}|${k}`, gadget: g.code, output, outputDescription, location, quantity: take, input: c.item, inputLocation: c.location, candidates, source, shortage: 0 });
        rest -= take;
        if (!rest) break;
      }
      if (rest > 0) {
        const c = candidates[0];
        suggestions.push({
          key: `${g.code}|${location}|short`, gadget: g.code, output, outputDescription, location, quantity: rest,
          input: c?.item || '', inputLocation: c?.location || DEFAULT_INPUT_LOCATION, candidates, source, shortage: rest,
        });
      }
    }
  }
  const short = suggestions.filter(s => s.shortage);
  if (short.length) warnings.push(`${short.length} orders without enough stock of the suggested magazine on ${date.split('-').reverse().join('/')}: pick another magazine or adjust the quantity.`);
  return { suggestions, stock, open, warnings };
}

// ---------- Crear en BC ----------

export type OrderInput = { output: string; location: string; quantity: number; input: string; inputLocation: string; date: string };

// La API v2 assemblyOrders es de solo lectura ("Entity does not support insert"): las órdenes se crean por la página
// 900 "Assembly Order" publicada como servicio web OData (nombre "AssemblyOrder", o el del ajuste
// mailfinishAssemblyService), que expone sus líneas (subpágina 901) como "<servicio>Lines".
const ASSEMBLY_SETUP = 'BC does not allow creating Assembly Orders through the standard API. Publish page 900 "Assembly Order" in BC ' +
  'as a web service (Web Services → New: Object Type Page, Object ID 900, Service Name AssemblyOrder, Published).';

async function assemblyService(ctx: BcContext) {
  const root = ctx.odataCompanyBase.replace(/\/Company\(.*$/, '');
  const res = await fetch(root, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
  const list: string[] = res.ok ? ((await res.json()).value || []).map((s: any) => s.name) : [];
  const configured = await readSetting<string>('mailfinishAssemblyService', '');
  const head = configured || list.find(n => /^assembly_?order$/i.test(n)) || list.find(n => /^assembly_?orders?(_card)?$/i.test(n));
  if (!head || (list.length && !list.includes(head))) throw new Error(ASSEMBLY_SETUP);
  const lines = list.find(n => n !== head && n.toLowerCase().startsWith(head.toLowerCase()) && /line/i.test(n));
  if (!lines) throw new Error(`The ${head} web service does not expose the order lines: publish page 900 "Assembly Order" (with its lines subpage).`);
  return { head: `${ctx.odataCompanyBase}/${head}`, lines: `${ctx.odataCompanyBase}/${lines}` };
}

// Assembly Order sin registrar: cabecera con el gadget y una línea con la revista (Quantity per 1).
// Las líneas que BC copia de la lista de materiales del gadget se quitan antes.
export async function createAssemblyOrder(ctx: BcContext, o: OrderInput) {
  const svc = await assemblyService(ctx);
  const head = await bcRequest('POST', svc.head, ctx.token, { Item_No: o.output, Posting_Date: o.date });
  const no: string = head.No;
  const docType = encodeURIComponent(String(head.Document_Type || 'Order').replace(/'/g, "''"));
  const headUrl = `${svc.head}(Document_Type='${docType}',No='${encodeURIComponent(q(no))}')`;
  try {
    // La location y la cantidad después del artículo (al validarlas BC recalcula las líneas y las fechas)
    await bcRequest('PATCH', headUrl, ctx.token, { Location_Code: o.location, Quantity: o.quantity, Due_Date: o.date });
    const auto = await bcRequest('GET', odataUrl(svc.lines, { $filter: `Document_No eq '${q(no)}'`, $select: 'Document_Type,Document_No,Line_No' }), ctx.token);
    for (const l of auto?.value || []) {
      await bcRequest('DELETE', `${svc.lines}(Document_Type='${encodeURIComponent(l.Document_Type)}',Document_No='${encodeURIComponent(q(no))}',Line_No=${l.Line_No})`, ctx.token);
    }
    await bcRequest('POST', svc.lines, ctx.token, {
      Document_Type: head.Document_Type || 'Order', Document_No: no, Type: 'Item', No: o.input, Location_Code: o.inputLocation, Quantity_per: 1,
    });
    // Comprobar que la orden ha quedado en BC como se pidió (cabecera + una línea con la revista), por el mismo servicio
    const h = await bcRequest('GET', headUrl, ctx.token);
    const ls = await bcRequest('GET', odataUrl(svc.lines, { $filter: `Document_No eq '${q(no)}'` }), ctx.token);
    const problem = orderProblem({
      no, state: h?.No ? 'open' : 'missing', item: h?.Item_No, location: h?.Location_Code, quantity: Number(h?.Quantity),
      lines: (ls?.value || []).filter((l: any) => l.No).map((l: any) => ({ item: l.No, location: l.Location_Code, quantityPer: Number(l.Quantity_per) || 0, quantity: Number(l.Quantity) || 0 })),
    }, o);
    if (problem) throw new Error(problem);
  } catch (e) {
    // No dejar una orden a medias
    await bcRequest('DELETE', headUrl, ctx.token).catch(() => {});
    throw e;
  }
  return { id: String(head.SystemId || ''), no };
}

// Estado en BC de Assembly Orders creadas desde la app: abierta (con sus líneas), registrada o no encontrada
export type OrderCheck = {
  no: string; state: 'open' | 'posted' | 'missing';
  item?: string; location?: string; quantity?: number; postingDate?: string;
  lines?: { item: string; location: string; quantityPer: number; quantity: number }[];
};
export async function checkOrders(ctx: BcContext, nos: string[]): Promise<OrderCheck[]> {
  const out: OrderCheck[] = [];
  for (let i = 0; i < nos.length; i += 15) {
    const part = nos.slice(i, i + 15);
    const f = (field: string) => part.map(n => `${field} eq '${q(n)}'`).join(' or ');
    const [open, openLines, posted] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.apiBase}/assemblyOrders`, { $filter: f('number'), $select: 'number,itemNumber,locationCode,quantity,postingDate' }), ctx.token),
      assemblyService(ctx).then(svc => bcFetchAll(odataUrl(svc.lines, { $filter: f('Document_No') }), ctx.token))
        .then(rows => rows.map((l: any) => ({ documentNumber: l.Document_No, lineObjectNumber: l.No, locationCode: l.Location_Code, quantityPer: l.Quantity_per, quantity: l.Quantity }))),
      // La registrada guarda el nº de la orden en Order No. (OData Posted_Assembly_Orders…); en v2 no siempre está publicado
      bcFetchAll(odataUrl(`${ctx.apiBase}/postedAssemblyOrders`, { $filter: f('assemblyOrderNumber') }), ctx.token)
        .catch(() => bcFetchAll(odataUrl(`${ctx.apiBase}/postedAssemblyOrders`, { $filter: f('orderNumber') }), ctx.token))
        .catch(() => [] as any[]),
    ]);
    for (const no of part) {
      const h = open.find((x: any) => x.number === no);
      if (h) {
        out.push({
          no, state: 'open', item: h.itemNumber, location: h.locationCode, quantity: h.quantity, postingDate: h.postingDate,
          lines: openLines.filter((l: any) => l.documentNumber === no && l.lineObjectNumber)
            .map((l: any) => ({ item: l.lineObjectNumber, location: l.locationCode, quantityPer: Number(l.quantityPer) || 0, quantity: Number(l.quantity) || 0 })),
        });
        continue;
      }
      const p = posted.find((x: any) => x.assemblyOrderNumber === no || x.orderNumber === no);
      out.push(p ? { no, state: 'posted', item: p.itemNumber, location: p.locationCode, quantity: p.quantity, postingDate: p.postingDate } : { no, state: 'missing' });
    }
  }
  return out;
}
// Qué no cuadra entre la orden de BC y lo pedido ('' = está bien)
export function orderProblem(c: OrderCheck | undefined, o: OrderInput) {
  if (!c || c.state === 'missing') return 'The Assembly Order was not found in BC after creating it.';
  if (c.state === 'posted') return '';
  const issues: string[] = [];
  if (c.item !== o.output) issues.push(`item ${c.item} instead of ${o.output}`);
  if (c.location !== o.location) issues.push(`location ${c.location} instead of ${o.location}`);
  if (Number(c.quantity) !== o.quantity) issues.push(`quantity ${c.quantity} instead of ${o.quantity}`);
  const mag = (c.lines || []).filter(l => l.item === o.input);
  if (!mag.length) issues.push(`no line with the magazine ${o.input}`);
  else if (mag[0].location !== o.inputLocation) issues.push(`magazine line in ${mag[0].location} instead of ${o.inputLocation}`);
  if ((c.lines || []).length > 1) issues.push(`${c.lines!.length} lines instead of 1`);
  return issues.length ? `The Assembly Order was created in BC but does not match: ${issues.join(', ')}.` : '';
}
