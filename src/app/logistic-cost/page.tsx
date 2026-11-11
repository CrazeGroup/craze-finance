'use client';

import React, { Fragment, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { makeT } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';

// Logistic Cost (CRAZE GmbH): % de coste logístico sobre la venta por Customer Group Code (Freight, Fuel, Other
// Surcharges, Timed Delivery, Total Costs, Total Charges), comparado con el mismo periodo del año anterior. Clic en un
// grupo: sus facturas (o por mes), con incidencia en las que el coste supera bastante la media del grupo.
// Datos de /api/logistic-cost (src/lib/logisticCost.ts).

const FIRST_YEAR = 2024;
const COLS = ['sales', 'units', 'freight', 'fuel', 'other', 'timed', 'totalCosts', 'totalCharges', 'pallets', 'weight', 'pieces', 'shipments'] as const;
type ColKey = typeof COLS[number];
type Year = {
  year: number; from: string; to: string; computedAt: string;
  groups: Record<string, string>; customers: Record<string, [string, string]>;
  invoices: (string | number)[][]; salesAll: Record<string, number>; unassigned: { amount: number; rows: number };
};
type Data = { cur: Year; prev: Year | null };

type Agg = Record<ColKey, number> & { n: number };
const zero = (): Agg => ({ ...Object.fromEntries(COLS.map(k => [k, 0])), n: 0 }) as Agg;
type Inv = { no: string; date: string; cust: string; name: string; group: string } & Record<ColKey, number>;
const toInv = (r: (string | number)[], y: Year): Inv => {
  const cust = String(r[2]);
  const o: any = { no: r[0], date: r[1], cust, name: y.customers[cust]?.[0] || '', group: y.customers[cust]?.[1] || '' };
  COLS.forEach((k, i) => { o[k] = Number(r[3 + i]) || 0; });
  return o;
};
const add = (a: Agg, i: Inv) => { for (const k of COLS) a[k] += i[k]; a.n++; };
const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

// Medias de un grupo para las incidencias
type Means = { pct: number | null; pallet: number | null; kg: number | null; unit: number | null };
const meansOf = (a: Agg): Means => ({
  pct: ratio(a.totalCharges, a.sales), pallet: ratio(a.totalCharges, a.pallets), kg: ratio(a.totalCharges, a.weight), unit: ratio(a.totalCharges, a.units),
});
const MIN_COST = 50;   // por debajo, no se marca (envíos pequeños)
function incidence(i: Inv, m: Means, k: number): string[] | null {
  if (i.totalCharges < MIN_COST || m.pct === null) return null;
  const p = ratio(i.totalCharges, i.sales);
  // Coste alto sobre la venta (o factura sin venta)
  if (p !== null && p < k * m.pct) return null;
  const reasons = [p === null ? 'sin venta' : `${(p / m.pct).toFixed(1)}× % venta`];
  const phys: [number | null, number | null, string][] = [
    [ratio(i.totalCharges, i.pallets), m.pallet, '€/palet'], [ratio(i.totalCharges, i.weight), m.kg, '€/kg'], [ratio(i.totalCharges, i.units), m.unit, '€/unidad'],
  ];
  const known = phys.filter(([v, mean]) => v !== null && mean !== null && mean > 0);
  const high = known.filter(([v, mean]) => (v as number) >= k * (mean as number));
  // También caro para lo que se ha enviado (palets, peso o unidades); sin esos datos basta el % de venta
  if (known.length && !high.length) return null;
  return [...reasons, ...high.map(([v, mean, label]) => `${((v as number) / (mean as number)).toFixed(1)}× ${label}`)];
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

export default function LogisticCostPage() {
  const { selectedCompany } = useCompany();
  const { lang } = useLanguage();
  const fmt = useMemo(() => makeT(lang), [lang]);
  const { eur, pct, num } = fmt;
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [factor, setFactor] = useState(2);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [byMonth, setByMonth] = useState(false);
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const [onlyInc, setOnlyInc] = useState(false);

  useEffect(() => { const f = Number(store.get('logistic:factor')); if (f) setFactor(f); setByMonth(store.get('logistic:mes') === '1'); }, []);
  const changeFactor = (f: number) => { setFactor(f); store.set('logistic:factor', String(f)); };
  const changeByMonth = (v: boolean) => { setByMonth(v); store.set('logistic:mes', v ? '1' : '0'); };

  const isGmbh = selectedCompany === 'CRAZE';
  useEffect(() => {
    if (!isGmbh) return;
    let cancelled = false;
    setState(s => ({ data: s.data?.cur.year === year ? s.data : null, loading: true, error: null }));
    fetch(`/api/logistic-cost?year=${year}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json();
        if (cancelled) return;
        setState(res.ok && !data.error ? { data, loading: false, error: null } : { data: null, loading: false, error: data.error || `HTTP ${res.status}` });
      })
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [year, reload, isGmbh]);

  const data = state.data;
  const view = useMemo(() => {
    if (!data) return null;
    const cur = data.cur.invoices.map(r => toInv(r, data.cur));
    // Año anterior: mismo periodo (hasta el mismo día)
    const cut = `${data.cur.year - 1}${data.cur.to.substring(4)}`;
    const prev = data.prev ? data.prev.invoices.map(r => toInv(r, data.prev!)).filter(i => i.date <= cut) : [];
    const groups = new Map<string, { cur: Agg; prev: Agg; invs: Inv[] }>();
    const g = (code: string) => { if (!groups.has(code)) groups.set(code, { cur: zero(), prev: zero(), invs: [] }); return groups.get(code)!; };
    const total = { cur: zero(), prev: zero() };
    for (const i of cur) { add(g(i.group).cur, i); g(i.group).invs.push(i); add(total.cur, i); }
    for (const i of prev) { add(g(i.group).prev, i); add(total.prev, i); }
    const rows = [...groups.entries()].map(([code, x]) => {
      const means = meansOf(x.cur);
      const flagged = new Map<string, string[]>();
      for (const i of x.invs) { const r = incidence(i, means, factor); if (r) flagged.set(i.no, r); }
      return { code, name: data.cur.groups[code] || data.prev?.groups[code] || '', ...x, means, flagged };
    }).sort((a, b) => b.cur.sales - a.cur.sales);
    return { rows, total, incidents: rows.reduce((t, r) => t + r.flagged.size, 0) };
  }, [data, factor]);

  const years = Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => thisYear - i);
  const td = 'py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap';
  const th = 'py-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap';
  const p = (a: Agg, k: ColKey) => { const r = ratio(a[k], a.sales); return r === null ? '–' : pct(r * 100, 2); };
  const per = (a: { totalCharges: number } & Record<string, number>, k: 'pallets' | 'weight' | 'units', digits = 2) => {
    const r = ratio(a.totalCharges, a[k]); return r === null ? '–' : eur(r, digits);
  };
  const dpp = (a: Agg, b: Agg) => {
    const x = ratio(a.totalCharges, a.sales); const y = ratio(b.totalCharges, b.sales);
    if (x === null || y === null) return <span className="text-gray-300">–</span>;
    const d = (x - y) * 100;
    return <span className={d > 0.05 ? 'text-[#C0392B]' : d < -0.05 ? 'text-[#2E7D4F]' : 'text-gray-500'}>{d > 0 ? '+' : ''}{num(d, 2)} pp</span>;
  };
  const PCT_COLS: [ColKey, string][] = [['freight', 'Freight Charges'], ['fuel', 'Fuel Surcharge'], ['other', 'Other Surcharges'], ['timed', 'Timed Delivery'], ['totalCosts', 'Total Costs'], ['totalCharges', 'Total Charges']];

  // Fila de importes: los % sobre la venta y las métricas físicas
  const metricCells = (a: Agg) => (
    <>
      <td className={td}>{eur(a.sales)}</td>
      {PCT_COLS.map(([k]) => <td key={k} className={`${td} ${k === 'totalCharges' ? 'font-semibold' : ''}`} title={eur(a[k], 2)}>{p(a, k)}</td>)}
      <td className={td}>{num(a.pallets, 1)}</td>
      <td className={td}>{per(a as any, 'pallets')}</td>
      <td className={td}>{num(a.weight)}</td>
      <td className={td}>{per(a as any, 'weight', 3)}</td>
      <td className={td}>{num(a.units)}</td>
      <td className={td}>{per(a as any, 'units', 3)}</td>
    </>
  );
  const invAgg = (i: Inv): Agg => ({ ...i, n: 1 });

  return (
    <div className="rpt-root min-h-screen bg-[#F3F4F7] pb-24">
      <header className="rpt-header sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-4 mr-auto">
            <Image src="/logo.png" alt="Craze Group" width={104} height={50} className="object-contain" />
            <div>
              <p className="font-bold text-gray-900 leading-tight">Logistic Cost</p>
              <p className="text-xs text-gray-500">
                {data ? `${fmt.date(data.cur.from)} – ${fmt.date(data.cur.to)}` : '…'} · CRAZE GmbH
                {data && <> · calculado {new Date(data.cur.computedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2" title="Se marca la factura cuando su coste sobre la venta es X veces la media de su grupo (y también por palet, kg o unidad)">
              Incidencia desde
              <select value={factor} onChange={e => changeFactor(Number(e.target.value))} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white normal-case tracking-normal">
                {[1.5, 2, 3].map(f => <option key={f} value={f}>{f}× la media</option>)}
              </select>
            </label>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 hidden sm:inline">Año</span>
            <select value={year} onChange={e => { setYear(Number(e.target.value)); setOpenGroup(null); }} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold bg-white">
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={state.loading} title="Recalcular desde BC"
              className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
              <RefreshCw size={16} className={state.loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-6 space-y-8">
        {!isGmbh ? <p className="text-sm text-gray-600">Logistic Cost solo está disponible para CRAZE GmbH: selecciónala en el menú.</p>
          : state.error ? <ErrorBox message={state.error} />
          : !data || !view ? <Loading text="Calculando el coste logístico por factura (la primera vez puede tardar un par de minutos)…" />
          : (
            <>
              <Section title={`Logistic Cost ${data.cur.year}`} source={`Logistic Costs de BC enlazados con la factura de venta de su pedido · % sobre la venta (sin IVA) de esas facturas${data.prev ? ` · vs mismo periodo ${data.prev.year}` : ''}`}>
                <Grid cols={5}>
                  <Kpi label="Venta con logística" value={eur(view.total.cur.sales)} sub={`${num(view.total.cur.n)} facturas`} />
                  <Kpi label="Total Charges" value={eur(view.total.cur.totalCharges)} sub={data.prev ? `${data.prev.year}: ${eur(view.total.prev.totalCharges)}` : undefined} />
                  <Kpi label="% sobre venta" value={p(view.total.cur, 'totalCharges')} tone="main" highlight
                    extra={data.prev ? <p className="text-xs text-gray-500 mt-1">{data.prev.year}: {p(view.total.prev, 'totalCharges')} · {dpp(view.total.cur, view.total.prev)}</p> : undefined} />
                  <Kpi label="€ por palet · por kg" value={per(view.total.cur as any, 'pallets')} sub={`${per(view.total.cur as any, 'weight', 3)} / kg · ${num(view.total.cur.pallets)} palets`} />
                  <Kpi label="Incidencias" value={num(view.incidents)} tone={view.incidents ? 'red' : 'neutral'} sub={`coste ≥ ${factor}× la media de su grupo`} />
                </Grid>
                {data.cur.unassigned.rows > 0 && (
                  <p className="text-xs text-gray-500">
                    Sin factura (pedido aún no facturado o sin enlace): {num(data.cur.unassigned.rows)} envíos · {eur(data.cur.unassigned.amount)}. No entran en los %.
                  </p>
                )}
              </Section>

              <Section title="Por Customer Group" source="Clic en un grupo para ver sus facturas · los % son sobre la venta · pasa el ratón por un % para ver el importe">
                <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className={`${th} text-left`}>Customer Group</th>
                        <th className={`${th} text-right`}>Venta</th>
                        {PCT_COLS.map(([k, l]) => <th key={k} className={`${th} text-right`}>{l}</th>)}
                        <th className={`${th} text-right`}>Palets</th>
                        <th className={`${th} text-right`}>€/palet</th>
                        <th className={`${th} text-right`}>Kg</th>
                        <th className={`${th} text-right`}>€/kg</th>
                        <th className={`${th} text-right`}>Unidades</th>
                        <th className={`${th} text-right`}>€/unidad</th>
                        {data.prev && <th className={`${th} text-right`}>Total % {data.prev.year}</th>}
                        {data.prev && <th className={`${th} text-right`}>Δ</th>}
                        <th className={`${th} text-right`}>Incid.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.rows.map(r => {
                        const open = openGroup === r.code;
                        const invs = (onlyInc ? r.invs.filter(i => r.flagged.has(i.no)) : r.invs);
                        const months = new Map<string, { agg: Agg; invs: Inv[] }>();
                        for (const i of invs) {
                          const m = i.date.substring(0, 7);
                          if (!months.has(m)) months.set(m, { agg: zero(), invs: [] });
                          add(months.get(m)!.agg, i); months.get(m)!.invs.push(i);
                        }
                        const invRow = (i: Inv, indent: string) => {
                          const inc = r.flagged.get(i.no);
                          return (
                            <tr key={i.no} className={`border-t border-gray-100 ${inc ? 'bg-red-50/60' : 'bg-gray-50/40'}`}>
                              <td className={`py-1.5 px-2 ${indent}`}>
                                <span className="font-mono text-gray-900">{i.no}</span>
                                <span className="text-xs text-gray-500"> · {fmt.date(i.date)} · {i.name || i.cust}</span>
                                {inc && <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-semibold text-[#C0392B]" title={`Media del grupo: ${r.means.pct !== null ? pct(r.means.pct * 100, 2) : '–'} · ${r.means.pallet !== null ? eur(r.means.pallet, 2) : '–'}/palet · ${r.means.kg !== null ? eur(r.means.kg, 3) : '–'}/kg · ${r.means.unit !== null ? eur(r.means.unit, 3) : '–'}/unidad`}><AlertTriangle size={12} /> {inc.join(' · ')}</span>}
                              </td>
                              {metricCells(invAgg(i))}
                              {data.prev && <td className={td} />}
                              {data.prev && <td className={td} />}
                              <td className={`${td} text-gray-500`} title="Total Charges de la factura">{eur(i.totalCharges)}</td>
                            </tr>
                          );
                        };
                        return (
                          <Fragment key={r.code || '—'}>
                            <tr className={`border-t border-gray-100 cursor-pointer hover:bg-gray-50 ${open ? 'bg-gray-50' : ''}`} onClick={() => { setOpenGroup(open ? null : r.code); setOpenMonths(new Set()); }}>
                              <td className="py-1.5 px-2 whitespace-nowrap">
                                <span className="inline-flex items-center gap-1 font-semibold text-gray-900">
                                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{r.code || '(sin grupo)'}
                                </span>
                                {r.name && <span className="text-xs text-gray-500"> · {r.name}</span>}
                              </td>
                              {metricCells(r.cur)}
                              {data.prev && <td className={`${td} text-gray-500`}>{p(r.prev, 'totalCharges')}</td>}
                              {data.prev && <td className={td}>{dpp(r.cur, r.prev)}</td>}
                              <td className={`${td} ${r.flagged.size ? 'text-[#C0392B] font-semibold' : 'text-gray-300'}`}>{r.flagged.size || '–'}</td>
                            </tr>
                            {open && (
                              <tr className="bg-white">
                                <td colSpan={99} className="px-2 py-2 border-t border-gray-100">
                                  <div className="flex flex-wrap items-center gap-4 text-xs">
                                    <div className="flex rounded-lg border border-gray-300 overflow-hidden">
                                      {([[false, 'Facturas'], [true, 'Por mes']] as const).map(([v, l]) => (
                                        <button key={l} onClick={() => changeByMonth(v)} className={`px-3 py-1 font-semibold ${byMonth === v ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{l}</button>
                                      ))}
                                    </div>
                                    <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-gray-700">
                                      <input type="checkbox" checked={onlyInc} onChange={e => setOnlyInc(e.target.checked)} /> Solo incidencias ({r.flagged.size})
                                    </label>
                                    <span className="text-gray-500">
                                      Media del grupo: {r.means.pct !== null ? pct(r.means.pct * 100, 2) : '–'} de la venta · {r.means.pallet !== null ? eur(r.means.pallet, 2) : '–'}/palet · {r.means.kg !== null ? eur(r.means.kg, 3) : '–'}/kg · {r.means.unit !== null ? eur(r.means.unit, 3) : '–'}/unidad
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            )}
                            {open && !byMonth && invs.map(i => invRow(i, 'pl-8'))}
                            {open && byMonth && [...months.entries()].map(([m, x]) => {
                              const mo = openMonths.has(m);
                              const inc = x.invs.filter(i => r.flagged.has(i.no)).length;
                              return (
                                <Fragment key={m}>
                                  <tr className="border-t border-gray-100 bg-gray-50/70 cursor-pointer hover:bg-gray-100"
                                    onClick={() => setOpenMonths(s => { const n = new Set(s); if (n.has(m)) n.delete(m); else n.add(m); return n; })}>
                                    <td className="py-1.5 px-2 pl-8 whitespace-nowrap">
                                      <span className="inline-flex items-center gap-1 font-semibold text-gray-800">{mo ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{fmt.monthCode(m)}</span>
                                      <span className="text-xs text-gray-500"> · {x.agg.n} facturas</span>
                                    </td>
                                    {metricCells(x.agg)}
                                    {data.prev && <td className={td} />}
                                    {data.prev && <td className={td} />}
                                    <td className={`${td} ${inc ? 'text-[#C0392B] font-semibold' : 'text-gray-300'}`}>{inc || '–'}</td>
                                  </tr>
                                  {mo && x.invs.map(i => invRow(i, 'pl-14'))}
                                </Fragment>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                      <tr className="border-t-2 border-gray-900 font-semibold">
                        <td className="py-2 px-2">Total</td>
                        {metricCells(view.total.cur)}
                        {data.prev && <td className={`${td} text-gray-500`}>{p(view.total.prev, 'totalCharges')}</td>}
                        {data.prev && <td className={td}>{dpp(view.total.cur, view.total.prev)}</td>}
                        <td className={`${td} text-[#C0392B]`}>{view.incidents || ''}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-gray-500">
                  Total Costs = manipulación del almacén + flete; Total Charges = todo (con Fuel, Other Surcharges y Timed Delivery).
                  Incidencia: factura con Total Charges ≥ {MIN_COST} € y un % sobre la venta de al menos {factor}× la media de su grupo,
                  y que además sale cara para lo enviado (€/palet, €/kg o €/unidad ≥ {factor}× la media; si no hay esos datos, basta el %).
                </p>
              </Section>
            </>
          )}
      </main>
    </div>
  );
}
