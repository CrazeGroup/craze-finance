'use client';

import React, { Fragment, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { makeT } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';

// Customer Margin (CRAZE GmbH): margen por Customer Group Code = venta (facturas − abonos) − coste del producto − coste
// logístico − Skonto − Conditions out of invoice − Bonus − Marketing fee − Accounting Partner, comparado con el mismo
// periodo del año anterior. Clic en un grupo: sus clientes; en un cliente: sus facturas y abonos.
// Datos de /api/customer-margin (src/lib/customerMargin.ts).

const FIRST_YEAR = 2024;
const COLS = ['sales', 'cost', 'logistic', 'skonto', 'conditions', 'bonus', 'marketing', 'partner', 'qty'] as const;
type ColKey = typeof COLS[number];
type Year = { year: number; from: string; to: string; computedAt: string; groups: Record<string, string>; customers: Record<string, string>; docs: (string | number)[][] };
type Data = { cur: Year; prev: Year | null };
type Doc = { no: string; credit: boolean; date: string; cust: string; group: string } & Record<ColKey, number>;
type Agg = Record<ColKey, number> & { inv: number; cr: number; n: number };

const zero = (): Agg => ({ ...Object.fromEntries(COLS.map(k => [k, 0])), inv: 0, cr: 0, n: 0 }) as Agg;
const toDoc = (r: (string | number)[]): Doc => {
  const o: any = { no: r[0], credit: r[1] === 1, date: r[2], cust: r[3], group: r[4] };
  COLS.forEach((k, i) => { o[k] = Number(r[5 + i]) || 0; });
  return o;
};
const add = (a: Agg, d: Doc) => { for (const k of COLS) a[k] += d[k]; if (d.credit) a.cr += d.sales; else a.inv += d.sales; a.n++; };
const DEDUCT: [ColKey, string][] = [['cost', 'Coste producto'], ['logistic', 'Logística'], ['skonto', 'Skonto'], ['conditions', 'Conditions out of invoice'], ['bonus', 'Bonus'], ['marketing', 'Marketing fee'], ['partner', 'Accounting Partner']];
const margin = (a: Pick<Agg, ColKey>) => a.sales - DEDUCT.reduce((t, [k]) => t + a[k], 0);
const mPct = (a: Pick<Agg, ColKey>) => (a.sales ? (margin(a) / a.sales) * 100 : null);

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

export default function CustomerMarginPage() {
  const { selectedCompany } = useCompany();
  const { lang } = useLanguage();
  const fmt = useMemo(() => makeT(lang), [lang]);
  const { eur, pct, num } = fmt;
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [asPct, setAsPct] = useState(false);
  // Meses del año (1-12): desde / hasta; por defecto todo el año
  const [fromM, setFromM] = useState(1);
  const [toM, setToM] = useState(12);
  const [openG, setOpenG] = useState<Set<string>>(new Set());
  const [openC, setOpenC] = useState<Set<string>>(new Set());

  useEffect(() => { setAsPct(store.get('margin:pct') === '1'); }, []);
  const changeAsPct = (v: boolean) => { setAsPct(v); store.set('margin:pct', v ? '1' : '0'); };
  // Líneas de una factura / abono, cargadas al abrirla
  type DocLine = { no: string; description: string; component: boolean; qty: number; unitPrice: number; listPrice: number; discount: number; amount: number; unitCost: number; cost: number };
  const [openDocs, setOpenDocs] = useState<Set<string>>(new Set());
  const [docLines, setDocLines] = useState<Record<string, { lines: DocLine[] } | { error: string }>>({});
  const toggleDoc = (no: string) => {
    setOpenDocs(p => { const n = new Set(p); if (n.has(no)) n.delete(no); else n.add(no); return n; });
    if (docLines[no] && !('error' in docLines[no])) return;
    fetch(`/api/customer-margin/lines?doc=${encodeURIComponent(no)}`).then(r => r.json())
      .then(d => setDocLines(p => ({ ...p, [no]: d.error ? { error: d.error } : { lines: d.lines } })))
      .catch(e => setDocLines(p => ({ ...p, [no]: { error: e.message } })));
  };
  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, k: string) => set(p => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const isGmbh = selectedCompany === 'CRAZE';
  useEffect(() => {
    if (!isGmbh) return;
    let cancelled = false;
    setState(s => ({ data: s.data?.cur.year === year ? s.data : null, loading: true, error: null }));
    fetch(`/api/customer-margin?year=${year}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
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
    const inRange = (d: Doc) => { const m = Number(d.date.substring(5, 7)); return m >= fromM && m <= toM; };
    const cur = data.cur.docs.map(toDoc).filter(inRange);
    const cut = `${data.cur.year - 1}${data.cur.to.substring(4)}`;   // año anterior: mismo periodo (hasta el mismo día)
    const prev = data.prev ? data.prev.docs.map(toDoc).filter(d => inRange(d) && d.date <= cut) : [];
    type G = { code: string; cur: Agg; prev: Agg; custs: Map<string, { cur: Agg; prev: Agg; docs: Doc[] }> };
    const groups = new Map<string, G>();
    const g = (code: string) => { if (!groups.has(code)) groups.set(code, { code, cur: zero(), prev: zero(), custs: new Map() }); return groups.get(code)!; };
    const c = (gr: G, no: string) => { if (!gr.custs.has(no)) gr.custs.set(no, { cur: zero(), prev: zero(), docs: [] }); return gr.custs.get(no)!; };
    const total = { cur: zero(), prev: zero() };
    for (const d of cur) { const gr = g(d.group); add(gr.cur, d); const cc = c(gr, d.cust); add(cc.cur, d); cc.docs.push(d); add(total.cur, d); }
    for (const d of prev) { const gr = g(d.group); add(gr.prev, d); add(c(gr, d.cust).prev, d); add(total.prev, d); }
    const rows = [...groups.values()].filter(x => x.cur.n || x.prev.n).sort((a, b) => b.cur.sales - a.cur.sales);
    return { rows, total };
  }, [data, fromM, toM]);
  const lastMonth = data ? Number(data.cur.to.substring(5, 7)) : 12;
  const ymOf = (m: number) => `${year}-${String(m).padStart(2, '0')}`;
  const periodText = data ? (fromM === 1 && toM >= lastMonth ? `${fmt.date(data.cur.from)} – ${fmt.date(data.cur.to)}`
    : fromM === Math.min(toM, lastMonth) ? fmt.monthName(ymOf(fromM)) : `${fmt.monthCode(ymOf(fromM))} – ${fmt.monthCode(ymOf(Math.min(toM, lastMonth)))}`) : '…';

  const years = Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => thisYear - i);
  const td = 'py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap';
  const th = 'py-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap text-right';
  const val = (a: Pick<Agg, ColKey>, k: ColKey) => (asPct ? (a.sales ? pct((a[k] / a.sales) * 100, 2) : '–') : eur(a[k]));
  const dpp = (a: Agg, b: Agg) => {
    const x = mPct(a); const y = mPct(b);
    if (x === null || y === null || !b.n) return <span className="text-gray-300">–</span>;
    const d = x - y;
    return <span className={d > 0.05 ? 'text-[#2E7D4F]' : d < -0.05 ? 'text-[#C0392B]' : 'text-gray-500'}>{d > 0 ? '+' : ''}{num(d, 1)} pp</span>;
  };
  const cells = (a: Agg, ly: Agg | null, docSales?: boolean) => (
    <>
      <td className={td}>{docSales ? '' : eur(a.inv)}</td>
      <td className={`${td} text-gray-500`}>{docSales ? '' : (a.cr ? eur(a.cr) : '–')}</td>
      <td className={`${td} font-semibold`}>{eur(a.sales)}</td>
      {DEDUCT.map(([k]) => <td key={k} className={td} title={asPct ? eur(a[k]) : (a.sales ? pct((a[k] / a.sales) * 100, 2) : '')}>{val(a, k)}</td>)}
      <td className={`${td} font-semibold ${margin(a) < 0 ? 'text-[#C0392B]' : ''}`}>{eur(margin(a))}</td>
      <td className={`${td} font-semibold`}>{mPct(a) === null ? '–' : pct(mPct(a)!, 1)}</td>
      {data?.prev && <td className={`${td} text-gray-500`}>{ly && ly.n && mPct(ly) !== null ? pct(mPct(ly)!, 1) : ''}</td>}
      {data?.prev && <td className={td}>{ly ? dpp(a, ly) : ''}</td>}
    </>
  );

  return (
    <div className="rpt-root min-h-screen bg-[#F3F4F7] pb-24">
      <header className="rpt-header sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-4 mr-auto">
            <Image src="/logo.png" alt="Craze Group" width={104} height={50} className="object-contain" />
            <div>
              <p className="font-bold text-gray-900 leading-tight">Customer Margin</p>
              <p className="text-xs text-gray-500">
                {periodText} · CRAZE GmbH
                {data && <> · calculado {new Date(data.cur.computedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
              {([[false, '€'], [true, '% venta']] as const).map(([v, l]) => (
                <button key={l} onClick={() => changeAsPct(v)} className={`px-3 py-1.5 font-semibold ${asPct === v ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{l}</button>
              ))}
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 hidden sm:inline">Meses</span>
            <select value={fromM} onChange={e => { const v = Number(e.target.value); setFromM(v); if (v > toM) setToM(v); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" title="Desde">
              {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{fmt.monthCode(ymOf(m))}</option>)}
            </select>
            <span className="text-gray-400">–</span>
            <select value={toM} onChange={e => { const v = Number(e.target.value); setToM(v); if (v < fromM) setFromM(v); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" title="Hasta">
              {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{fmt.monthCode(ymOf(m))}</option>)}
            </select>
            {(fromM !== 1 || toM !== 12) && <button onClick={() => { setFromM(1); setToM(12); }} className="text-xs text-gray-500 underline hover:text-gray-900">Todo el año</button>}
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 hidden sm:inline">Año</span>
            <select value={year} onChange={e => { setYear(Number(e.target.value)); setOpenG(new Set()); setOpenC(new Set()); }} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold bg-white">
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
        {!isGmbh ? <p className="text-sm text-gray-600">Customer Margin solo está disponible para CRAZE GmbH: selecciónala en el menú.</p>
          : state.error ? <ErrorBox message={state.error} />
          : !data || !view ? <Loading text="Calculando el margen por cliente (la primera vez puede tardar un par de minutos)…" />
          : (
            <>
              <Section title={`Customer Margin ${fromM === 1 && toM >= lastMonth ? data.cur.year : periodText}`} source={`Facturas y abonos de venta (Documents LM Components) · condiciones de Conditions por grupo · logística de Logistic Cost${data.prev ? ` · vs mismo periodo ${data.prev.year}` : ''}`}>
                <Grid cols={5}>
                  <Kpi label="Venta neta" value={eur(view.total.cur.sales)} sub={`facturas ${eur(view.total.cur.inv)} · abonos ${eur(view.total.cur.cr)}`} />
                  <Kpi label="Coste producto" value={eur(view.total.cur.cost)} sub={view.total.cur.sales ? pct((view.total.cur.cost / view.total.cur.sales) * 100) : undefined} />
                  <Kpi label="Logística" value={eur(view.total.cur.logistic)} sub={view.total.cur.sales ? pct((view.total.cur.logistic / view.total.cur.sales) * 100) : undefined} />
                  <Kpi label="Condiciones" value={eur(DEDUCT.slice(2).reduce((t, [k]) => t + view.total.cur[k], 0))}
                    sub={view.total.cur.sales ? `${pct((DEDUCT.slice(2).reduce((t, [k]) => t + view.total.cur[k], 0) / view.total.cur.sales) * 100)} · Skonto, Conditions, Bonus, Marketing, Partner` : undefined} />
                  <Kpi label="Margen" value={eur(margin(view.total.cur))} tone="main" highlight
                    extra={<p className="text-xs text-gray-500 mt-1">{mPct(view.total.cur) !== null ? pct(mPct(view.total.cur)!) : '–'}{data.prev ? <> · {data.prev.year}: {mPct(view.total.prev) !== null ? pct(mPct(view.total.prev)!) : '–'} · {dpp(view.total.cur, view.total.prev)}</> : null}</p>} />
                </Grid>
              </Section>

              <Section title="Por Customer Group" source="Clic en un grupo para ver sus clientes y en un cliente para ver sus facturas y abonos · pasa el ratón por un importe para ver su % (o al revés)">
                <div className="bg-white rounded-xl border border-gray-200 table-scroll">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className={`${th} text-left`}>Customer Group / cliente</th>
                        <th className={th}>Facturas</th>
                        <th className={th}>Abonos</th>
                        <th className={th}>Venta neta</th>
                        {DEDUCT.map(([k, l]) => <th key={k} className={th}>{l}</th>)}
                        <th className={th}>Margen</th>
                        <th className={th}>Margen %</th>
                        {data.prev && <th className={th}>Margen % {data.prev.year}</th>}
                        {data.prev && <th className={th}>Δ</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {view.rows.map(r => {
                        const open = openG.has(r.code);
                        const custs = [...r.custs.entries()].filter(([, x]) => x.cur.n || x.prev.n).sort((a, b) => b[1].cur.sales - a[1].cur.sales);
                        return (
                          <Fragment key={r.code || '—'}>
                            <tr className={`border-t border-gray-100 cursor-pointer hover:bg-gray-50 ${open ? 'bg-gray-50' : ''}`} onClick={() => toggle(setOpenG, r.code)}>
                              <td className="py-1.5 px-2 whitespace-nowrap">
                                <span className="inline-flex items-center gap-1 font-semibold text-gray-900">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{r.code || '(sin grupo)'}</span>
                                {(data.cur.groups[r.code] || data.prev?.groups[r.code]) && <span className="text-xs text-gray-500"> · {data.cur.groups[r.code] || data.prev?.groups[r.code]}</span>}
                              </td>
                              {cells(r.cur, r.prev)}
                            </tr>
                            {open && custs.map(([no, x]) => {
                              const key = `${r.code}|${no}`;
                              const co = openC.has(key);
                              return (
                                <Fragment key={key}>
                                  <tr className="border-t border-gray-100 bg-gray-50/60 cursor-pointer hover:bg-gray-100" onClick={() => toggle(setOpenC, key)}>
                                    <td className="py-1.5 px-2 pl-8 whitespace-nowrap max-w-[320px] truncate">
                                      <span className="inline-flex items-center gap-1 text-gray-800">{co ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span className="font-mono text-xs text-gray-500">{no}</span> {data.cur.customers[no] || data.prev?.customers[no] || ''}</span>
                                    </td>
                                    {cells(x.cur, x.prev)}
                                  </tr>
                                  {co && x.docs.map(d => {
                                    const lo = openDocs.has(d.no);
                                    const ls = docLines[d.no];
                                    return (
                                      <Fragment key={d.no}>
                                        <tr className="border-t border-gray-100 bg-white cursor-pointer hover:bg-gray-50" onClick={() => toggleDoc(d.no)}>
                                          <td className="py-1 px-2 pl-14 whitespace-nowrap text-xs">
                                            <span className="inline-flex items-center gap-1">{lo ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span className="font-mono text-gray-900">{d.no}</span></span>
                                            <span className="text-gray-500"> · {fmt.date(d.date)}{d.credit ? ' · abono' : ''}</span>
                                          </td>
                                          {cells({ ...d, inv: d.credit ? 0 : d.sales, cr: d.credit ? d.sales : 0, n: 1 }, null, true)}
                                        </tr>
                                        {lo && (
                                          <tr className="bg-gray-50/70">
                                            <td colSpan={99} className="pl-20 pr-2 py-2">
                                              {!ls ? <span className="text-xs text-gray-500">Cargando líneas…</span>
                                                : 'error' in ls ? <span className="text-xs text-red-600">{ls.error}</span>
                                                : !ls.lines.length ? <span className="text-xs text-gray-500">Sin líneas</span>
                                                : (
                                                  <table className="text-xs bg-white border border-gray-200 rounded">
                                                    <thead className="text-[10px] uppercase tracking-wider text-gray-500 bg-gray-50">
                                                      <tr>
                                                        <th className="px-2 py-1 text-left">Artículo</th>
                                                        <th className="px-2 py-1 text-left">Descripción</th>
                                                        <th className="px-2 py-1 text-right">Cantidad</th>
                                                        <th className="px-2 py-1 text-right">Precio unit.</th>
                                                        <th className="px-2 py-1 text-right">Dto. %</th>
                                                        <th className="px-2 py-1 text-right">Importe</th>
                                                        <th className="px-2 py-1 text-right">Coste unit.</th>
                                                        <th className="px-2 py-1 text-right">Coste</th>
                                                        <th className="px-2 py-1 text-right">Margen bruto %</th>
                                                      </tr>
                                                    </thead>
                                                    <tbody>
                                                      {ls.lines.map((l, i) => {
                                                        const gm = l.amount ? ((l.amount - l.cost) / l.amount) * 100 : null;
                                                        return (
                                                          <tr key={i} className="border-t border-gray-100">
                                                            <td className="px-2 py-1 font-mono whitespace-nowrap">{l.no}{l.component && <span className="ml-1 text-[10px] text-gray-400 font-sans">comp.</span>}</td>
                                                            <td className="px-2 py-1 max-w-[340px] truncate" title={l.description}>{l.description}</td>
                                                            <td className="px-2 py-1 text-right tabular-nums">{num(l.qty)}</td>
                                                            <td className="px-2 py-1 text-right tabular-nums" title={l.listPrice ? `Precio de tarifa ${eur(l.listPrice, 4)}` : undefined}>{eur(l.unitPrice, 4)}</td>
                                                            <td className="px-2 py-1 text-right tabular-nums">{l.discount ? num(l.discount, 2) : ''}</td>
                                                            <td className="px-2 py-1 text-right tabular-nums">{eur(l.amount, 2)}</td>
                                                            <td className="px-2 py-1 text-right tabular-nums">{eur(l.unitCost, 4)}</td>
                                                            <td className="px-2 py-1 text-right tabular-nums">{eur(l.cost, 2)}</td>
                                                            <td className={`px-2 py-1 text-right tabular-nums ${gm !== null && gm < 0 ? 'text-[#C0392B] font-semibold' : ''}`}>{gm === null ? '–' : pct(gm, 1)}</td>
                                                          </tr>
                                                        );
                                                      })}
                                                    </tbody>
                                                  </table>
                                                )}
                                            </td>
                                          </tr>
                                        )}
                                      </Fragment>
                                    );
                                  })}
                                </Fragment>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                      <tr className="border-t-2 border-gray-900 font-semibold">
                        <td className="py-2 px-2">Total</td>
                        {cells(view.total.cur, view.total.prev)}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-gray-500">
                  Margen = venta neta − coste del producto − logística − Skonto − Conditions out of invoice − Bonus − Marketing fee − Accounting Partner (Markant).
                  Las condiciones son las que BC calcula en cada línea con los % de Conditions del grupo; la logística, el Total Charges de cada factura (Logistic Cost).
                </p>
              </Section>
            </>
          )}
      </main>
    </div>
  );
}
