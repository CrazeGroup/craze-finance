'use client';

import React, { useMemo, useState } from 'react';
import type { Fmt } from './i18n';
import { C, Card, Grid, LineChart, Signed } from './ui';

// Datos de /api/reporting/inventory-analysis (src/lib/reporting/inventoryAnalysis.ts)
export type InvAttrs = { no: string; desc: string; range: string; cat: string; line: string; license: string; bu: string; raw: string; root: string; royalty: string; cg: string; pmc: string };
export type Analysis = {
  year: number; month: string; dates: string[]; curDates: string[]; prevDates: string[];
  totals: { date: string; value: number; qty: number; skus: number }[];
  items: InvAttrs[]; locs: string[]; rows: number[][]; rawDesc: Record<string, string>;
  pal?: Record<string, number>;                                   // uds por palet de cada artículo (inventario)
};

// Características por las que se desglosa (como el selector de Commercial Analysis, más Product Range,
// Categorization Code, Customer Group Code y PM Classification del artículo; sin Customer, Dimension, KAM ni Sell
// Country, que no existen en el inventario)
export const DIMS = ['location', 'bu', 'line', 'range', 'cat', 'cg', 'pmc', 'license', 'royalty', 'raw', 'root', 'article'] as const;
export type Dim = typeof DIMS[number];
// En el valor de inventario no se desglosa por artículo (solo en las compras)
const ARTICLE_DIMS: Dim[] = ['raw', 'root', 'article'];
const DIM_LABEL: Record<Exclude<Dim, 'location'>, string> = {
  bu: 'Business Unit', line: 'Product Line', range: 'Product Range', cat: 'Categorization Code', cg: 'Customer Group Code', pmc: 'PM Classification', license: 'License',
  royalty: 'License Royalty', raw: 'Raw Article', root: 'Article To Root', article: 'Article',
};

const pctChange = (a: number, b: number) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

// % de variación en pequeño, verde si sube y rojo si baja (invert: al revés, p. ej. más días en stock es peor)
export function Delta({ fmt, cur, prev, invert = false }: { fmt: Fmt; cur: number | null; prev: number | null; invert?: boolean }) {
  const p = cur == null || prev == null ? null : pctChange(cur, prev);
  if (p === null) return <span className="text-gray-400">–</span>;
  return <Signed v={p} invert={invert} text={`${p > 0 ? '+' : ''}${fmt.pct(p)}`} />;
}

// stock: inventario a cada fin de mes (tabla a la fecha del informe y a la misma fecha del año anterior)
// flow: compras de cada mes (tabla con el mes del informe y el acumulado del año frente al mismo periodo del anterior)
// ads: Average Days in Stock (filas = uds × días y uds; cada grupo = suma de uds × días / suma de uds), como flow
export type BreakdownKind = 'stock' | 'flow' | 'ads';
const TITLE: Record<BreakdownKind, 'trendTitle' | 'purTrendTitle' | 'adsTrendTitle'> = { stock: 'trendTitle', flow: 'purTrendTitle', ads: 'adsTrendTitle' };
const NOTE: Record<BreakdownKind, 'locNote' | 'purNote' | 'adsNote'> = { stock: 'locNote', flow: 'purNote', ads: 'adsNote' };

type Group = { v: number[]; q: number[] };

// Grupo de una fila [fecha, artículo, location, …] según la característica elegida
function keyFn(an: Analysis, dim: Dim, none: string) {
  const desc = (code: string) => `${code} ${an.rawDesc[code] || ''}`.trim();
  return (r: number[]): string => {
    const it = an.items[r[1]];
    switch (dim) {
      case 'location': return an.locs[r[2]];
      case 'article': return `${it.no} ${it.desc}`.trim();
      case 'raw': return it.raw ? desc(it.raw) : none;
      case 'root': return it.root ? desc(it.root) : none;
      default: return it[dim] || none;
    }
  };
}

// opts (otros informes con el mismo gráfico + detalle, p. ej. Amazon): título y nota propios y las características
// que se ofrecen en "Detalle por" (la primera es la inicial)
export type BreakdownOpts = { title?: string; note?: string; dims?: Dim[] };

// Valor de inventario: la tabla lleva además el nº de palets (uds del grupo por artículo ÷ uds por palet, hacia arriba)
// y el Average Days in Stock del mes de cada grupo (adsData = filas del ADS)
export default function InventoryBreakdown({ fmt, an, kind = 'stock', adsData, opts }: { fmt: Fmt; an: Analysis; kind?: BreakdownKind; adsData?: Analysis | null; opts?: BreakdownOpts }) {
  const { t, eur, pct, num } = fmt;
  const stock = kind === 'stock';
  const ads = kind === 'ads';
  const dimList = opts?.dims ?? DIMS.filter(d => kind === 'flow' || !ARTICLE_DIMS.includes(d));
  const [dim, setDim] = useState<Dim>(dimList[0]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const nPrev = an.prevDates.length;
  const curIdx = nPrev + an.curDates.length - 1;                 // fecha del informe
  const monthNo = an.curDates.length;                            // mes del informe (1-12)
  const refIdx = monthNo <= nPrev ? monthNo - 1 : -1;            // mismo mes del año anterior
  const months = Array.from({ length: 12 }, (_, i) => `${an.year}-${String(i + 1).padStart(2, '0')}`);
  const monthLabel = (i: number) => fmt.monthName(months[i], 'short').replace(/\s*\d+$/, '');

  // Importe (o uds × días) y uds por grupo y fecha
  const groups = useMemo(() => {
    const key = keyFn(an, dim, t('none'));
    const map = new Map<string, Group>();
    for (const r of an.rows) {
      const k = key(r);
      let g = map.get(k);
      if (!g) { g = { v: new Array(an.dates.length).fill(0), q: new Array(an.dates.length).fill(0) }; map.set(k, g); }
      g.v[r[0]] += r[3];
      g.q[r[0]] += r[4];
    }
    return map;
  }, [an, dim, t]);

  // Palets y ADS por grupo (solo valor de inventario)
  const extras = useMemo(() => {
    if (!stock) return null;
    const key = keyFn(an, dim, t('none'));
    const qty = new Map<string, number>();                      // grupo|artículo → uds a la fecha
    for (const r of an.rows) if (r[0] === curIdx) { const k = `${key(r)}\u0000${an.items[r[1]].no}`; qty.set(k, (qty.get(k) || 0) + r[4]); }
    const pallets = new Map<string, number>();
    for (const [k, q] of qty) {
      const [g, no] = k.split('\u0000');
      const per = an.pal?.[no];
      if (per && q > 0) pallets.set(g, (pallets.get(g) || 0) + Math.ceil(q / per - 1e-9));
    }
    const ads = new Map<string, { v: number; q: number }>();
    if (adsData) {
      const aKey = keyFn(adsData, dim, t('none'));
      const aIdx = adsData.prevDates.length + adsData.curDates.length - 1;
      for (const r of adsData.rows) {
        if (r[0] !== aIdx) continue;
        const g = ads.get(aKey(r)) || { v: 0, q: 0 };
        g.v += r[3]; g.q += r[4];
        ads.set(aKey(r), g);
      }
    }
    return { pallets, ads };
  }, [an, adsData, dim, stock, curIdx, t]);
  const palletsOf = (k: string | null) => (k == null ? Array.from(extras?.pallets.values() || []).reduce((s, x) => s + x, 0) : extras?.pallets.get(k) || 0);
  const adsOf = (k: string | null) => {
    const list = k == null ? Array.from(extras?.ads.values() || []) : [extras?.ads.get(k)].filter(Boolean) as { v: number; q: number }[];
    const q = list.reduce((s, x) => s + x.q, 0);
    return q ? list.reduce((s, x) => s + x.v, 0) / q : null;
  };

  const changeDim = (d: Dim) => { setDim(d); setSelected(new Set()); };
  const toggle = (k: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // Medida de un grupo (o de la suma de varios) entre dos índices de fecha: importe sumado o días medios
  const sumRange = (a: number[], from: number, to: number) => { let x = 0; for (let i = from; i <= to; i++) x += a[i] || 0; return x; };
  const measure = (gs: Group[], from: number, to: number): number | null => {
    if (to < from) return ads ? null : 0;
    const v = gs.reduce((s, g) => s + sumRange(g.v, from, to), 0);
    if (!ads) return v;
    const q = gs.reduce((s, g) => s + sumRange(g.q, from, to), 0);
    return q ? v / q : null;
  };
  const lyTo = Math.min(monthNo, nPrev) - 1;
  const rowOf = (key: string, gs: Group[]) => stock
    ? { key, month: null as number | null, value: measure(gs, curIdx, curIdx), ref: refIdx >= 0 ? measure(gs, refIdx, refIdx) : null, qty: 0 }
    : { key, month: measure(gs, curIdx, curIdx), value: measure(gs, nPrev, curIdx), ref: measure(gs, 0, lyTo), qty: gs.reduce((s, g) => s + sumRange(g.q, nPrev, curIdx), 0) };

  // Filas de la tabla (días en stock: por uds que han salido en el año)
  const rows = Array.from(groups.entries())
    .map(([k, g]) => rowOf(k, [g]))
    .filter(r => ads ? r.qty > 0 || r.ref != null : Math.abs(r.value || 0) >= 0.5 || Math.abs(r.ref || 0) >= 0.5)
    .sort((a, b) => ads ? b.qty - a.qty : (b.value || 0) - (a.value || 0) || (b.ref || 0) - (a.ref || 0));
  const totalRow = rowOf(t('total'), Array.from(groups.values()));
  const totalQty = totalRow.qty;

  // Gráfico: medida de las filas seleccionadas (o de todas) por mes
  const chartGroups = Array.from(groups.entries()).filter(([k]) => !selected.size || selected.has(k)).map(([, g]) => g);
  const series = (offset: number, count: number) => months.map((_, m) => (m >= count ? null : measure(chartGroups, offset + m, offset + m)));
  const chartLabel = selected.size
    ? Array.from(selected).slice(0, 3).join(', ') + (selected.size > 3 ? ` +${selected.size - 3}` : '')
    : t('trendAll');
  const dimName = (d: Dim) => (d === 'location' ? t('location') : DIM_LABEL[d]);
  const fmtV = (v: number | null) => (v == null ? '–' : ads ? t('daysN', { n: num(v) }) : eur(v));
  const share = (r: { value: number | null; qty: number }) => ads
    ? pct(totalQty ? (r.qty / totalQty) * 100 : 0)
    : pct(totalRow.value ? ((r.value || 0) / totalRow.value) * 100 : 0);
  const td = 'py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap';

  return (
    <Grid>
      <Card title={opts?.title ?? t(TITLE[kind])} sub={`${t('trendSub', { year: an.year, prev: an.year - 1 })} · ${dimName(dim)}: ${chartLabel}`}>
        <LineChart fmt={fmt} height={360} days={ads} labels={months.map((_, i) => monthLabel(i))} datasets={[
          { label: String(an.year), data: series(nPrev, monthNo), color: C.navy },
          { label: String(an.year - 1), data: series(0, nPrev), color: C.magenta, dashed: true },
        ]} />
      </Card>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            {t('detailBy')}
            <select value={dim} onChange={e => changeDim(e.target.value as Dim)}
              className="rpt-noprint border border-gray-300 rounded-lg px-2 py-1 text-sm font-semibold bg-white">
              {dimList.map(d => <option key={d} value={d}>{dimName(d)}</option>)}
            </select>
          </label>
          {selected.size > 0
            ? <button onClick={() => setSelected(new Set())} className="rpt-noprint text-xs font-semibold text-[#C8186C] hover:underline">{t('clearSel', { n: selected.size })}</button>
            : <span className="rpt-noprint text-xs text-gray-400">{t('selectHint')}</span>}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-gray-200 text-[10px] font-semibold uppercase tracking-wider text-gray-500 font-mono">
                <th className="py-2 px-2 text-left">{dimName(dim)}</th>
                {!stock && <th className="py-2 px-2 text-right hidden md:table-cell">{fmt.monthName(months[monthNo - 1], 'short')}</th>}
                <th className="py-2 px-2 text-right">{stock ? t('valueAt', { date: fmt.shortDate(an.curDates[monthNo - 1]) }) : t('ytd', { year: an.year })}</th>
                <th className="py-2 px-2 text-right hidden md:table-cell">{ads ? t('unitsOutPct') : t('pctTotal')}</th>
                {stock ? (
                  <>
                    <th className="py-2 px-2 text-right">{t('palletsCol')}</th>
                    <th className="py-2 px-2 text-right">{t('adsCol', { month: fmt.monthName(months[monthNo - 1], 'short') })}</th>
                  </>
                ) : (
                  <>
                    <th className="py-2 px-2 text-right">{t('ytd', { year: an.year - 1 })}</th>
                    <th className="py-2 px-2 text-right">{t('deltaYoy')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const on = selected.has(r.key);
                return (
                  <tr key={r.key} onClick={() => toggle(r.key)}
                    className={`border-b border-gray-100 cursor-pointer ${on ? 'bg-[#24305E]/10 font-semibold' : selected.size ? 'text-gray-400 hover:bg-gray-50' : 'hover:bg-gray-50'}`}>
                    <td className="py-2 px-2">{r.key}</td>
                    {!stock && <td className={`${td} hidden md:table-cell`}>{fmtV(r.month)}</td>}
                    <td className={td}>{fmtV(r.value)}{stock && <span className="block text-[10px] font-semibold"><Delta fmt={fmt} cur={r.value} prev={r.ref} /></span>}</td>
                    <td className={`${td} hidden md:table-cell`}>{share(r)}</td>
                    {stock ? (
                      <>
                        <td className={td}>{num(palletsOf(r.key))}</td>
                        <td className={td}>{adsOf(r.key) == null ? '–' : t('daysN', { n: num(adsOf(r.key)!) })}</td>
                      </>
                    ) : (
                      <>
                        <td className={td}>{fmtV(r.ref)}</td>
                        <td className={td}><Delta fmt={fmt} cur={r.value} prev={r.ref} invert={ads} /></td>
                      </>
                    )}
                  </tr>
                );
              })}
              <tr className="border-t border-gray-300 font-semibold">
                <td className="py-2 px-2">{t('total')}</td>
                {!stock && <td className={`${td} hidden md:table-cell`}>{fmtV(totalRow.month)}</td>}
                <td className={td}>{fmtV(totalRow.value)}{stock && <span className="block text-[10px] font-semibold"><Delta fmt={fmt} cur={totalRow.value} prev={totalRow.ref} /></span>}</td>
                <td className={`${td} hidden md:table-cell`}>{pct(100)}</td>
                {stock ? (
                  <>
                    <td className={td}>{num(palletsOf(null))}</td>
                    <td className={td}>{adsOf(null) == null ? '–' : t('daysN', { n: num(adsOf(null)!) })}</td>
                  </>
                ) : (
                  <>
                    <td className={td}>{fmtV(totalRow.ref)}</td>
                    <td className={td}><Delta fmt={fmt} cur={totalRow.value} prev={totalRow.ref} invert={ads} /></td>
                  </>
                )}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-gray-500">{opts?.note ?? t(NOTE[kind])}</p>
      </Card>
    </Grid>
  );
}
