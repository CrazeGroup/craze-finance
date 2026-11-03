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
    if (C.good < 0) throw new Error('El Excel no tiene la columna "I. Wahl" junto a "Item code".');
    const gadgets: ExcelGadget[] = [];
    for (const r of rows.slice(h + 1)) {
      const code = String(r?.[C.code] ?? '').trim();
      if (!code) { if (gadgets.length) break; continue; }
      const g = { code, sku: C.sku >= 0 ? String(r[C.sku] ?? '').trim() : '', good: num(r[C.good]), damaged: C.damaged >= 0 ? num(r[C.damaged]) : 0 };
      if (g.good || g.damaged) gadgets.push(g);
    }
    return gadgets;
  }
  throw new Error('No se encuentra la tabla de gadgets (cabecera "Item code") en el Excel.');
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
    warnings.push(`No se han podido leer las Assembly Orders abiertas: ${String(e.message).substring(0, 160)}`);
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
    if (output !== g.code) warnings.push(`${g.code}: se da de alta como ${output}${mapped ? ' (equivalencia guardada)' : ', el artículo de sus recuperaciones en BC'}.`);

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
    if (source === 'none') warnings.push(`${g.code} ${g.sku}: sin recuperaciones anteriores ni revista en la descripción; elige la revista a mano.`);
    else if (source === 'description') warnings.push(`${g.code}: sin recuperaciones anteriores; se propone la revista de su descripción (${candidates[0].item}).`);

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
  if (short.length) warnings.push(`${short.length} órdenes sin stock suficiente de la revista sugerida a ${date.split('-').reverse().join('/')}: elige otra revista o ajusta la cantidad.`);
  return { suggestions, stock, open, warnings };
}

// ---------- Crear en BC ----------

export type OrderInput = { output: string; location: string; quantity: number; input: string; inputLocation: string; date: string };

// Assembly Order sin registrar (API v2): cabecera con el gadget y una línea con la revista (Quantity per 1).
// Las líneas que BC copia de la lista de materiales del gadget se quitan antes.
export async function createAssemblyOrder(ctx: BcContext, o: OrderInput) {
  const head = await bcRequest('POST', `${ctx.apiBase}/assemblyOrders`, ctx.token, {
    itemNumber: o.output, quantity: o.quantity, locationCode: o.location, postingDate: o.date, dueDate: o.date,
  });
  const id: string = head.id, no: string = head.number;
  const headUrl = `${ctx.apiBase}/assemblyOrders(${id})`;
  try {
    const auto = await bcRequest('GET', `${headUrl}/assemblyOrderLines?$select=id`, ctx.token);
    for (const l of auto?.value || []) await bcRequest('DELETE', `${headUrl}/assemblyOrderLines(${l.id})`, ctx.token);
    await bcRequest('POST', `${headUrl}/assemblyOrderLines`, ctx.token, {
      lineType: 'Item', lineObjectNumber: o.input, quantityPer: 1, locationCode: o.inputLocation,
    });
  } catch (e) {
    // No dejar una orden a medias
    await bcRequest('DELETE', headUrl, ctx.token).catch(() => {});
    throw e;
  }
  return { id, no };
}
