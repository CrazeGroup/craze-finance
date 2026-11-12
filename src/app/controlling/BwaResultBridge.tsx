'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Fmt } from '../reporting/i18n';

// BWA: resumen de por qué cambia el resultado (Net Income) frente al año anterior.
//   Δ Net Income = efecto volumen (más/menos Sales Revenues con el margen bruto % del año anterior)
//                + efecto margen (cada cuenta de Sales Provisions y COGS: lo que pesa ahora sobre la venta frente a antes)
//                + Δ de cada partida de gastos (Personnel, Marketing, Logistic…, Depreciation, Financial)
// y, para CRAZE GmbH, los Customer Groups que más mueven el margen de producto (Customer Margin): su margen frente a si
// hubieran vendido con el margen medio del año anterior.

export type BridgeItem = { key: string; label: string; impact: number; detail?: string; accounts?: { label: string; impact: number }[] };
export type Bridge = {
  title: string; cur: number; prev: number; items: BridgeItem[];
  salesCur: number; salesPrev: number; gmPctCur: number | null; gmPctPrev: number | null;
  // Para Customer Margin (CRAZE GmbH): año y meses comparados
  margin?: { year: number; fromM: number; toM: number };
};

const sign = (v: number, num: Fmt['num']) => `${v > 0 ? '+' : ''}${num(v, 0)} €`;
const tone = (v: number) => (v > 0 ? 'text-emerald-700' : v < 0 ? 'text-[#C0392B]' : 'text-gray-500');

export default function BwaResultBridge({ b, fmt, extra }: { b: Bridge; fmt: Fmt; extra?: React.ReactNode }) {
  const { num } = fmt;
  const diff = b.cur - b.prev;
  const items = [...b.items].filter(i => Math.abs(i.impact) >= 1).sort((x, y) => Math.abs(y.impact) - Math.abs(x.impact));
  const max = Math.max(1, ...items.map(i => Math.abs(i.impact)));
  const pct = (v: number | null) => (v == null ? '–' : `${num(v * 100, 1)} %`);
  return (
    <div className="rpt-card bg-white rounded-xl border border-gray-200 p-5 space-y-4">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-[#C8186C] mb-1">Por qué cambia el resultado · {b.title}</p>
        <p className="text-sm text-gray-800">
          Net Income {num(b.prev, 0)} € → <b>{num(b.cur, 0)} €</b> (<span className={`font-semibold ${tone(diff)}`}>{sign(diff, num)}</span>).
          {' '}Ventas {num(b.salesPrev, 0)} € → {num(b.salesCur, 0)} € · margen bruto {pct(b.gmPctPrev)} → {pct(b.gmPctCur)} de las ventas.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Cada partida es lo que suma o resta al resultado frente al año anterior (en verde mejora, en rojo empeora); juntas dan la diferencia del Net Income.
          Volumen = la variación de ventas con el margen bruto % del año anterior; margen = cuánto pesa ahora cada cuenta de provisiones y COGS sobre la venta frente al año anterior.
        </p>
      </div>
      <div className="space-y-2">
        {items.map(i => (
          <div key={i.key} className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[260px_minmax(0,1fr)_120px] gap-x-4 gap-y-1 items-start">
            <div>
              <p className="text-sm font-semibold text-gray-900">{i.label}</p>
              {i.detail && <p className="text-xs text-gray-500">{i.detail}</p>}
            </div>
            <div className="hidden md:block pt-1">
              <div className="h-2.5 rounded bg-gray-100 overflow-hidden">
                <div className={`h-full ${i.impact >= 0 ? 'bg-emerald-500' : 'bg-[#C0392B]'}`} style={{ width: `${(Math.abs(i.impact) / max) * 100}%` }} />
              </div>
              {i.accounts && i.accounts.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px]">
                  {i.accounts.map(a => (
                    <span key={a.label} className="whitespace-nowrap text-gray-600">{a.label} <span className={`font-semibold tabular-nums ${tone(a.impact)}`}>{sign(a.impact, num)}</span></span>
                  ))}
                </div>
              )}
            </div>
            <p className={`text-sm font-bold tabular-nums text-right ${tone(i.impact)}`}>{sign(i.impact, num)}</p>
          </div>
        ))}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[260px_minmax(0,1fr)_120px] gap-x-4 border-t-2 border-gray-900 pt-2">
          <p className="text-sm font-bold text-gray-900">Diferencia Net Income</p>
          <span className="hidden md:block" />
          <p className={`text-sm font-bold tabular-nums text-right ${tone(diff)}`}>{sign(diff, num)}</p>
        </div>
      </div>
      {extra}
      {b.margin && <CustomerMix fmt={fmt} {...b.margin} />}
    </div>
  );
}

// Customer Groups (CRAZE GmbH, Customer Margin) que más mueven el margen de producto (venta − coste del producto)
type MarginYear = { groups: Record<string, string>; docs: (string | number)[][] };
function CustomerMix({ fmt, year, fromM, toM }: { fmt: Fmt; year: number; fromM: number; toM: number }) {
  const { num } = fmt;
  const [data, setData] = useState<{ cur: MarginYear; prev: MarginYear | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setData(null); setError('');
    fetch(`/api/customer-margin?year=${year}`, { cache: 'no-store', headers: { 'x-craze-company': 'CRAZE' } })
      .then(r => r.json()).then(d => { if (cancelled) return; if (d.error) setError(d.error); else setData(d); })
      .catch(e => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [year]);

  const rows = useMemo(() => {
    if (!data?.prev) return null;
    const inRange = (date: string) => { const m = Number(date.substring(5, 7)); return m >= fromM && m <= toM; };
    const agg = (y: MarginYear) => {
      const g = new Map<string, { s: number; gp: number }>();
      for (const r of y.docs) {
        if (!inRange(String(r[2]))) continue;
        const k = String(r[4]);
        const x = g.get(k) || { s: 0, gp: 0 };
        x.s += Number(r[5]) || 0; x.gp += (Number(r[5]) || 0) - (Number(r[6]) || 0);
        g.set(k, x);
      }
      return g;
    };
    const cur = agg(data.cur), prev = agg(data.prev);
    const tot = (g: Map<string, { s: number; gp: number }>) => [...g.values()].reduce((t, x) => ({ s: t.s + x.s, gp: t.gp + x.gp }), { s: 0, gp: 0 });
    const tc = tot(cur), tp = tot(prev);
    const avgPrev = tp.s ? tp.gp / tp.s : 0;
    // Efecto de cada grupo = su margen de producto de más/menos, descontando lo que daría su variación de venta al margen medio del año anterior
    const list = [...new Set([...cur.keys(), ...prev.keys()])].map(k => {
      const c = cur.get(k) || { s: 0, gp: 0 }, p = prev.get(k) || { s: 0, gp: 0 };
      return { k, name: data.cur.groups[k] || data.prev!.groups[k] || '', c, p, effect: (c.gp - p.gp) - (c.s - p.s) * avgPrev };
    }).filter(x => Math.abs(x.effect) >= 1).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
    return { list: list.slice(0, 6), tc, tp, avgPrev };
  }, [data, fromM, toM]);

  if (error) return <p className="text-xs text-gray-500">Customer Margin no disponible: {error}</p>;
  if (!data) return <p className="text-xs text-gray-500">Cargando el margen por Customer Group (Customer Margin)…</p>;
  if (!rows) return null;
  const pct = (a: number, b: number) => (b ? `${num((a / b) * 100, 1)} %` : '–');
  return (
    <div className="border-t border-gray-200 pt-4">
      <p className="text-xs font-bold uppercase tracking-widest text-gray-700 mb-1">Margen de producto por Customer Group · CRAZE GmbH</p>
      <p className="text-xs text-gray-500 mb-3">
        Venta − coste del producto de las facturas y abonos (Customer Margin): {pct(rows.tp.gp, rows.tp.s)} el año anterior → {pct(rows.tc.gp, rows.tc.s)} ahora.
        Efecto = lo que ese grupo suma o resta frente a haber vendido su variación de venta con el margen medio del año anterior ({pct(rows.avgPrev, 1)}): en rojo, ventas con menos margen.
      </p>
      <table className="w-full text-[12px]">
        <thead className="text-[10px] uppercase tracking-wider text-gray-500">
          <tr>
            <th className="text-left py-1">Customer Group</th>
            <th className="text-right py-1">Venta año ant.</th>
            <th className="text-right py-1">Venta</th>
            <th className="text-right py-1">Margen % año ant.</th>
            <th className="text-right py-1">Margen %</th>
            <th className="text-right py-1">Efecto</th>
          </tr>
        </thead>
        <tbody>
          {rows.list.map(x => (
            <tr key={x.k} className="border-t border-gray-100">
              <td className="py-1"><span className="font-semibold">{x.k || '(sin grupo)'}</span>{x.name && <span className="text-gray-500"> · {x.name}</span>}</td>
              <td className="py-1 text-right tabular-nums text-gray-500">{num(x.p.s, 0)}</td>
              <td className="py-1 text-right tabular-nums">{num(x.c.s, 0)}</td>
              <td className="py-1 text-right tabular-nums text-gray-500">{pct(x.p.gp, x.p.s)}</td>
              <td className="py-1 text-right tabular-nums">{pct(x.c.gp, x.c.s)}</td>
              <td className={`py-1 text-right tabular-nums font-semibold ${tone(x.effect)}`}>{sign(x.effect, num)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
