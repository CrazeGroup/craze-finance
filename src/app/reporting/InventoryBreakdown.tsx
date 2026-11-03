'use client';

import React, { useMemo, useState } from 'react';
import type { Fmt } from './i18n';
import { C, Card, Grid, LineChart, Signed } from './ui';

// Datos de /api/reporting/inventory-analysis (src/lib/reporting/inventoryAnalysis.ts)
export type InvAttrs = { no: string; desc: string; range: string; cat: string; line: string; license: string; bu: string; raw: string; root: string; royalty: string };
export type Analysis = {
  year: number; month: string; dates: string[]; curDates: string[]; prevDates: string[];
  totals: { date: string; value: number; qty: number; skus: number }[];
  items: InvAttrs[]; locs: string[]; rows: number[][]; rawDesc: Record<string, string>;
};

// Características por las que se desglosa (como el selector de Commercial Analysis, más Product Range y
// Categorization Code; sin Customer, Dimension, KAM ni Sell Country, que no existen en el inventario)
const DIMS = ['location', 'bu', 'line', 'range', 'cat', 'license', 'royalty', 'raw', 'root', 'article'] as const;
type Dim = typeof DIMS[number];
// En el valor de inventario no se desglosa por artículo (solo en las compras)
const ARTICLE_DIMS: Dim[] = ['raw', 'root', 'article'];
const DIM_LABEL: Record<Exclude<Dim, 'location'>, string> = {
  bu: 'Business Unit', line: 'Product Line', range: 'Product Range', cat: 'Categorization Code', license: 'License',
  royalty: 'License Royalty', raw: 'Raw Article', root: 'Article To Root', article: 'Article',
};

const pctChange = (a: number, b: number) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

// % de variación en pequeño, verde si sube y rojo si baja
export function Delta({ fmt, cur, prev }: { fmt: Fmt; cur: number; prev: number }) {
  const p = pctChange(cur, prev);
  if (p === null) return <span className="text-gray-400">–</span>;
  return <Signed v={p} text={`${p > 0 ? '+' : ''}${fmt.pct(p)}`} />;
}

// stock: inventario a cada fin de mes (tabla a la fecha del informe); flow: compras de cada mes (tabla con el mes
// del informe y el acumulado del año frente al mismo periodo del año anterior)
export default function InventoryBreakdown({ fmt, an, kind = 'stock' }: { fmt: Fmt; an: Analysis; kind?: 'stock' | 'flow' }) {
  const { t, eur, pct, date } = fmt;
  const flow = kind === 'flow';
  const [dim, setDim] = useState<Dim>('location');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const nPrev = an.prevDates.length;
  const curIdx = nPrev + an.curDates.length - 1;                 // fecha del informe
  const monthNo = an.curDates.length;                            // mes del informe (1-12)
  const refIdx = monthNo <= nPrev ? monthNo - 1 : -1;            // mismo mes del año anterior
  const months = Array.from({ length: 12 }, (_, i) => `${an.year}-${String(i + 1).padStart(2, '0')}`);
  const monthLabel = (i: number) => fmt.monthName(months[i], 'short').replace(/\s*\d+$/, '');

  // Valor por grupo y fecha
  const groups = useMemo(() => {
    const none = t('none');
    const desc = (code: string) => `${code} ${an.rawDesc[code] || ''}`.trim();
    const key = (r: number[]): string => {
      const it = an.items[r[1]];
      switch (dim) {
        case 'location': return an.locs[r[2]];
        case 'article': return `${it.no} ${it.desc}`.trim();
        case 'raw': return it.raw ? desc(it.raw) : none;
        case 'root': return it.root ? desc(it.root) : none;
        default: return it[dim] || none;
      }
    };
    const map = new Map<string, number[]>();
    for (const r of an.rows) {
      const k = key(r);
      let v = map.get(k);
      if (!v) { v = new Array(an.dates.length).fill(0); map.set(k, v); }
      v[r[0]] += r[3];
    }
    return map;
  }, [an, dim, t]);

  const changeDim = (d: Dim) => { setDim(d); setSelected(new Set()); };
  const toggle = (k: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // Filas de la tabla: cada grupo a la fecha del informe y a la misma fecha del año anterior
  // (compras: acumulado del año hasta el mes del informe y mismo periodo del año anterior)
  const sumRange = (v: number[], from: number, to: number) => { let x = 0; for (let i = from; i <= to; i++) x += v[i] || 0; return x; };
  const rows = Array.from(groups.entries())
    .map(([k, v]) => flow
      ? { key: k, month: v[curIdx], value: sumRange(v, nPrev, curIdx), ref: sumRange(v, 0, Math.min(monthNo, nPrev) - 1) }
      : { key: k, month: 0, value: v[curIdx], ref: refIdx >= 0 ? v[refIdx] : 0 })
    .filter(r => Math.abs(r.value) >= 0.5 || Math.abs(r.ref) >= 0.5)
    .sort((a, b) => b.value - a.value || b.ref - a.ref);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const totalRef = rows.reduce((s, r) => s + r.ref, 0);
  const totalMonth = rows.reduce((s, r) => s + r.month, 0);

  // Gráfico: suma de las filas seleccionadas (o de todas)
  const series = (offset: number, count: number) => months.map((_, m) => {
    if (m >= count) return null;
    let v = 0;
    for (const [k, vals] of groups) if (!selected.size || selected.has(k)) v += vals[offset + m];
    return v;
  });
  const chartLabel = selected.size
    ? Array.from(selected).slice(0, 3).join(', ') + (selected.size > 3 ? ` +${selected.size - 3}` : '')
    : t('trendAll');
  const dimName = (d: Dim) => (d === 'location' ? t('location') : DIM_LABEL[d]);
  const refDate = refIdx >= 0 ? an.prevDates[refIdx] : null;

  return (
    <Grid>
      <Card title={t(flow ? 'purTrendTitle' : 'trendTitle')} sub={`${t('trendSub', { year: an.year, prev: an.year - 1 })} · ${dimName(dim)}: ${chartLabel}`}>
        <LineChart fmt={fmt} height={360} labels={months.map((_, i) => monthLabel(i))} datasets={[
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
              {DIMS.filter(d => flow || !ARTICLE_DIMS.includes(d)).map(d => <option key={d} value={d}>{dimName(d)}</option>)}
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
                {flow && <th className="py-2 px-2 text-right hidden md:table-cell">{fmt.monthName(months[monthNo - 1], 'short')}</th>}
                <th className="py-2 px-2 text-right">{flow ? t('ytd', { year: an.year }) : t('valueAt', { date: fmt.shortDate(an.curDates[monthNo - 1]) })}</th>
                <th className="py-2 px-2 text-right hidden md:table-cell">{t('pctTotal')}</th>
                <th className="py-2 px-2 text-right">{flow ? t('ytd', { year: an.year - 1 }) : t('refAt', { date: refDate ? date(refDate) : '–' })}</th>
                <th className="py-2 px-2 text-right">{t('deltaYoy')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const on = selected.has(r.key);
                return (
                  <tr key={r.key} onClick={() => toggle(r.key)}
                    className={`border-b border-gray-100 cursor-pointer ${on ? 'bg-[#24305E]/10 font-semibold' : selected.size ? 'text-gray-400 hover:bg-gray-50' : 'hover:bg-gray-50'}`}>
                    <td className="py-2 px-2">{r.key}</td>
                    {flow && <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap hidden md:table-cell">{eur(r.month)}</td>}
                    <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap">{eur(r.value)}</td>
                    <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap hidden md:table-cell">{pct(total ? (r.value / total) * 100 : 0)}</td>
                    <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap">{eur(r.ref)}</td>
                    <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap"><Delta fmt={fmt} cur={r.value} prev={r.ref} /></td>
                  </tr>
                );
              })}
              <tr className="border-t border-gray-300 font-semibold">
                <td className="py-2 px-2">{t('total')}</td>
                {flow && <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap hidden md:table-cell">{eur(totalMonth)}</td>}
                <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap">{eur(total)}</td>
                <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap hidden md:table-cell">{pct(100)}</td>
                <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap">{eur(totalRef)}</td>
                <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap"><Delta fmt={fmt} cur={total} prev={totalRef} /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-gray-500">{t(flow ? 'purNote' : 'locNote')}</p>
      </Card>
    </Grid>
  );
}
