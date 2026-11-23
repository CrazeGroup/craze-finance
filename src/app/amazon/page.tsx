'use client';

import React, { Fragment, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { companyLabel, useCompany } from '@/contexts/CompanyContext';
import { useLanguage, useT } from '@/contexts/LanguageContext';
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
  lines: number[][];                      // [doc, artículo, cantidad, venta, coste, logística, ads, deducciones, agencia]
  ads: { country: string; month: string; amount: number; assigned: number }[];
  ded?: { country: string; month: string; amount: number; assigned: number }[];
  agency?: { country: string; month: string; amount: number; assigned: number }[];
  logistic: { assigned: number; unassigned: number; unassignedRows: number };
};
type Data = { cur: Year; prev: Year | null };

const FIRST_YEAR = 2025;
const DIMS: Dim[] = ['bu', 'line', 'range', 'cat', 'pmc', 'license', 'royalty'];
const TABLE_KEY = 'amazon:tabla-abierta';

// g = agencia (B2MARKETPLACE, facturas de la agencia que gestiona Amazon DE)
type Agg = { s: number; c: number; l: number; a: number; d: number; g: number };
const zero = (): Agg => ({ s: 0, c: 0, l: 0, a: 0, d: 0, g: 0 });
const addTo = (g: Agg, l: number[]) => { g.s += l[3]; g.c += l[4]; g.l += l[5]; g.a += l[6]; g.d += l[7] || 0; g.g += l[8] || 0; };
const margin = (g: Agg) => g.s - g.c - g.l - g.a - g.d - g.g;
const lineMargin = (l: number[]) => l[3] - l[4] - l[5] - l[6] - (l[7] || 0) - (l[8] || 0);
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
  const { t, tx, locale } = useT();
  const estNote = (ests: Est[]) => estNoteText(ests, t, locale);
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
      <td className={td}>{eur(g.g)}</td>
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
              <p className="font-bold text-gray-900 leading-tight">{t('Amazon · margin by customer')}</p>
              <p className="text-xs text-gray-500">
                {data ? `${fmt.date(data.cur.from)} – ${fmt.date(data.cur.to)}` : '…'} · {companyLabel(company)}
                {data && <> · {t('calculated {date}', { date: new Date(data.cur.computedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) })}</>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 hidden sm:inline">{t('Year')}</span>
            <select value={year} onChange={e => setYear(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold bg-white">
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={state.loading} title={t('Recalculate from BC')}
              className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
              <RefreshCw size={16} className={state.loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-6 space-y-8">
        {selectedCompany === 'ALL' ? <p className="text-sm text-gray-600">{t('Select a specific company in the side menu.')}</p>
          : state.error ? <ErrorBox message={tx(state.error)} />
          : !data || !view ? <Loading text={t('Calculating the Amazon margin (the first time it can take a couple of minutes)…')} />
          : (
            <>
              <Section title={`Amazon ${data.cur.year}`} source={`${t('Posted sales invoices and credit memos · logistics (Logistic Costs) · Amazon Ads (AA-00015) and Amazon EU deductions by country')}${data.prev ? ` · ${t('vs same period {year}', { year: data.prev.year })}` : ''}`}>
                <Grid cols={3}>
                  {([['Sales', 's'], ['Product cost', 'c'], ['Logistics cost', 'l'], ['Amazon Ads', 'a'], ['Amazon deductions', 'd'], ['Agency', 'g']] as const).map(([label, k]) => (
                    <Kpi key={k} label={k === 'c' ? label : t(label)} value={eur(view.total[k])}
                      sub={view.totalLy && k !== 'a' && k !== 'd' ? `${data.prev!.year}: ${eur(view.totalLy[k])}${k !== 's' && view.total.s ? ` · ${t('{pct} of sales', { pct: pct((view.total[k] / view.total.s) * 100) })}` : ''}` : k !== 's' && view.total.s ? t('{pct} of sales', { pct: pct((view.total[k] / view.total.s) * 100) }) : undefined}
                      extra={view.totalLy && k !== 'a' && k !== 'd' ? <span className="text-xs font-semibold"><Delta fmt={fmt} cur={view.total[k]} prev={view.totalLy[k]} invert={k !== 's'} /></span> : undefined} />
                  ))}
                  <Kpi label={t('Margin')} value={eur(margin(view.total))} tone={margin(view.total) < 0 ? 'red' : 'main'} highlight
                    sub={`${t('{pct} of sales', { pct: pctOf(view.total) })}${view.totalLy ? ` · ${data.prev!.year}: ${eur(margin(view.totalLy))} (${pctOf(view.totalLy)})${view.prevEst.some(e => e.months.length) ? `, ${t('{list} estimated', { list: view.prevEst.filter(e => e.months.length).map(e => t(KIND_NAME[e.kind])).join(` ${t('and')} `) })}` : ''}` : ''}`}
                    extra={view.totalLy ? <span className="text-xs font-semibold"><Delta fmt={fmt} cur={margin(view.total)} prev={margin(view.totalLy)} /></span> : undefined} />
                </Grid>
                <InventoryBreakdown fmt={fmt} an={view.analysis} kind="flow" opts={{
                  title: t('Amazon margin by month'), dims: DIMS, sameDayLy: true,
                  note: t("Margin = sales − Product cost (quantity × the line's Unit Cost) − logistics cost − Amazon Ads − Amazon deductions − agency. The previous year's cumulative goes up to the same day; in the chart its months are complete.") + estNote(view.prevEst) + estNote(view.curEst),
                }} />
              </Section>

              <section className="rpt-section space-y-3">
                <button onClick={toggleTable} className="flex w-full items-center gap-2 border-b-2 border-gray-900 pb-2 text-left">
                  {tableOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                  <h2 className="text-[22px] font-bold text-gray-900 tracking-tight">{t('Detail by Amazon customer')}</h2>
                  <span className="text-xs text-gray-500">{t('customer → month → invoice → lines')}{data.prev ? ` · ${t('compared with {year} up to {date}', { year: data.prev.year, date: fmt.shortDate(data.cur.to) })}` : ''}</span>
                </button>
                {tableOpen && (
                  <Card>
                    <div className="table-scroll">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-gray-200 text-[10px] font-semibold uppercase tracking-wider text-gray-500 font-mono">
                            <th className="py-2 px-2 text-left">{t('Customer / month / document')}</th>
                            <th className="py-2 px-2 text-left">{t('Country')}</th>
                            <th className="py-2 px-2 text-right">{t('Sales')}</th>
                            <th className="py-2 px-2 text-right">Product cost</th>
                            <th className="py-2 px-2 text-right">{t('Logistics')}</th>
                            <th className="py-2 px-2 text-right">Ads</th>
                            <th className="py-2 px-2 text-right">{t('Deductions')}</th>
                            <th className="py-2 px-2 text-right">{t('Agency')}</th>
                            <th className="py-2 px-2 text-right">{t('Margin')}</th>
                            <th className="py-2 px-2 text-right">{t('% margin')}</th>
                            <th className="py-2 px-2 text-right">{data.prev ? t('Sales {year}', { year: data.prev.year }) : ''}</th>
                            <th className="py-2 px-2 text-right">{data.prev ? t('Margin {year}', { year: data.prev.year }) : ''}</th>
                            <th className="py-2 px-2 text-right">{data.prev ? t('Δ margin') : ''}</th>
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
                                                  {d.no} <span className="text-gray-400">· {fmt.date(d.date)}{d.credit ? ` · ${t('credit memo')}` : ''}{d.order ? ` · ${d.order}` : ''}</span></span>
                                              </td>
                                              <td />
                                              {cells(d.agg)}
                                            </tr>
                                            {open.has(dk) && d.lines.map((l, i) => {
                                              const it = data.cur.items[l[1]];
                                              const g = zero(); addTo(g, l);
                                              return (
                                                <tr key={`${dk}:${i}`} className="border-b border-gray-100 text-gray-500 text-[12px]">
                                                  <td className="py-1 px-2 pl-20">{it.no} {it.desc} <span className="text-gray-400">· {t('{n} units', { n: fmt.num(l[2]) })}</span></td>
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
                              <td className="py-1.5 px-2">{t('{kind} with no sales to Amazon customers in the country ({months})', { kind: a.kind === 'a' ? 'Amazon Ads' : a.kind === 'g' ? t('Agency') : t('Amazon deductions'), months: a.months.join(', ') })}</td>
                              <td className="py-1.5 px-2">{a.country || t('(no country)')}</td>
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
                      <p>{t("Customer = the invoice's Sell-to (customers whose name contains «Amazon», excluding «FBA Regularization»); amounts in local currency, excluding VAT. Product cost = quantity × the line's Unit Cost (LCY).")}</p>
                      <p>{t("Logistics = Total Charges from Logistic Costs: its Order No. (Warehouse Shipment no.) → posted shipment → sales order → the order's first invoice from the shipment date, spread over its lines by amount.")}
                        {data.cur.logistic.unassigned ? ` ${t('Shipments to Amazon not invoiced yet (or not linked): {amount} in {n} shipments, not included.', { amount: eur(data.cur.logistic.unassigned), n: data.cur.logistic.unassignedRows })}` : ''}</p>
                      <p>{t("Amazon Ads = item AA-00015 on purchase invoices/credit memos from Amazon vendors, by vendor country (Poland together with Germany) and month, spread over that country's Amazon customers in proportion to the month's sales.")}{estNote(view.prevEst)}{estNote(view.curEst)}</p>
                      <p>{t('Amazon deductions = lines excluding VAT of the purchase invoices/credit memos from «Amazon EU …» vendors (agreements, co-op, damage allowance, rebates, chargebacks, Amazon Promotions…), without Ads (AA-00015), «OPERATING» costs or UK Branch (there are no sales to Amazon UK); by vendor country and month, spread like the Ads. If a country has no sales that month (e.g. LU), they go to its sales of the year.')}</p>
                      <p>{t('Agency = lines excluding VAT of the purchase invoices/credit memos from the agency that manages Amazon (B2MARKETPLACE ECOMMERCE, vendor 7300559), charged to Amazon Germany: by month, spread over the Amazon DE sales in proportion to sales.')}</p>
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
const KIND_NAME: Record<Kind, string> = { a: 'Ads', d: 'deductions' };
const KIND_CAP: Record<Kind, string> = { a: 'Ads', d: 'Deductions' };
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
const estNoteText = (ests: Est[], t: (en: string, vars?: Record<string, string | number>) => string, locale: string) => {
  const nf1 = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return ests.filter(e => e.months.length).map(e =>
    ` ${t("{Kind} for {year} estimated in {months} (no invoices uploaded): sales × the country's {kind} % in the months with invoices ({rates}).", {
      Kind: t(KIND_CAP[e.kind]), kind: t(KIND_NAME[e.kind]), year: e.year,
      months: e.months.map(m => `${m.substring(5, 7)}/${m.substring(2, 4)}`).join(', '),
      rates: Object.entries(e.rates).map(([c, r]) => `${c} ${nf1.format(r * 100)} %`).join(', '),
    })}`).join('');
};

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
    for (const a of prev.agency || []) if (!a.assigned && a.month <= lyTo.substring(0, 7)) totalLy.g += a.amount;
  }
  // Ads y deducciones sin clientes en su país y mes: se suman al total (margen) pero aparte de los clientes
  const openBy = new Map<string, { kind: 'a' | 'd' | 'g'; country: string; amount: number; months: string[] }>();
  for (const [kind, list] of [['a', cur.ads], ['d', cur.ded || []], ['g', cur.agency || []]] as const) {
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
