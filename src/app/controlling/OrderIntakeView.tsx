'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';
import CompanySelect, { CONSOLIDATED, REPORT_COMPANIES, useReportCompany } from './CompanySelect';
import { ResizeTh, useColumnWidths } from './ResizableColumns';
import { useT } from '@/contexts/LanguageContext';

// Controlling · Facturación según Order Date: lo facturado cada mes (desglosable por antigüedad del pedido) y el Order
// Intake del mes = todos los Sales Orders creados ese mes (Order Date): lo ya facturado de esos pedidos (facturas de
// cualquier año cargado) + lo que sigue abierto, separado en Requested Delivery Date dentro del mes y posterior.
// Comparado con los mismos meses de los 2 años anteriores (solo facturas: histórico).
type Invoice = { kind: 'invoice' | 'credit'; no: string; postingDate: string; customerNo: string; customerName: string; amount: number; orderNo: string; orderDate: string | null };
type OpenOrder = { no: string; customerNo: string; customerName: string; orderDate: string; requestedDeliveryDate: string; amount: number; invoiced: number; pending: number; currency: string };
type YearData = { year: number; from: string; to: string; currency?: string; eurRate?: number; invoices: Invoice[]; openOrders: OpenOrder[]; intercompanyExcluded?: number; warnings: string[] };
type YearState = { year: number; data: YearData | null; error: string | null; loading: boolean };

const COMPARE_YEARS = 2;
const ALL_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 text-right';
const td = 'py-2 px-2 whitespace-nowrap tabular-nums text-right overflow-hidden text-ellipsis';

// Antigüedad del pedido respecto al mes de la factura (comparable entre años)
const BUCKETS = [
  { id: 'same', label: 'Order from the same month' },
  { id: 'm1', label: 'Order from the previous month' },
  { id: 'm2', label: 'Order from 2 months earlier' },
  { id: 'm3', label: 'Order from 3 or more months earlier' },
  { id: 'later', label: 'Order Date after the invoice' },
  { id: 'none', label: 'Invoice without order' },
  { id: 'unknown', label: 'Order not found (no Order Date)' },
  { id: 'credit', label: 'Credit memos (Posted Sales Credit Memos)' },
] as const;
type Bucket = typeof BUCKETS[number]['id'];
function bucketOf(i: Invoice): Bucket {
  if (i.kind === 'credit') return 'credit';
  if (!i.orderNo) return 'none';
  if (!i.orderDate) return 'unknown';
  const months = (Number(i.postingDate.substring(0, 4)) - Number(i.orderDate.substring(0, 4))) * 12
    + Number(i.postingDate.substring(5, 7)) - Number(i.orderDate.substring(5, 7));
  return months < 0 ? 'later' : months === 0 ? 'same' : months === 1 ? 'm1' : months === 2 ? 'm2' : 'm3';
}
const month = (date: string) => Number(date.substring(5, 7));

export default function OrderIntakeView({ fmt, company: globalCompany }: { fmt: Fmt; company: string }) {
  const { t, tx } = useT();
  const { num, date } = fmt;
  // Nombre del mes (Enero / January) y, dentro de una frase, en minúscula en castellano
  const monthInText = (m: number) => fmt.monthOnly(`2000-${String(m).padStart(2, '0')}`);
  const monthName = (m: number) => { const s = monthInText(m); return s.charAt(0).toUpperCase() + s.slice(1); };
  const [company, setCompany] = useReportCompany(globalCompany);
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [reload, setReload] = useState({ n: 0, force: false });
  const [years, setYears] = useState<YearState[]>([]);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  // Anchos de columna ajustables (por tipo de columna y antigüedad del año: o0 = año elegido)
  const { widths, setWidth, reset: resetWidths } = useColumnWidths('crz-order-intake-widths', {
    mes: 240, billed: 120, intake: 120, pct: 80, ya: 110, rdd: 105, rddPrev: 130, same: 115, next: 110,
  });
  const colW = (y: number, role: string) => widths[`o${year - y}:${role}`] ?? widths[role];

  const yearList = useMemo(() => Array.from({ length: COMPARE_YEARS + 1 }, (_, i) => year - COMPARE_YEARS + i), [year]);
  // Siempre el año completo; los meses futuros solo tienen Sales Orders abiertas
  const months = ALL_MONTHS;

  // Un año por petición (cada una lee BC por separado y no pasa del límite de 60 s)
  useEffect(() => {
    let cancelled = false;
    setYears(yearList.map(y => ({ year: y, data: null, error: null, loading: true })));
    // Una empresa o, en consolidado, todas sumadas en EUR (tipo de Currencies_Excel, como el BWA)
    const one = async (co: string, y: number): Promise<YearData> => {
      // Las Sales Orders abiertas (de hoy) se piden con el año elegido y sirven para todos los años
      const params = `company=${encodeURIComponent(co)}&year=${y}&from=1&to=12${y === year ? '&open=1' : ''}${reload.force ? '&force=1' : ''}`;
      const res = await fetch(`/api/controlling/order-intake?${params}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok || data.error) throw new Error(`${co}: ${data.error || `HTTP ${res.status}`}`);
      return data;
    };
    yearList.forEach(y => {
      const load = company === CONSOLIDATED
        ? Promise.allSettled(REPORT_COMPANIES.map(co => one(co, y))).then(settled => {
          const parts = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
          const failed = settled.flatMap(r => (r.status === 'rejected' ? [t('Not included in the consolidation: {msg}', { msg: tx(String(r.reason?.message || r.reason)) })] : []));
          if (!parts.length) throw new Error(failed.join(' · '));
          return {
          year: y, from: `${y}-01-01`, to: `${y}-12-31`, currency: 'EUR',
          invoices: parts.flatMap(p => p.invoices.map(i => ({ ...i, amount: i.amount * (p.eurRate || 1) }))),
          openOrders: parts.flatMap(p => p.openOrders.map(o => ({ ...o, amount: o.amount * (p.eurRate || 1), invoiced: o.invoiced * (p.eurRate || 1), pending: o.pending * (p.eurRate || 1) }))),
          intercompanyExcluded: parts.reduce((t, p) => t + (p.intercompanyExcluded || 0), 0),
          warnings: [...failed, ...parts.flatMap(p => p.warnings)],
          };
        })
        : one(company, y);
      load.then(data => !cancelled && setYears(ys => ys.map(s => s.year !== y ? s : { ...s, data, loading: false })))
        .catch(err => !cancelled && setYears(ys => ys.map(s => s.year === y ? { ...s, error: err.message, loading: false } : s)));
    });
    return () => { cancelled = true; };
  }, [yearList, year, reload, company]);

  const loading = years.some(y => y.loading);
  const current = years.find(y => y.year === year);
  const previous = years.find(y => y.year === year - 1);

  // Facturas de todos los años cargados (un pedido de diciembre se puede facturar en enero) y Sales Orders abiertas hoy
  const allInvoices = useMemo(() => years.flatMap(y => y.data?.invoices || []).filter(i => i.kind === 'invoice' && i.orderDate), [years]);
  // Pendiente de cada pedido abierto = importe del pedido sin IVA − todo lo ya facturado de ese pedido en los años
  // cargados (el servidor solo descuenta lo facturado en el año pedido)
  const openOrders = useMemo(() => {
    const invoicedByOrder = new Map<string, number>();
    for (const y of years) for (const i of y.data?.invoices || []) {
      if (i.kind === 'invoice' && i.orderNo) invoicedByOrder.set(i.orderNo, (invoicedByOrder.get(i.orderNo) || 0) + i.amount);
    }
    return years.flatMap(y => y.data?.openOrders || []).map(o => {
      const invoiced = invoicedByOrder.get(o.no) ?? o.invoiced;
      return { ...o, invoiced, pending: Math.max(0, o.amount - invoiced) };
    }).filter(o => o.pending > 0.005);
  }, [years]);
  const lastDayOf = (ym: string) => { const [yy, mm] = ym.split('-').map(Number); return `${ym}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}`; };

  // Cifras de un año y mes
  const stats = (y: YearState | undefined, m: number) => {
    const inv = (y?.data?.invoices || []).filter(i => month(i.postingDate) === m);
    const byBucket = Object.fromEntries(BUCKETS.map(b => [b.id, 0])) as Record<Bucket, number>;
    for (const i of inv) byBucket[bucketOf(i)] += i.amount;
    const billed = inv.reduce((s, i) => s + i.amount, 0);
    const ym = `${y?.year}-${String(m).padStart(2, '0')}`;
    // Order Intake: pedidos con Order Date en el mes = lo ya facturado de ellos + lo que sigue abierto
    const intakeBilled = allInvoices.filter(i => i.orderDate!.startsWith(ym)).reduce((s, i) => s + i.amount, 0);
    const opened = openOrders.filter(o => o.orderDate.startsWith(ym));
    const end = lastDayOf(ym);
    const yearEnd = `${y?.year}-12-31`;
    const pend = (list: OpenOrder[]) => list.reduce((s, o) => s + o.pending, 0);
    // Pedidos creados en el mes: RDD dentro del mes (o antes), en meses siguientes del mismo año, o en años siguientes
    const openMonth = pend(opened.filter(o => o.requestedDeliveryDate <= end));
    const openNextSameYear = pend(opened.filter(o => o.requestedDeliveryDate > end && o.requestedDeliveryDate <= yearEnd));
    const openNextYear = pend(opened.filter(o => o.requestedDeliveryDate > yearEnd));
    // Pedidos de meses anteriores aún abiertos que deberían facturarse en este mes (RDD del mes); no forman parte del intake
    const backlog = openOrders.filter(o => o.orderDate < `${ym}-01` && o.requestedDeliveryDate.startsWith(ym));
    const openPrevMonths = pend(backlog);
    const openLater = openNextSameYear + openNextYear;
    const same = intakeBilled + openMonth + openLater;
    return { inv, billed, same, intakeBilled, byBucket, openOrders: opened, backlog, openMonth, openPrevMonths, openNextSameYear, openNextYear, openLater, pending: openMonth + openLater, total: same };
  };
  const sum = (y: YearState | undefined, k: 'billed' | 'same' | 'intakeBilled' | 'openMonth' | 'openPrevMonths' | 'openNextSameYear' | 'openNextYear' | 'openLater' | 'pending' | 'total') => months.reduce((s, m) => s + stats(y, m)[k], 0);
  const sumBucket = (y: YearState | undefined, b: Bucket) => months.reduce((s, m) => s + stats(y, m).byBucket[b], 0);
  // Crecimiento del Order Intake frente al mismo mes del año anterior (el año más antiguo no tiene con qué comparar)
  const prevOf = (y: YearState | undefined) => years.find(x => x.year === (y?.year ?? 0) - 1);
  const growth = (cur: number, prev: number | null) => (prev ? `${cur - prev >= 0 ? '+' : ''}${num(((cur - prev) / Math.abs(prev)) * 100, 1)} %` : '—');
  const growthTone = (cur: number, prev: number | null) => (!prev ? 'text-gray-400' : cur >= prev ? 'text-emerald-700' : 'text-[#C0392B]');
  const pct = (part: number, whole: number) => (whole ? `${num((part / whole) * 100, 1)} %` : '—');
  const money = (v: number) => (v ? num(v, 2) : '—');
  const warnings = Array.from(new Set(years.flatMap(y => y.data?.warnings || [])));
  const unknownCount = (current?.data?.invoices || []).filter(i => bucketOf(i) === 'unknown').length;

  const exportExcel = () => {
    const summary = months.map(m => {
      const row: Record<string, string | number> = { [t('Month')]: monthName(m) };
      years.forEach(y => {
        const st = stats(y, m);
        row[`${y.year} ${t('Invoiced')}`] = st.billed;
        row[`${y.year} ${t('Order Intake (orders with Order Date in the month)')}`] = st.same;
        const py = prevOf(y);
        row[`${y.year} ${t('% intake vs previous year')}`] = py ? (stats(py, m).same ? (st.same - stats(py, m).same) / Math.abs(stats(py, m).same) : '') : '';
        row[`${y.year} ${t('Intake already invoiced')}`] = st.intakeBilled;
        row[`${y.year} ${t('Open RDD in the month')}`] = st.openMonth;
        row[`${y.year} ${t('Open RDD month (earlier months)')}`] = st.openPrevMonths;
        row[`${y.year} ${t('Open RDD same year')}`] = st.openNextSameYear;
        row[`${y.year} ${t('Open RDD next year')}`] = st.openNextYear;
      });
      return row;
    });
    const invoices = years.flatMap(y => (y.data?.invoices || []).filter(i => months.includes(month(i.postingDate))).map(i => ({
      [t('Year')]: y.year, [t('Type')]: i.kind === 'credit' ? t('Credit memo') : t('Invoice'), 'Posting Date': i.postingDate, [t('Document')]: i.no, [t('Customer')]: i.customerNo, [t('Name')]: i.customerName,
      [t('Amount excl. VAT')]: i.amount, 'Order No.': i.orderNo, 'Order Date': i.orderDate || '',
      [t('Order age')]: t(BUCKETS.find(b => b.id === bucketOf(i))!.label),
    })));
    const orders = openOrders.map(o => ({
      'Sales Order': o.no, [t('Customer')]: o.customerNo, [t('Name')]: o.customerName, 'Order Date': o.orderDate,
      'Requested Delivery Date': o.requestedDeliveryDate, [t('Amount excl. VAT')]: o.amount, [t('Already invoiced')]: o.invoiced, [t('Pending')]: o.pending,
      [t('Order currency')]: o.currency || t('local'),
      [t('Intake month')]: o.orderDate.substring(0, 7),
      [t('Column')]: o.requestedDeliveryDate <= lastDayOf(o.orderDate.substring(0, 7)) ? t('Open RDD in the month') : t('Open later'),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), t('Summary'));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(invoices), t('Invoices'));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orders), t('Open Sales Orders'));
    XLSX.writeFile(wb, `${t('Invoicing by Order Date')}_${company}_${year}.xlsx`.replace(/\s+/g, '_'));
  };

  const select = 'block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal';
  const label = 'text-[11px] font-semibold uppercase tracking-wider text-gray-500';

  return (
    <Section title={t('Invoicing by Order Date')} source={t('Posted Sales Invoices (customer ledger entries, Sales LCY excl. VAT) · Order Date of the order (open or archived Sales Orders) · open Sales Orders (Order Date and Requested Delivery Date)')}>
      <div className="flex flex-wrap items-end gap-4">
        <label className={label}>
          {t('Year')}
          <select value={year} onChange={e => setYear(Number(e.target.value))} className={select}>
            {Array.from({ length: 6 }, (_, i) => thisYear - i).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <CompanySelect value={company} onChange={setCompany} />
        <p className="text-xs text-gray-500 pb-2">{t('Compared with {a} and {b}', { a: year - 2, b: year - 1 })}{company === CONSOLIDATED ? ` · ${t('consolidated in EUR')}` : ''}</p>
        <div className="ml-auto flex gap-2">
          <button onClick={resetWidths} title={t('Back to the default column widths')}
            className="px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm text-gray-600 hover:text-gray-900">{t('Default widths')}</button>
          <button onClick={exportExcel} disabled={loading || !months.length}
            className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
            <FileDown size={16} /> {t('Export Excel')}
          </button>
          <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={loading} title={t('Reload from BC')}
            className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {<>
          {years.filter(y => y.error).map(y => <ErrorBox key={y.year} message={`${y.year}: ${tx(y.error || '')}`} />)}
          {warnings.map(w => <p key={w} className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{tx(w)}</p>)}
          {loading ? <Loading text={t('Reading invoices and orders of {years} from Business Central…', { years: years.filter(y => y.loading).map(y => y.year).join(', ') })} />
            : (
              <>
                <Grid cols={4}>
                  <Kpi label={t('Invoiced {year}', { year })} value={num(sum(current, 'billed'), 0)} sub={t('January – December')} />
                  <Kpi highlight tone="main" label={`Order Intake ${year}`} value={num(sum(current, 'same'), 0)}
                    sub={`${t('Orders created in {year}', { year })} · ${year - 1}: ${num(sum(previous, 'same'), 0)} (${pct(sum(current, 'same') - sum(previous, 'same'), sum(previous, 'same'))})`} />
                  <Kpi label={t('Open RDD in the month')} value={num(sum(current, 'openMonth'), 0)} sub={t('Open orders that should be invoiced in the month they were created')} />
                  <Kpi label={t('Open later')} value={num(sum(current, 'openLater'), 0)} sub={t('{a} this year · {b} next year', { a: num(sum(current, 'openNextSameYear'), 0), b: num(sum(current, 'openNextYear'), 0) })} />
                </Grid>

                <div className="rpt-card bg-white rounded-xl border border-gray-200 table-scroll">
                  <table className="text-[13px]" style={{ tableLayout: 'fixed', width: widths.mes + years.reduce((t, y) => t + (y.year === year
                    ? ['billed', 'intake', 'pct', 'ya', 'rdd', 'rddPrev', 'same', 'next'] : ['billed', 'intake', 'pct']).reduce((a, r) => a + colW(y.year, r), 0), 0), minWidth: '100%' }}>
                    <colgroup>
                      <col style={{ width: widths.mes }} />
                      {years.flatMap(y => (y.year === year ? ['billed', 'intake', 'pct', 'ya', 'rdd', 'rddPrev', 'same', 'next'] : ['billed', 'intake', 'pct'])
                        .map(r => <col key={`${y.year}-${r}`} style={{ width: colW(y.year, r) }} />))}
                    </colgroup>
                    <thead>
                      <tr className="bg-gray-50">
                        <th className={`${th} text-left`} />
                        {years.map(y => (
                          <th key={y.year} colSpan={y.year === year ? 8 : 3}
                            className={`py-2 px-2 text-xs font-bold text-center border-l border-gray-200 ${y.year === year ? 'text-[#C8186C]' : 'text-gray-700'}`}>
                            {y.year}
                          </th>
                        ))}
                      </tr>
                      <tr className="border-b border-gray-200 bg-gray-50">
                        <ResizeTh id="mes" width={widths.mes} onResize={setWidth} className={`${th} text-left`}>
                          <button onClick={() => setOpen(months.every(m => open[m]) ? {} : Object.fromEntries(months.map(m => [m, true])))}
                            className="flex items-center gap-1 uppercase hover:text-gray-900" title={t('Expand or collapse all months')}>
                            {months.length > 0 && months.every(m => open[m]) ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t('Month')}
                          </button>
                        </ResizeTh>
                        {years.map(y => (
                          <Fragment key={y.year}>
                            {([
                              ['billed', t('Invoiced'), ''],
                              ['intake', t('Order Date in the month'), t('Order Intake: all Sales Orders with Order Date in this month (already invoiced + open)')],
                              ['pct', `% vs ${y.year - 1}`, t('Order Intake growth vs the same month of the previous year')],
                              ...(y.year === year ? [
                                ['ya', t('Already invoiced'), t('Part of the intake already invoiced (invoices of any date)')],
                                ['rdd', t('Open RDD month'), t('Orders created in the month, open, with Requested Delivery Date within the month')],
                                ['rddPrev', t('Open RDD month (earlier months)'), t('Orders from earlier months, open, with Requested Delivery Date in this month (not part of the intake of the month)')],
                                ['same', t('Open RDD same year'), t('Orders created in the month, open, with delivery in later months of the same year')],
                                ['next', t('Open RDD next year'), t('Orders created in the month, open, with delivery next year or later')],
                              ] : []),
                            ] as [string, string, string][]).map(([role, label, title]) => (
                              <ResizeTh key={role} id={`o${year - y.year}:${role}`} width={colW(y.year, role)} onResize={setWidth}
                                className={`${th} ${role === 'billed' ? 'border-l border-gray-200' : ''}`} title={title || undefined}>{label}</ResizeTh>
                            ))}
                          </Fragment>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {months.map(m => (
                        <Fragment key={m}>
                          <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => setOpen(o => ({ ...o, [m]: !o[m] }))}>
                            <td className="py-2 px-2 font-semibold text-gray-900 whitespace-nowrap">
                              <span className="inline-flex items-center gap-1">
                                {open[m] ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                                {monthName(m)}
                              </span>
                            </td>
                            {years.map(y => {
                              const st = stats(y, m);
                              return (
                                <Fragment key={y.year}>
                                  <td className={`${td} border-l border-gray-100 text-gray-700`}>{money(st.billed)}</td>
                                  <td className={`${td} font-bold text-[#C8186C]`}>{money(st.same)}</td>
                                  {(() => { const py = prevOf(y); const p = py ? stats(py, m).same : null; return <td className={`${td} ${growthTone(st.same, p)}`}>{growth(st.same, p)}</td>; })()}
                                  {y.year === year && <>
                                    <td className={`${td} text-gray-700`}>{money(st.intakeBilled)}</td>
                                    <td className={`${td} text-indigo-700`}>{money(st.openMonth)}</td>
                                    <td className={`${td} text-amber-700`}>{money(st.openPrevMonths)}</td>
                                    <td className={`${td} text-indigo-500`}>{money(st.openNextSameYear)}</td>
                                    <td className={`${td} text-indigo-400`}>{money(st.openNextYear)}</td>
                                  </>}
                                </Fragment>
                              );
                            })}
                          </tr>
                          {open[m] && BUCKETS.map(b => (
                            <tr key={`${m}-${b.id}`} className="border-b border-gray-100 bg-gray-50/60 text-[12px]">
                              <td className="py-1.5 px-2 pl-9 text-gray-600 whitespace-nowrap overflow-hidden text-ellipsis" title={t(b.label)}>{t(b.label)}</td>
                              {years.map(y => {
                                const st = stats(y, m);
                                return (
                                  <Fragment key={y.year}>
                                    <td className={`${td} border-l border-gray-100 text-gray-600`}>{money(st.byBucket[b.id])}</td>
                                    <td className={td} />
                                    <td className={`${td} text-gray-500`}>{st.byBucket[b.id] ? pct(st.byBucket[b.id], st.billed) : ''}</td>
                                    {y.year === year && <><td className={td} /><td className={td} /><td className={td} /><td className={td} /><td className={td} /></>}
                                  </Fragment>
                                );
                              })}
                            </tr>
                          ))}
                          {open[m] && stats(current, m).openOrders.length > 0 && (
                            <tr className="border-b border-gray-100 bg-indigo-50/40 text-[12px]">
                              <td colSpan={1 + years.reduce((t, y) => t + (y.year === year ? 8 : 3), 0)} className="py-2 px-2 pl-9 text-gray-600">
                                <span className="font-semibold text-indigo-800">{t('Open Sales Orders created in {month} {year}:', { month: monthInText(m), year })}</span>{' '}
                                {stats(current, m).openOrders.sort((a, b) => b.pending - a.pending).map((o, i) => (
                                  <span key={o.no}>{i ? ' · ' : ''}{o.no} {o.customerName} ({num(o.pending, 2)}{o.invoiced ? `, ${t('already invoiced {v}', { v: num(o.invoiced, 2) })}` : ''}, RDD {date(o.requestedDeliveryDate)})</span>
                                ))}
                              </td>
                            </tr>
                          )}
                          {open[m] && stats(current, m).backlog.length > 0 && (
                            <tr className="border-b border-gray-100 bg-amber-50/40 text-[12px]">
                              <td colSpan={1 + years.reduce((t, y) => t + (y.year === year ? 8 : 3), 0)} className="py-2 px-2 pl-9 text-gray-600">
                                <span className="font-semibold text-amber-800">{t('Orders from earlier months with delivery in {month} {year}:', { month: monthInText(m), year })}</span>{' '}
                                {[...stats(current, m).backlog].sort((a, b) => b.pending - a.pending).map((o, i) => (
                                  <span key={o.no}>{i ? ' · ' : ''}{o.no} {o.customerName} ({num(o.pending, 2)}, {t('order {date}', { date: date(o.orderDate) })}, RDD {date(o.requestedDeliveryDate)})</span>
                                ))}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                        <td className="py-2 px-2">{t('Total')}</td>
                        {years.map(y => (
                          <Fragment key={y.year}>
                            <td className={`${td} border-l border-gray-200`}>{money(sum(y, 'billed'))}</td>
                            <td className={`${td} text-[#C8186C]`}>{money(sum(y, 'same'))}</td>
                            {(() => { const py = prevOf(y); const p = py ? sum(py, 'same') : null; return <td className={`${td} ${growthTone(sum(y, 'same'), p)}`}>{growth(sum(y, 'same'), p)}</td>; })()}
                            {y.year === year && <>
                              <td className={td}>{money(sum(y, 'intakeBilled'))}</td>
                              <td className={`${td} text-indigo-700`}>{money(sum(y, 'openMonth'))}</td>
                              <td className={`${td} text-amber-700`}>{money(sum(y, 'openPrevMonths'))}</td>
                              <td className={`${td} text-indigo-500`}>{money(sum(y, 'openNextSameYear'))}</td>
                              <td className={`${td} text-indigo-400`}>{money(sum(y, 'openNextYear'))}</td>
                            </>}
                          </Fragment>
                        ))}
                      </tr>
                      {BUCKETS.filter(b => years.some(y => sumBucket(y, b.id))).map(b => (
                        <tr key={b.id} className="bg-gray-50 text-[12px] text-gray-600">
                          <td className="py-1 px-2 pl-9">{t(b.label)}</td>
                          {years.map(y => (
                            <Fragment key={y.year}>
                              <td className={`${td} border-l border-gray-200`}>{money(sumBucket(y, b.id))}</td>
                              <td className={td} />
                              <td className={td}>{sumBucket(y, b.id) ? pct(sumBucket(y, b.id), sum(y, 'billed')) : ''}</td>
                              {y.year === year && <><td className={td} /><td className={td} /><td className={td} /><td className={td} /><td className={td} /></>}
                            </Fragment>
                          ))}
                        </tr>
                      ))}
                    </tfoot>
                  </table>
                </div>
                <p className="text-xs text-gray-500">
                  {t('Amounts excl. VAT in the company currency (in EUR in the consolidation). Without intercompany: customers with payment method INTERGROUP or group companies (CRAZE …)')}{current?.data?.intercompanyExcluded ? `, ${t('{n} documents of {year} excluded', { n: num(current.data.intercompanyExcluded), year })}` : ''}. {t('Invoiced = Posted Sales Invoices − Posted Sales Credit Memos by Posting Date (posted documents only: entries with * in the number, with no document behind them, do not count).')}
                  {' '}{t('"Order Date in the month" = Order Intake: all Sales Orders created that month = what has already been invoiced of those orders (invoices from {from} to {to}, any month) + what is still open today, split into "Open RDD month" (Requested Delivery Date within the month of creation), "Open RDD same year" and "Open RDD next year". "Open RDD month (earlier months)" = orders created in earlier months, still open, that should be invoiced in this month (they do not add to the intake of the month). The % is the Order Intake growth vs the same month of the previous year (the oldest year has no comparison). Click a month to see what was invoiced by order age and the open orders of that month.', { from: year - 2, to: year })}
                  {unknownCount > 0 && ` ${t('{n} invoices of {year} have an order that is neither open nor archived in BC: they show as "Order not found".', { n: unknownCount, year })}`}
                </p>
              </>
            )}
        </>}
    </Section>
  );
}
