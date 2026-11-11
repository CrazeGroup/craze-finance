'use client';

import React, { Fragment, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { companyLabel, useCompany } from '@/contexts/CompanyContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { makeT } from '../reporting/i18n';
import { Card, ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';
import InventoryBreakdown, { Analysis, Delta, Dim, InvAttrs } from '../reporting/InventoryBreakdown';

// Amazon: margen de cada cliente Amazon (venta − coste − logística − Amazon Ads − deducciones Amazon), del 1 de enero a hoy, comparado con
// el mismo periodo del año anterior. Datos de /api/amazon (src/lib/amazonMargin.ts).

type Customer = { no: string; name: string; country: string };
type Year = {
  year: number; from: string; to: string; computedAt: string;
  customers: Customer[]; items: InvAttrs[]; rawDesc: Record<string, string>;
  docs: [string, number, string, number, string][];
  lines: number[][];                      // [doc, artículo, cantidad, venta, coste, logística, ads, deducciones]
  ads: { country: string; month: string; amount: number; assigned: number }[];
  ded?: { country: string; month: string; amount: number; assigned: number }[];
  logistic: { assigned: number; unassigned: number; unassignedRows: number };
};
type Data = { cur: Year; prev: Year | null };

const FIRST_YEAR = 2025;
const DIMS: Dim[] = ['bu', 'line', 'range', 'cat', 'pmc', 'license', 'royalty'];
const TABLE_KEY = 'amazon:tabla-abierta';

type Agg = { s: number; c: number; l: number; a: number; d: number };
const zero = (): Agg => ({ s: 0, c: 0, l: 0, a: 0, d: 0 });
const addTo = (g: Agg, l: number[]) => { g.s += l[3]; g.c += l[4]; g.l += l[5]; g.a += l[6]; g.d += l[7] || 0; };
const margin = (g: Agg) => g.s - g.c - g.l - g.a - g.d;
const lineMargin = (l: number[]) => l[3] - l[4] - l[5] - l[6] - (l[7] || 0);
const sameDay = (iso: string, year: number) => `${year}${iso.substring(4, 10)}`;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

export default function AmazonPage() {
  const { selectedCompany } = useCompany();
  const { lang } = useLanguage();
  const fmt = useMemo(() => makeT(lang), [lang]);
  const { eur, pct } = fmt;
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [tableOpen, setTableOpen] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => { if (store.get(TABLE_KEY) === '0') setTableOpen(false); }, []);
  const toggleTable = () => setTableOpen(v => { store.set(TABLE_KEY, v ? '0' : '1'); return !v; });
  const toggle = (k: string) => setOpen(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  useEffect(() => {
    if (selectedCompany === 'ALL') return;
    let cancelled = false;
    setState(s => ({ data: s.data?.cur.year === year ? s.data : null, loading: true, error: null }));
    fetch(`/api/amazon?year=${year}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json();
        if (cancelled) return;
        setState(res.ok && !data.error ? { data, loading: false, error: null } : { data: null, loading: false, error: data.error || `HTTP ${res.status}` });
      })
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [year, reload, selectedCompany]);

  const data = state.data;
  const view = useMemo(() => (data ? build(data) : null), [data]);
  const years = Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => thisYear - i);
  const company = selectedCompany === 'ALL' ? 'CRAZE' : selectedCompany;
  const td = 'py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap';
  const pctOf = (g: Agg) => (g.s > 0 ? pct((margin(g) / g.s) * 100) : '–');

  const cells = (g: Agg, ly?: Agg | null) => (
    <>
      <td className={td}>{eur(g.s)}</td>
      <td className={td}>{eur(g.c)}</td>
      <td className={td}>{eur(g.l)}</td>
      <td className={td}>{eur(g.a)}</td>
      <td className={td}>{eur(g.d)}</td>
      <td className={`${td} font-semibold ${margin(g) < 0 ? 'text-[#C0392B]' : ''}`}>{eur(margin(g))}</td>
      <td className={td}>{pctOf(g)}</td>
      <td className={`${td} text-gray-500`}>{ly ? eur(ly.s) : ''}</td>
      <td className={`${td} text-gray-500`}>{ly ? eur(margin(ly)) : ''}</td>
      <td className={td}>{ly ? <Delta fmt={fmt} cur={margin(g)} prev={margin(ly)} /> : ''}</td>
    </>
  );

  return (
    <div className="rpt-root min-h-screen bg-[#F3F4F7] pb-24">
      <header className="rpt-header sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-4 mr-auto">
            <Image src="/logo.png" alt="Craze Group" width={104} height={50} className="object-contain" />
            <div>
              <p className="font-bold text-gray-900 leading-tight">Amazon · margen por cliente</p>
              <p className="text-xs text-gray-500">
                {data ? `${fmt.date(data.cur.from)} – ${fmt.date(data.cur.to)}` : '…'} · {companyLabel(company)}
                {data && <> · calculado {new Date(data.cur.computedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 hidden sm:inline">Año</span>
            <select value={year} onChange={e => setYear(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold bg-white">
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
        {selectedCompany === 'ALL' ? <p className="text-sm text-gray-600">Selecciona una empresa concreta en el menú lateral.</p>
          : state.error ? <ErrorBox message={state.error} />
          : !data || !view ? <Loading text="Calculando el margen de Amazon (la primera vez puede tardar un par de minutos)…" />
          : (
            <>
              <Section title={`Amazon ${data.cur.year}`} source={`Facturas y abonos de venta registrados · logística (Logistic Costs) · Amazon Ads (AA-00015) y deducciones Amazon EU por país${data.prev ? ` · vs mismo periodo ${data.prev.year}` : ''}`}>
                <Grid cols={3}>
                  {([['Ventas', 's'], ['Product cost', 'c'], ['Coste logístico', 'l'], ['Amazon Ads', 'a'], ['Deducciones Amazon', 'd']] as const).map(([label, k]) => (
                    <Kpi key={k} label={label} value={eur(view.total[k])}
                      sub={view.totalLy && k !== 'a' && k !== 'd' ? `${data.prev!.year}: ${eur(view.totalLy[k])}${k !== 's' && view.total.s ? ` · ${pct((view.total[k] / view.total.s) * 100)} s/ventas` : ''}` : k !== 's' && view.total.s ? `${pct((view.total[k] / view.total.s) * 100)} s/ventas` : undefined}
                      extra={view.totalLy && k !== 'a' && k !== 'd' ? <span className="text-xs font-semibold"><Delta fmt={fmt} cur={view.total[k]} prev={view.totalLy[k]} invert={k !== 's'} /></span> : undefined} />
                  ))}
                  <Kpi label="Margen" value={eur(margin(view.total))} tone={margin(view.total) < 0 ? 'red' : 'main'} highlight
                    sub={`${pctOf(view.total)} s/ventas${view.totalLy ? ` · ${data.prev!.year}: ${eur(margin(view.totalLy))} (${pctOf(view.totalLy)})${view.prevEst.some(e => e.months.length) ? `, ${view.prevEst.filter(e => e.months.length).map(e => KIND_NAME[e.kind]).join(' y ')} estimados` : ''}` : ''}`}
                    extra={view.totalLy ? <span className="text-xs font-semibold"><Delta fmt={fmt} cur={margin(view.total)} prev={margin(view.totalLy)} /></span> : undefined} />
                </Grid>
                <InventoryBreakdown fmt={fmt} an={view.analysis} kind="flow" opts={{
                  title: 'Margen Amazon por mes', dims: DIMS, sameDayLy: true,
                  note: 'Margen = venta − Product cost (cantidad × Unit Cost de la línea) − coste logístico − Amazon Ads − deducciones Amazon. El acumulado del año anterior llega hasta el mismo día; en el gráfico sus meses son completos.' + estNote(view.prevEst) + estNote(view.curEst),
                }} />
              </Section>

              <section className="rpt-section space-y-3">
                <button onClick={toggleTable} className="flex w-full items-center gap-2 border-b-2 border-gray-900 pb-2 text-left">
                  {tableOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                  <h2 className="text-[22px] font-bold text-gray-900 tracking-tight">Detalle por cliente Amazon</h2>
                  <span className="text-xs text-gray-500">cliente → mes → factura → líneas{data.prev ? ` · comparado con ${data.prev.year} hasta el ${fmt.shortDate(data.cur.to)}` : ''}</span>
                </button>
                {tableOpen && (
                  <Card>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-gray-200 text-[10px] font-semibold uppercase tracking-wider text-gray-500 font-mono">
                            <th className="py-2 px-2 text-left">Cliente / mes / documento</th>
                            <th className="py-2 px-2 text-left">País</th>
                            <th className="py-2 px-2 text-right">Ventas</th>
                            <th className="py-2 px-2 text-right">Product cost</th>
                            <th className="py-2 px-2 text-right">Logística</th>
                            <th className="py-2 px-2 text-right">Ads</th>
                            <th className="py-2 px-2 text-right">Deducciones</th>
                            <th className="py-2 px-2 text-right">Margen</th>
                            <th className="py-2 px-2 text-right">% margen</th>
                            <th className="py-2 px-2 text-right">{data.prev ? `Ventas ${data.prev.year}` : ''}</th>
                            <th className="py-2 px-2 text-right">{data.prev ? `Margen ${data.prev.year}` : ''}</th>
                            <th className="py-2 px-2 text-right">{data.prev ? 'Δ margen' : ''}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {view.customers.map(c => {
                            const ck = `c:${c.no}`;
                            return (
                              <Fragment key={ck}>
                                <tr onClick={() => toggle(ck)} className="border-b border-gray-100 cursor-pointer hover:bg-gray-50 font-semibold">
                                  <td className="py-1.5 px-2"><span className="inline-flex items-center gap-1">{open.has(ck) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{c.no} · {c.name}</span></td>
                                  <td className="py-1.5 px-2">{c.country}</td>
                                  {cells(c.agg, data.prev ? c.ly : null)}
                                </tr>
                                {open.has(ck) && c.months.map(m => {
                                  const mk = `${ck}:${m.month}`;
                                  return (
                                    <Fragment key={mk}>
                                      <tr onClick={() => toggle(mk)} className="border-b border-gray-100 cursor-pointer hover:bg-gray-50 bg-gray-50/60">
                                        <td className="py-1.5 px-2 pl-8"><span className="inline-flex items-center gap-1">{open.has(mk) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{fmt.monthName(m.month)}</span></td>
                                        <td />
                                        {cells(m.agg, data.prev ? m.ly : null)}
                                      </tr>
                                      {open.has(mk) && m.docs.map(d => {
                                        const dk = `${mk}:${d.no}`;
                                        return (
                                          <Fragment key={dk}>
                                            <tr onClick={() => toggle(dk)} className="border-b border-gray-100 cursor-pointer hover:bg-gray-50 text-gray-700">
                                              <td className="py-1.5 px-2 pl-14">
                                                <span className="inline-flex items-center gap-1">{open.has(dk) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                  {d.no} <span className="text-gray-400">· {fmt.date(d.date)}{d.credit ? ' · abono' : ''}{d.order ? ` · ${d.order}` : ''}</span></span>
                                              </td>
                                              <td />
                                              {cells(d.agg)}
                                            </tr>
                                            {open.has(dk) && d.lines.map((l, i) => {
                                              const it = data.cur.items[l[1]];
                                              const g = zero(); addTo(g, l);
                                              return (
                                                <tr key={`${dk}:${i}`} className="border-b border-gray-100 text-gray-500 text-[12px]">
                                                  <td className="py-1 px-2 pl-20">{it.no} {it.desc} <span className="text-gray-400">· {fmt.num(l[2])} uds</span></td>
                                                  <td />
                                                  {cells(g)}
                                                </tr>
                                              );
                                            })}
                                          </Fragment>
                                        );
                                      })}
                                    </Fragment>
                                  );
                                })}
                              </Fragment>
                            );
                          })}
                          {view.open.map(a => (
                            <tr key={`${a.kind}:${a.country}`} className="border-b border-gray-100 text-[#B7791F]">
                              <td className="py-1.5 px-2">{a.kind === 'a' ? 'Amazon Ads' : 'Deducciones Amazon'} sin ventas a clientes Amazon del país ({a.months.join(', ')})</td>
                              <td className="py-1.5 px-2">{a.country || '(sin país)'}</td>
                              {cells({ ...zero(), [a.kind]: a.amount })}
                            </tr>
                          ))}
                          <tr className="border-t border-gray-300 font-semibold">
                            <td className="py-2 px-2">Total</td>
                            <td />
                            {cells(view.grand, data.prev ? view.totalLy : null)}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-3 space-y-1 text-[11px] text-gray-500">
                      <p>Cliente = Sell-to de la factura (clientes cuyo nombre contiene «Amazon», sin «FBA Regularization»); importes en divisa local, sin IVA. Product cost = cantidad × Unit Cost (LCY) de la línea.</p>
                      <p>Logística = Total Charges de Logistic Costs: su Order No. (nº de Warehouse Shipment) → envío registrado → pedido de venta → primera factura del pedido desde la fecha del envío, repartido entre sus líneas por importe.
                        {data.cur.logistic.unassigned ? ` Envíos a Amazon aún sin factura (o sin enlace): ${eur(data.cur.logistic.unassigned)} en ${data.cur.logistic.unassignedRows} envíos, no incluidos.` : ''}</p>
                      <p>Amazon Ads = artículo AA-00015 en facturas/abonos de compra de proveedores Amazon, por país del proveedor (Polonia con Alemania) y mes, repartido entre los clientes Amazon de ese país en proporción a la venta del mes.{estNote(view.prevEst)}{estNote(view.curEst)}</p>
                      <p>Deducciones Amazon = líneas sin IVA de las facturas/abonos de compra de los proveedores «Amazon EU …» (acuerdos, co-op, damage allowance, rebates, chargebacks, Amazon Promotions…), sin Ads (AA-00015) ni gastos «OPERATING»; por país del proveedor y mes, repartidas como los Ads.</p>
                    </div>
                  </Card>
                )}
              </section>
            </>
          )}
      </main>
    </div>
  );
}

// Meses sin facturas de Ads / deducciones (2025 antes de que se subieran, desde 10/2025): importe estimado = venta × % de
// Ads (o deducciones) sobre la venta del país en los meses que sí tienen facturas (de este año y del otro cargado).
// Primer mes con facturas = el primero con al menos el 5 % del importe medio mensual (sueltos de pocos euros no cuentan);
// los meses anteriores se estiman (sustituyen lo poco que tengan).
type Kind = 'a' | 'd';
const KIND_COL: Record<Kind, number> = { a: 6, d: 7 };
const KIND_NAME: Record<Kind, string> = { a: 'Ads', d: 'deducciones' };
type Est = { year: number; kind: Kind; first: string; months: string[]; rates: Record<string, number> };
const listOf = (y: Year, kind: Kind) => (kind === 'a' ? y.ads : y.ded || []);
function firstMonth(y: Year, kind: Kind) {
  const by: Record<string, number> = {};
  for (const a of listOf(y, kind)) by[a.month] = (by[a.month] || 0) + a.amount;
  const vals = Object.values(by).filter(v => Math.abs(v) > 0.5);
  if (!vals.length) return '';
  const avg = vals.reduce((t, v) => t + Math.abs(v), 0) / vals.length;
  return Object.keys(by).sort().find(m => Math.abs(by[m]) >= 0.05 * avg) || '';
}
function estimate(y: Year, lines: number[][], refs: Year[], kind: Kind): { lines: number[][]; est: Est } {
  const col = KIND_COL[kind];
  const first = firstMonth(y, kind);
  const est: Est = { year: y.year, kind, first, months: [], rates: {} };
  if (!first || first <= `${y.year}-01`) return { lines, est };
  const sales: Record<string, number> = {}, amt: Record<string, number> = {};
  for (const r of refs) {
    const rFirst = firstMonth(r, kind);
    const withData = new Set(listOf(r, kind).filter(a => a.assigned && a.month >= rFirst).map(a => `${a.country}|${a.month}`));
    for (const l of r.lines) {
      const d = r.docs[l[0]];
      const country = r.customers[d[3]].country;
      if (!withData.has(`${country}|${d[2].substring(0, 7)}`)) continue;
      sales[country] = (sales[country] || 0) + l[3];
      amt[country] = (amt[country] || 0) + (l[col] || 0);
    }
  }
  for (const c of Object.keys(sales)) if (sales[c] > 0 && amt[c]) est.rates[c] = amt[c] / sales[c];
  const months = new Set<string>();
  const out = lines.map(l => {
    const d = y.docs[l[0]];
    const month = d[2].substring(0, 7);
    if (month >= first) return l;
    months.add(month);
    const e = [...l];
    while (e.length <= col) e.push(0);
    e[col] = l[3] * (est.rates[y.customers[d[3]].country] || 0);
    return e;
  });
  est.months = Array.from(months).sort();
  return { lines: out, est };
}
function estimateAll(y: Year, refs: Year[]) {
  const a = estimate(y, y.lines, refs, 'a');
  const d = estimate(y, a.lines, refs, 'd');
  return { lines: d.lines, ests: [a.est, d.est] };
}
const estNote = (ests: Est[]) => ests.filter(e => e.months.length).map(e =>
  ` ${KIND_NAME[e.kind].charAt(0).toUpperCase() + KIND_NAME[e.kind].slice(1)} de ${e.year} estimados en ${e.months.map(m => `${m.substring(5, 7)}/${m.substring(2, 4)}`).join(', ')} (sin facturas subidas): venta × % de ${KIND_NAME[e.kind]} del país en los meses con facturas (${Object.entries(e.rates).map(([c, r]) => `${c} ${(r * 100).toFixed(1).replace('.', ',')} %`).join(', ')}).`).join('');

// Agrega los datos: totales, clientes → meses → documentos y las filas del gráfico (formato de Análisis Inventario)
function build({ cur, prev }: Data) {
  const curE = estimateAll(cur, prev ? [cur, prev] : [cur]);
  const prevE = prev ? estimateAll(prev, [prev, cur]) : null;
  const lyTo = prev ? sameDay(cur.to, prev.year) : '';
  // Artículos de los dos años en una lista
  const items: InvAttrs[] = [];
  const itemIdx = new Map<string, number>();
  const mapItems = (y: Year) => y.items.map(it => {
    let i = itemIdx.get(it.no);
    if (i === undefined) { i = items.length; itemIdx.set(it.no, i); items.push(it); }
    return i;
  });
  const curItems = mapItems(cur);
  const prevItems = prev ? mapItems(prev) : [];
  const custKeys: string[] = [];
  const custIdx = new Map<string, number>();
  const ci = (no: string) => { let i = custIdx.get(no); if (i === undefined) { i = custKeys.length; custIdx.set(no, i); custKeys.push(no); } return i; };

  const nPrev = prev ? 12 : 0;
  const curMonths = Number(cur.to.substring(5, 7));
  const prevDates = Array.from({ length: nPrev }, (_, i) => `${cur.year - 1}-${String(i + 1).padStart(2, '0')}-01`);
  const curDates = Array.from({ length: curMonths }, (_, i) => `${cur.year}-${String(i + 1).padStart(2, '0')}-01`);
  const rows: number[][] = [];

  // Año en curso: clientes → meses → documentos
  type DocV = { no: string; date: string; credit: boolean; order: string; agg: Agg; lines: number[][] };
  type MonthV = { month: string; agg: Agg; ly: Agg; docs: Map<string, DocV> };
  type CustV = { no: string; name: string; country: string; agg: Agg; ly: Agg; months: Map<string, MonthV> };
  const custs = new Map<string, CustV>();
  const cust = (c: Customer) => {
    let v = custs.get(c.no);
    if (!v) { v = { no: c.no, name: c.name, country: c.country, agg: zero(), ly: zero(), months: new Map() }; custs.set(c.no, v); }
    return v;
  };
  const monthOf = (v: CustV, month: string) => {
    let m = v.months.get(month);
    if (!m) { m = { month, agg: zero(), ly: zero(), docs: new Map() }; v.months.set(month, m); }
    return m;
  };
  const total = zero();
  for (const l of curE.lines) {
    const d = cur.docs[l[0]];
    const c = cust(cur.customers[d[3]]);
    const m = monthOf(c, d[2].substring(0, 7));
    let doc = m.docs.get(d[0]);
    if (!doc) { doc = { no: d[0], date: d[2], credit: d[1] === 1, order: d[4], agg: zero(), lines: [] }; m.docs.set(d[0], doc); }
    addTo(c.agg, l); addTo(m.agg, l); addTo(doc.agg, l); addTo(total, l);
    doc.lines.push(l);
    rows.push([nPrev + Number(d[2].substring(5, 7)) - 1, curItems[l[1]], ci(c.no), lineMargin(l), l[2]]);
  }
  // Año anterior: mismo periodo por cliente, mes completo por mes (el mes en curso hasta el mismo día) y el gráfico
  let totalLy: Agg | null = null;
  if (prev) {
    totalLy = zero();
    for (const l of prevE!.lines) {
      const d = prev.docs[l[0]];
      const c = cust(prev.customers[d[3]]);
      const month = `${cur.year}${d[2].substring(4, 7)}`;
      rows.push([Number(d[2].substring(5, 7)) - 1, prevItems[l[1]], ci(c.no), lineMargin(l), l[2], d[2] <= lyTo ? 1 : 0]);
      if (d[2] > lyTo) continue;
      addTo(c.ly, l); addTo(totalLy, l);
      if (month <= cur.to.substring(0, 7)) addTo(monthOf(c, month).ly, l);
    }
    // Lo que no tiene ventas en su país (sin asignar), en los meses con facturas (los anteriores van estimados)
    for (const e of prevE!.ests) for (const a of listOf(prev, e.kind)) {
      if (!a.assigned && a.month <= lyTo.substring(0, 7) && a.month >= e.first) totalLy[e.kind] += a.amount;
    }
  }
  // Ads y deducciones sin clientes en su país y mes: se suman al total (margen) pero aparte de los clientes
  const openBy = new Map<string, { kind: 'a' | 'd'; country: string; amount: number; months: string[] }>();
  for (const [kind, list] of [['a', cur.ads], ['d', cur.ded || []]] as const) {
    for (const a of list) {
      const first = curE.ests.find(e => e.kind === kind)?.first || '';
      if (a.assigned || !a.amount || a.month < first) continue;
      const k = `${kind}|${a.country}`;
      const g = openBy.get(k) || { kind, country: a.country, amount: 0, months: [] };
      g.amount += a.amount; g.months.push(a.month.substring(5, 7) + '/' + a.month.substring(2, 4));
      openBy.set(k, g);
    }
  }
  const open = Array.from(openBy.values());
  const grand = { ...total };
  for (const o of open) grand[o.kind] += o.amount;

  const customers = Array.from(custs.values())
    .filter(c => c.agg.s || c.agg.c || c.ly.s || c.ly.c)
    .sort((a, b) => b.agg.s - a.agg.s || b.ly.s - a.ly.s)
    .map(c => ({
      ...c,
      months: Array.from(c.months.values()).filter(m => m.agg.s || m.agg.c || m.ly.s).sort((a, b) => a.month.localeCompare(b.month))
        .map(m => ({ ...m, docs: Array.from(m.docs.values()).sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no)) })),
    }));

  const analysis: Analysis = {
    year: cur.year, month: cur.to.substring(0, 7), dates: [...prevDates, ...curDates], curDates, prevDates,
    totals: [], items, locs: custKeys, rows, rawDesc: { ...(prev?.rawDesc || {}), ...cur.rawDesc },
  };
  return { prevEst: prevE?.ests ?? [], curEst: curE.ests, total: grand, totalLy, grand, customers, open, analysis };
}
