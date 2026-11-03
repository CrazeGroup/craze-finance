import { bcFetchAll, BcContext, getBcContext, odataUrl } from '@/lib/bcClient';
import { cardItem, royaltyCodesByItem } from '@/lib/royalties';
import { cached, HOUR } from './cache';
import { fetchSnapshots } from './inventory';
import { CHINA_PM } from './ledgers';
import { currentMonth, cutoffDate, monthEnd, shiftMonth, today } from './period';

// Análisis Inventario: inventario a cada fin de mes del año del informe (hasta el mes elegido) y de todo el año
// anterior, por artículo × location (valor = uds de la location × coste unitario del artículo, como la página 80016),
// con los atributos del artículo para que la página agrupe y filtre en el navegador. Los atributos (Product Range,
// Categorization Code, Product Line, License, Business Unit, Raw Article, Article To Root, Customer Group Code y
// PM Classification) son los de la ficha en CRAZE GmbH (como Commercial Analysis) y el Royalty Code el que usa Royalties.
// El inventario lleva también las uds por palet de cada artículo (unidad PAL) para contar palets por grupo.
// Compras de inventario: lo mismo con las líneas de las facturas CHINA TRF de cada mes (importe en divisa local).

export type InvAttrs = { no: string; desc: string; range: string; cat: string; line: string; license: string; bu: string; raw: string; root: string; royalty: string; cg: string; pmc: string };

const s = (v: any) => (v == null ? '' : String(v).trim());
const ITEM_FIELDS = 'no,description,range,categorizationCode,line,license,businessUnit,rawArticle,itemToRoot,customerGroupCode';

// Atributos de artículo de CRAZE GmbH (una vez al día). PM Classification solo está en la página Item_Card_Excel;
// el Customer Group Code se muestra con la descripción del grupo.
async function itemAttributes(force: boolean) {
  return cached('invAnalysis:items3', 24 * HOUR, async () => {
    const ctx = await getBcContext('CRAZE');
    const [rows, cards, groups] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.customApiBase}/items`, { $select: ITEM_FIELDS }), ctx.token, 55_000),
      itemCardPmClassification(ctx),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/customerGroups`, { $select: 'code,description' }), ctx.token).catch(() => [] as any[]),
    ]);
    const pmc = new Map(cards.map((c: any) => [s(c.No), s(c.PM_Classification_BCT)]));
    const group = new Map(groups.map((g: any) => [s(g.code), s(g.description)]));
    return rows.map((i: any) => ({
      no: s(i.no), desc: s(i.description), range: s(i.range), cat: s(i.categorizationCode), line: s(i.line),
      license: s(i.license), bu: s(i.businessUnit), raw: s(i.rawArticle), root: s(i.itemToRoot),
      cg: s(i.customerGroupCode) ? `${s(i.customerGroupCode)} ${group.get(s(i.customerGroupCode)) || ''}`.trim() : '', pmc: pmc.get(s(i.no)) || '',
    }));
  }, force, { refreshAfterMs: 24 * HOUR });
}

// PM Classification de Item_Card_Excel: la página entera tarda más de un minuto, así que se lee por tramos del nº de
// artículo (primer carácter) en paralelo. Un tramo que falle se queda sin clasificación.
async function itemCardPmClassification(ctx: BcContext) {
  const marks = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const ranges = [`No lt '1'`, ...marks.map((c, i) => (i === marks.length - 1 ? `No ge '${c}'` : `No ge '${c}' and No lt '${marks[i + 1]}'`))];
  const parts = await Promise.all(ranges.map(f => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Item_Card_Excel`, { $filter: f, $select: 'No,PM_Classification_BCT' }), ctx.token, 150_000)
    .catch(e => { console.error('Item_Card_Excel', f, e); return [] as any[]; })));
  return parts.flat();
}

// Meses cerrados: se renuevan una vez por semana; el mes en curso (o el último cerrado) cada día
export function refreshAfter(month: string) {
  return month < shiftMonth(currentMonth(), -1) ? 7 * 24 * HOUR : 24 * HOUR;
}

// Uds por palet (unidad PAL) de cada artículo de la empresa
export async function palletSizes(ctx: BcContext): Promise<Record<string, number>> {
  const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Item_Units_of_Measure_Excel`, { $filter: `Code eq 'PAL'`, $select: 'Item_No,Qty_per_Unit_of_Measure' }), ctx.token)
    .catch(() => [] as any[]);
  return Object.fromEntries(rows.filter((u: any) => u.Qty_per_Unit_of_Measure > 0).map((u: any) => [s(u.Item_No), u.Qty_per_Unit_of_Measure]));
}

// Fechas: fin de cada mes de enero al mes del informe (este con la fecha de corte) y de los 12 meses del año anterior
export function analysisDates(month: string) {
  const year = Number(month.substring(0, 4));
  const last = Number(month.substring(5, 7));
  const t = today();
  const cur = Array.from({ length: last }, (_, i) => {
    const m = `${year}-${String(i + 1).padStart(2, '0')}`;
    return m === month ? cutoffDate(m) : monthEnd(m);
  });
  const prev = Array.from({ length: 12 }, (_, i) => monthEnd(`${year - 1}-${String(i + 1).padStart(2, '0')}`)).filter(d => d <= t);
  return { year, cur, prev };
}

// Filas compactas [fecha, artículo, location, valor, uds] con los artículos y locations indexados
export async function indexer(force: boolean) {
  const [attrs, royalty] = await Promise.all([
    itemAttributes(force),
    royaltyCodesByItem(force).catch(() => ({} as Record<string, string>)),
  ]);
  const attrBy = new Map(attrs.map(a => [a.no, a]));
  const items: InvAttrs[] = [];
  const itemIdx = new Map<string, number>();
  const locs: string[] = [];
  const locIdx = new Map<string, number>();
  const rows: number[][] = [];
  const add = (di: number, no: string, desc: string, loc: string, value: number, qty: number) => {
    let ii = itemIdx.get(no);
    if (ii === undefined) {
      const a = attrBy.get(no);
      const card = cardItem(no, royalty);
      ii = items.length;
      itemIdx.set(no, ii);
      items.push({
        no, desc: a?.desc || desc, range: a?.range || '', cat: a?.cat || '', line: a?.line || '',
        license: a?.license || '', bu: a?.bu || '', raw: a?.raw || '', root: a?.root || '', royalty: card ? royalty[card] || '' : '',
        cg: a?.cg || '', pmc: a?.pmc || '',
      });
    }
    let li = locIdx.get(loc);
    if (li === undefined) { li = locs.length; locIdx.set(loc, li); locs.push(loc); }
    rows.push([di, ii, li, Math.round(value * 100) / 100, qty]);
  };
  // Descripción de Raw Article / Article To Root: la del artículo con ese nº (o nº + DE / EN)
  const rawDescs = () => {
    const descOf = new Map(attrs.map(a => [a.no, a.desc]));
    const rawDesc: Record<string, string> = {};
    for (const code of new Set(items.flatMap(i => [i.raw, i.root]).filter(Boolean))) {
      rawDesc[code] = descOf.get(code) || descOf.get(`${code}DE`) || descOf.get(`${code}EN`) || '';
    }
    return rawDesc;
  };
  return { items, locs, rows, add, rawDescs };
}

export async function inventoryAnalysis(ctx: BcContext, company: string, month: string, force = false) {
  return cached(`invAnalysis3:${company}:${month}`, 7 * 24 * HOUR, async () => {
    const { year, cur, prev } = analysisDates(month);
    const dates = [...prev, ...cur];
    const [snaps, idx, pal] = await Promise.all([fetchSnapshots(ctx, dates), indexer(force), palletSizes(ctx)]);
    const totals: { date: string; value: number; qty: number; skus: number }[] = [];
    dates.forEach((date, di) => {
      const snap = snaps[date];
      totals.push({
        date,
        value: snap.items.reduce((t, i) => t + i.value, 0),
        qty: snap.items.reduce((t, i) => t + i.qty, 0),
        skus: snap.items.filter(i => i.qty > 0 && i.value).length,
      });
      for (const item of snap.items) {
        if (!item.qty) continue;
        const unit = item.value / item.qty;
        for (const [loc, qty] of Object.entries(item.loc)) idx.add(di, item.no, item.desc, loc, qty * unit, qty);
      }
    });
    return { year, month, dates, curDates: cur, prevDates: prev, totals, items: idx.items, locs: idx.locs, rows: idx.rows, rawDesc: idx.rawDescs(), pal };
  }, force, { refreshAfterMs: refreshAfter(month) });
}

// Compras de inventario (facturas CHINA TRF) por mes del año del informe y del anterior: líneas de las facturas
// registradas (custom purchInvLines), en divisa local (factor amountLCY / amount del movimiento de proveedor).
// Las líneas que no son de artículo (cuenta, cargo) van con su nº y descripción y sin atributos. Lo que el movimiento
// no cubre con líneas (facturas migradas antes de oct-2025, sin líneas registradas) va como "(sin líneas)".
export async function purchasesAnalysis(ctx: BcContext, company: string, month: string, force = false) {
  const { year, cur, prev } = analysisDates(month);
  const last = cur[cur.length - 1];
  return cached(`purAnalysis4:${company}:${last}`, 7 * 24 * HOUR, async () => {
    const from = `${year - 1}-01-01`;
    const [entries, lines, idx] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, {
        $filter: `documentType eq 'Invoice' and paymentMethodCode eq '${CHINA_PM}' and postingDate ge ${from} and postingDate le ${last}`,
        $select: 'documentNo,postingDate,amount,amountLCY',
      }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/purchInvLines`, {
        $filter: `postingDate ge ${from} and postingDate le ${last}`,
        $select: 'documentNo,type,no,description,locationCode,quantity,amount,postingDate',
      }), ctx.token),
      indexer(force),
    ]);
    const factor = new Map<string, number>(entries.map((e: any) => [e.documentNo, e.amount ? e.amountLCY / e.amount : 1]));
    // Índice de mes: año anterior (0-11) y año del informe (12-)
    const monthIdx = (d: string) => {
      const y = Number(d.substring(0, 4)), m = Number(d.substring(5, 7)) - 1;
      return y === year - 1 ? (m < prev.length ? m : -1) : y === year ? (m < cur.length ? prev.length + m : -1) : -1;
    };
    const none = '(sin location)';
    const covered = new Map<string, number>();
    for (const l of lines) {
      const f = factor.get(l.documentNo);
      if (f === undefined || !l.amount) continue;
      const di = monthIdx(String(l.postingDate));
      if (di < 0) continue;
      const isItem = String(l.type) === 'Item';
      const no = s(l.no) || s(l.description);
      covered.set(l.documentNo, (covered.get(l.documentNo) || 0) + l.amount * f);
      idx.add(di, isItem ? no : `${no}${l.description && s(l.no) ? ` ${s(l.description)}` : ''}`, s(l.description), s(l.locationCode) || none, l.amount * f, Number(l.quantity) || 0);
    }
    for (const e of entries) {
      const rest = -e.amountLCY - (covered.get(e.documentNo) || 0);
      const di = monthIdx(String(e.postingDate));
      if (di >= 0 && Math.abs(rest) >= 0.5) idx.add(di, '(sin líneas)', '', none, rest, 0);
    }
    const totals = [...prev, ...cur].map((date, di) => ({
      date, value: idx.rows.filter(r => r[0] === di).reduce((t, r) => t + r[3], 0), qty: 0, skus: 0,
    }));
    return { year, month, dates: [...prev, ...cur], curDates: cur, prevDates: prev, totals, items: idx.items, locs: idx.locs, rows: idx.rows, rawDesc: idx.rawDescs() };
  }, force, { refreshAfterMs: refreshAfter(month) });
}
