import { bcFetchAll, BcContext, getBcContext, odataUrl } from '@/lib/bcClient';
import { cardItem, royaltyCodesByItem } from '@/lib/royalties';
import { cached, HOUR } from './cache';
import { fetchSnapshots } from './inventory';
import { cutoffDate, monthEnd, today } from './period';

// Análisis Inventario: inventario a cada fin de mes del año del informe (hasta el mes elegido) y de todo el año
// anterior, por artículo × location (valor = uds de la location × coste unitario del artículo, como la página 80016),
// con los atributos del artículo para que la página agrupe y filtre en el navegador. Los atributos (Product Range,
// Categorization Code, Product Line, License, Business Unit, Raw Article, Article To Root) son los de la ficha en
// CRAZE GmbH (como Commercial Analysis) y el Royalty Code el que usa Royalties.

export type InvAttrs = { no: string; desc: string; range: string; cat: string; line: string; license: string; bu: string; raw: string; root: string; royalty: string };

const s = (v: any) => (v == null ? '' : String(v).trim());
const ITEM_FIELDS = 'no,description,range,categorizationCode,line,license,businessUnit,rawArticle,itemToRoot';

// Atributos de artículo de CRAZE GmbH (una vez al día)
async function itemAttributes(force: boolean) {
  return cached('invAnalysis:items', 24 * HOUR, async () => {
    const ctx = await getBcContext('CRAZE');
    const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/items`, { $select: ITEM_FIELDS }), ctx.token, 55_000);
    return rows.map((i: any) => ({
      no: s(i.no), desc: s(i.description), range: s(i.range), cat: s(i.categorizationCode), line: s(i.line),
      license: s(i.license), bu: s(i.businessUnit), raw: s(i.rawArticle), root: s(i.itemToRoot),
    }));
  }, force, { refreshAfterMs: 24 * HOUR });
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

export async function inventoryAnalysis(ctx: BcContext, company: string, month: string, force = false) {
  return cached(`invAnalysis:${company}:${month}`, 6 * HOUR, async () => {
    const { year, cur, prev } = analysisDates(month);
    const dates = [...prev, ...cur];
    const [snaps, attrs, royalty] = await Promise.all([
      fetchSnapshots(ctx, dates),
      itemAttributes(force),
      royaltyCodesByItem(force).catch(() => ({} as Record<string, string>)),
    ]);
    const attrBy = new Map(attrs.map(a => [a.no, a]));

    // Índices compactos: artículos y locations; filas [fecha, artículo, location, valor, uds]
    const items: InvAttrs[] = [];
    const itemIdx = new Map<string, number>();
    const locs: string[] = [];
    const locIdx = new Map<string, number>();
    const rows: number[][] = [];
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
        let ii = itemIdx.get(item.no);
        if (ii === undefined) {
          const a = attrBy.get(item.no);
          const card = cardItem(item.no, royalty);
          ii = items.length;
          itemIdx.set(item.no, ii);
          items.push({
            no: item.no, desc: a?.desc || item.desc, range: a?.range || '', cat: a?.cat || '', line: a?.line || '',
            license: a?.license || '', bu: a?.bu || '', raw: a?.raw || '', root: a?.root || '', royalty: card ? royalty[card] || '' : '',
          });
        }
        for (const [loc, qty] of Object.entries(item.loc)) {
          let li = locIdx.get(loc);
          if (li === undefined) { li = locs.length; locIdx.set(loc, li); locs.push(loc); }
          rows.push([di, ii, li, Math.round(qty * unit * 100) / 100, qty]);
        }
      }
    });

    // Descripción de Raw Article / Article To Root: la del artículo con ese nº (o nº + DE / EN)
    const descOf = new Map(attrs.map(a => [a.no, a.desc]));
    const rawDesc: Record<string, string> = {};
    for (const code of new Set(items.flatMap(i => [i.raw, i.root]).filter(Boolean))) {
      rawDesc[code] = descOf.get(code) || descOf.get(`${code}DE`) || descOf.get(`${code}EN`) || '';
    }
    return { year, month, dates, curDates: cur, prevDates: prev, totals, items, locs, rows, rawDesc };
  }, force);
}
