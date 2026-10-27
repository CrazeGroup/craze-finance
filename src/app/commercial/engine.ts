// Commercial Analysis: cálculo en el navegador sobre los hechos agregados de /api/commercial/facts (como las medidas
// DAX del Power BI). Sell-in = facturado (LM) + pedidos abiertos; año anterior = mismo periodo (SAMEPERIODLASTYEAR);
// importes en la divisa local si hay una sola empresa seleccionada y en EUR si hay varias.

export type Item = { no: string; desc: string; raw: string; root: string; rootUnits: number; line: string; license: string; royalty: string; bu: string; gtin: string };
export type Dims = {
  items: Item[]; rawDesc: Record<string, string>;
  groups: { code: string; desc: string; dim: string; kam: string }[];
  kamByGroupBu: Record<string, string>; kams: Record<string, string>; dimensions: Record<string, string>;
};
// delta: cambio de hoy frente a los datos guardados en deltaFrom (solo año en curso; mismas columnas, parte del mes = 0)
export type Facts = { company: string; currency: string; year: number; cutoff: string; rows: (string | number)[][]; delta?: (string | number)[][]; deltaFrom?: string; itemRoyalty: Record<string, string>; warnings: string[] };

export const COMPANIES = [
  { abbr: 'GmbH', name: 'Craze GmbH', currency: 'EUR' },
  { abbr: 'UK', name: 'Craze UK', currency: 'GBP' },
  { abbr: 'Swiss', name: 'Craze Group AG', currency: 'CHF' },
  { abbr: 'Asia', name: 'Craze Macau', currency: 'USD' },
];

// Fila de hechos (ver src/lib/commercial/commercial.ts)
const M = { inv: 8, invEur: 9, invQty: 10, so: 11, soEur: 12, soQty: 13, bdg: 14, bdgEur: 15, bdgQty: 16, fc: 17, fcEur: 18, fcQty: 19 };

export type Filters = {
  companies: string[]; months: number[]; dimensions: string[]; customers: string[]; kams: string[]; sellCountries: string[];
  shipCountries: string[]; bus: string[]; lines: string[]; licenses: string[]; articles: string[];
  units: 'raw' | 'root';
};
export const EMPTY_FILTERS: Filters = {
  companies: [], months: [], dimensions: [], customers: [], kams: [], sellCountries: [], shipCountries: [], bus: [], lines: [], licenses: [], articles: [], units: 'raw',
};

// Valores de una fila ya filtrada
export type Rec = {
  y: 'cur' | 'prev'; m: number; part: number; group: string; kam: string; sell: string; ship: string; item: Item;
  inv: number; invQty: number; so: number; soQty: number; bdg: number; bdgQty: number; fc: number; fcQty: number;
};

export type Ctx = {
  dims: Dims; itemBy: Map<string, Item>; groupBy: Map<string, Dims['groups'][number]>; cutMonth: number; cutDay: number; year: number;
  currency: string;   // divisa de los importes mostrados
};

export function makeCtx(dims: Dims, facts: Facts[], year: number, filters: Filters): Ctx {
  const royalty: Record<string, string> = Object.assign({}, ...facts.map(f => f.itemRoyalty || {}));
  const itemBy = new Map(dims.items.map(i => [i.no, { ...i, royalty: i.royalty || royalty[i.no] || '' }]));
  const cutoff = facts[0]?.cutoff || new Date().toISOString().substring(0, 10);
  const selected = filters.companies.length ? filters.companies : COMPANIES.map(c => c.abbr);
  const currency = selected.length === 1 ? COMPANIES.find(c => c.abbr === selected[0])!.currency : 'EUR';
  return {
    dims, itemBy, groupBy: new Map(dims.groups.map(g => [g.code, g])), year, currency,
    cutMonth: Number(cutoff.substring(5, 7)), cutDay: Number(cutoff.substring(8, 10)),
  };
}

// Periodo: ytd = hasta hoy (meses anteriores + parte del mes actual hasta el día de hoy, en los dos años);
// motd = hasta final del mes anterior; full = año completo
export type Period = 'ytd' | 'motd' | 'full';
// Clases de línea LM: el Power BI filtra component = false (todas las páginas de sell-in) o mainItemCRZ = false (Top 50)
export type Classes = 'noComponent' | 'noMain';

// source 'delta' = el cambio de hoy en lugar de los hechos
export function records(ctx: Ctx, facts: Facts[], filters: Filters, period: Period, classes: Classes = 'noComponent', source: 'rows' | 'delta' = 'rows'): Rec[] {
  const out: Rec[] = [];
  const local = ctx.currency !== 'EUR' || (filters.companies.length === 1);
  const sel = (list: string[], v: string) => !list.length || list.includes(v);
  for (const f of facts) {
    if (filters.companies.length && !filters.companies.includes(f.company)) continue;
    const y = f.year === ctx.year ? 'cur' : f.year === ctx.year - 1 ? 'prev' : null;
    if (!y) continue;
    for (const r of (source === 'delta' ? f.delta : f.rows) || []) {
      const m = r[0] as number, part = r[1] as number, cls = r[2] as number;
      if (classes === 'noComponent' ? cls === 2 : cls === 1) continue;
      if (period === 'ytd' && (m > ctx.cutMonth || (m === ctx.cutMonth && part === 1))) continue;
      if (period === 'motd' && m >= ctx.cutMonth) continue;
      if (filters.months.length && !filters.months.includes(m)) continue;
      const item = ctx.itemBy.get(r[7] as string);
      if (!item) continue;
      const group = r[3] as string;
      const g = ctx.groupBy.get(group);
      if (!sel(filters.customers, group) || !sel(filters.dimensions, g?.dim || '') || !sel(filters.kams, r[4] as string)
        || !sel(filters.sellCountries, r[5] as string) || !sel(filters.shipCountries, r[6] as string)
        || !sel(filters.bus, item.bu) || !sel(filters.lines, item.line) || !sel(filters.licenses, item.license)
        || !sel(filters.articles, item.raw)) continue;
      const u = filters.units === 'root' ? item.rootUnits : 1;
      const v = (k: keyof typeof M) => (r[M[k]] as number) || 0;
      out.push({
        y, m, part, group, kam: r[4] as string, sell: r[5] as string, ship: r[6] as string, item,
        inv: local ? v('inv') : v('invEur'), invQty: v('invQty') * u,
        so: local ? v('so') : v('soEur'), soQty: v('soQty') * u,
        bdg: local ? v('bdg') : v('bdgEur'), bdgQty: v('bdgQty') * u,
        fc: local ? v('fc') : v('fcEur'), fcQty: v('fcQty') * u,
      });
    }
  }
  return out;
}

export type Agg = { inv: number; invQty: number; so: number; soQty: number; bdg: number; bdgQty: number; fc: number; fcQty: number; sIn: number; sInQty: number };
export const zero = (): Agg => ({ inv: 0, invQty: 0, so: 0, soQty: 0, bdg: 0, bdgQty: 0, fc: 0, fcQty: 0, sIn: 0, sInQty: 0 });
const addTo = (a: Agg, r: Rec) => {
  a.inv += r.inv; a.invQty += r.invQty; a.so += r.so; a.soQty += r.soQty; a.bdg += r.bdg; a.bdgQty += r.bdgQty;
  a.fc += r.fc; a.fcQty += r.fcQty; a.sIn += r.inv + r.so; a.sInQty += r.invQty + r.soQty;
};

export type Pair = { cur: Agg; prev: Agg };
export function totals(recs: Rec[]): Pair {
  const p = { cur: zero(), prev: zero() };
  for (const r of recs) addTo(p[r.y], r);
  return p;
}
export function groupBy(recs: Rec[], key: (r: Rec) => string): Map<string, Pair> {
  const map = new Map<string, Pair>();
  for (const r of recs) {
    const k = key(r);
    let p = map.get(k);
    if (!p) { p = { cur: zero(), prev: zero() }; map.set(k, p); }
    addTo(p[r.y], r);
  }
  return map;
}

// Dimensiones por las que se puede agrupar ("Parameter" del Power BI)
export const PARAMS = [
  { id: 'dimension', label: 'Dimension' },
  { id: 'customer', label: 'Customer' },
  { id: 'kam', label: 'KAM' },
  { id: 'sell', label: 'Sell Country' },
  { id: 'bu', label: 'Business Unit' },
  { id: 'line', label: 'Product Line' },
  { id: 'license', label: 'License' },
  { id: 'royalty', label: 'License Royalty' },
  { id: 'raw', label: 'Raw Article' },
  { id: 'root', label: 'Article To Root' },
  { id: 'article', label: 'Article' },
] as const;
export type ParamId = typeof PARAMS[number]['id'];

export function keyFn(ctx: Ctx, param: ParamId): (r: Rec) => string {
  const desc = (code: string) => `${code} ${ctx.dims.rawDesc[code] || ''}`.trim();
  switch (param) {
    case 'dimension': return r => ctx.dims.dimensions[ctx.groupBy.get(r.group)?.dim || ''] || '(sin dimensión)';
    case 'customer': return r => ctx.groupBy.get(r.group)?.desc || r.group || '(sin Customer Group)';
    case 'kam': return r => ctx.dims.kams[r.kam] || r.kam || '(sin KAM)';
    case 'sell': return r => r.sell || '(sin país)';
    case 'bu': return r => r.item.bu || '(sin BU)';
    case 'line': return r => r.item.line || '(sin línea)';
    case 'license': return r => r.item.license || '(sin licencia)';
    case 'royalty': return r => r.item.royalty || '(sin Royalty Code)';
    case 'raw': return r => (r.item.raw ? desc(r.item.raw) : '(sin Raw Article)');
    case 'root': return r => (r.item.root ? desc(r.item.root) : '(sin Article To Root)');
    case 'article': return r => `${r.item.no} ${r.item.desc}`;
  }
}

export const pctVar = (a: number, b: number) => (b ? (a - b) / Math.abs(b) : null);

// Proyección (Rev_Proj / Uds_Proj del Power BI): meses pasados = facturado; mes actual y futuros = forecast
// (en unidades, el mes actual = facturado: el forecast va fechado el día 1)
export function projection(ctx: Ctx, recs: Rec[]) {
  let rev = 0, qty = 0;
  for (const r of recs) {
    if (r.y !== 'cur') continue;
    if (r.m < ctx.cutMonth) { rev += r.inv; qty += r.invQty; }
    else if (r.m === ctx.cutMonth) { rev += r.fc; qty += r.invQty; }
    else { rev += r.fc; qty += r.fcQty; }
  }
  return { rev, qty };
}
