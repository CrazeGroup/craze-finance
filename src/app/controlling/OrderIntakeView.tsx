'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';
import CompanySelect, { CONSOLIDATED, REPORT_COMPANIES, useReportCompany } from './CompanySelect';

// Controlling · Facturación según Order Date: lo facturado cada mes (desglosable por antigüedad del pedido) y el Order
// Intake del mes = todos los Sales Orders creados ese mes (Order Date): lo ya facturado de esos pedidos (facturas de
// cualquier año cargado) + lo que sigue abierto, separado en Requested Delivery Date dentro del mes y posterior.
// Comparado con los mismos meses de los 2 años anteriores (solo facturas: histórico).
type Invoice = { kind: 'invoice' | 'credit'; no: string; postingDate: string; customerNo: string; customerName: string; amount: number; orderNo: string; orderDate: string | null };
type OpenOrder = { no: string; customerNo: string; customerName: string; orderDate: string; requestedDeliveryDate: string; amount: number; invoiced: number; pending: number; currency: string };
type YearData = { year: number; from: string; to: string; currency?: string; eurRate?: number; invoices: Invoice[]; openOrders: OpenOrder[]; intercompanyExcluded?: number; warnings: string[] };
type YearState = { year: number; data: YearData | null; error: string | null; loading: boolean };

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const COMPARE_YEARS = 2;
const ALL_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap text-right';
const td = 'py-2 px-2 whitespace-nowrap tabular-nums text-right';

// Antigüedad del pedido respecto al mes de la factura (comparable entre años)
const BUCKETS = [
  { id: 'same', label: 'Pedido del mismo mes' },
  { id: 'm1', label: 'Pedido del mes anterior' },
  { id: 'm2', label: 'Pedido de hace 2 meses' },
  { id: 'm3', label: 'Pedido de hace 3 meses o más' },
  { id: 'later', label: 'Order Date posterior a la factura' },
  { id: 'none', label: 'Factura sin pedido' },
  { id: 'unknown', label: 'Pedido no encontrado (sin Order Date)' },
  { id: 'credit', label: 'Abonos (Posted Sales Credit Memos)' },
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
  const { num, date } = fmt;
  const [company, setCompany] = useReportCompany(globalCompany);
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [reload, setReload] = useState({ n: 0, force: false });
  const [years, setYears] = useState<YearState[]>([]);
  const [open, setOpen] = useState<Record<number, boolean>>({});

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
          const failed = settled.flatMap(r => (r.status === 'rejected' ? [`No incluida en el consolidado: ${r.reason?.message || r.reason}`] : []));
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
  const openOrders = useMemo(() => years.flatMap(y => y.data?.openOrders || []), [years]);
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
      const row: Record<string, string | number> = { Mes: MONTHS[m - 1] };
      years.forEach(y => {
        const st = stats(y, m);
        row[`${y.year} Facturado`] = st.billed;
        row[`${y.year} Order Intake (pedidos con Order Date del mes)`] = st.same;
        const py = prevOf(y);
        row[`${y.year} % intake vs año anterior`] = py ? (stats(py, m).same ? (st.same - stats(py, m).same) / Math.abs(stats(py, m).same) : '') : '';
        row[`${y.year} Intake ya facturado`] = st.intakeBilled;
        row[`${y.year} Abierto RDD en el mes`] = st.openMonth;
        row[`${y.year} Abierto meses anteriores con RDD del mes`] = st.openPrevMonths;
        row[`${y.year} Abierto próx. mismo año`] = st.openNextSameYear;
        row[`${y.year} Abierto próx. año siguiente`] = st.openNextYear;
      });
      return row;
    });
    const invoices = years.flatMap(y => (y.data?.invoices || []).filter(i => months.includes(month(i.postingDate))).map(i => ({
      'Año': y.year, 'Tipo': i.kind === 'credit' ? 'Abono' : 'Factura', 'Posting Date': i.postingDate, 'Documento': i.no, 'Cliente': i.customerNo, 'Nombre': i.customerName,
      'Importe sin IVA': i.amount, 'Order No.': i.orderNo, 'Order Date': i.orderDate || '',
      'Antigüedad del pedido': BUCKETS.find(b => b.id === bucketOf(i))!.label,
    })));
    const orders = openOrders.map(o => ({
      'Sales Order': o.no, 'Cliente': o.customerNo, 'Nombre': o.customerName, 'Order Date': o.orderDate,
      'Requested Delivery Date': o.requestedDeliveryDate, 'Importe sin IVA': o.amount, 'Ya facturado': o.invoiced, 'Pendiente': o.pending,
      'Divisa del pedido': o.currency || 'local',
      'Mes de intake': o.orderDate.substring(0, 7),
      'Columna': o.requestedDeliveryDate <= lastDayOf(o.orderDate.substring(0, 7)) ? 'Abierto RDD en el mes' : 'Abierto próximamente',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Resumen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(invoices), 'Facturas');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orders), 'Sales Orders abiertas');
    XLSX.writeFile(wb, `Facturacion_Order_Date_${company}_${year}.xlsx`.replace(/\s+/g, '_'));
  };

  const select = 'block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal';
  const label = 'text-[11px] font-semibold uppercase tracking-wider text-gray-500';

  return (
    <Section title="Facturación según Order Date" source="Posted Sales Invoices (movimientos de cliente, Sales LCY sin IVA) · Order Date del pedido (Sales Orders abiertas o archivadas) · Sales Orders abiertas (Order Date y Requested Delivery Date)">
      <div className="flex flex-wrap items-end gap-4">
        <label className={label}>
          Año
          <select value={year} onChange={e => setYear(Number(e.target.value))} className={select}>
            {Array.from({ length: 6 }, (_, i) => thisYear - i).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <CompanySelect value={company} onChange={setCompany} />
        <p className="text-xs text-gray-500 pb-2">Comparado con {year - 2} y {year - 1}{company === CONSOLIDATED ? ' · consolidado en EUR' : ''}</p>
        <div className="ml-auto flex gap-2">
          <button onClick={exportExcel} disabled={loading || !months.length}
            className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
            <FileDown size={16} /> Exportar Excel
          </button>
          <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={loading} title="Volver a leer de BC"
            className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {<>
          {years.filter(y => y.error).map(y => <ErrorBox key={y.year} message={`${y.year}: ${y.error}`} />)}
          {warnings.map(w => <p key={w} className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{w}</p>)}
          {loading ? <Loading text={`Leyendo facturas y pedidos de ${years.filter(y => y.loading).map(y => y.year).join(', ')} de Business Central…`} />
            : (
              <>
                <Grid cols={4}>
                  <Kpi label={`Facturado ${year}`} value={num(sum(current, 'billed'), 0)} sub="Enero – diciembre" />
                  <Kpi highlight tone="main" label={`Order Intake ${year}`} value={num(sum(current, 'same'), 0)}
                    sub={`Pedidos creados en ${year} · ${year - 1}: ${num(sum(previous, 'same'), 0)} (${pct(sum(current, 'same') - sum(previous, 'same'), sum(previous, 'same'))})`} />
                  <Kpi label="Abierto RDD en el mes" value={num(sum(current, 'openMonth'), 0)} sub="Pedidos abiertos que deberían facturarse en su mes de creación" />
                  <Kpi label="Abierto próximamente" value={num(sum(current, 'openLater'), 0)} sub={`${num(sum(current, 'openNextSameYear'), 0)} este año · ${num(sum(current, 'openNextYear'), 0)} el año siguiente`} />
                </Grid>

                <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto">
                  <table className="w-full text-[13px]">
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
                        <th className={`${th} text-left`}>
                          <button onClick={() => setOpen(months.every(m => open[m]) ? {} : Object.fromEntries(months.map(m => [m, true])))}
                            className="flex items-center gap-1 uppercase hover:text-gray-900" title="Desplegar o plegar todos los meses">
                            {months.length > 0 && months.every(m => open[m]) ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Mes
                          </button>
                        </th>
                        {years.map(y => (
                          <Fragment key={y.year}>
                            <th className={`${th} border-l border-gray-200`}>Facturado</th>
                            <th className={th} title="Order Intake: todos los Sales Orders con Order Date en este mes (ya facturado + abierto)">Order Date del mes</th>
                            <th className={th} title="Crecimiento del Order Intake frente al mismo mes del año anterior">% vs {y.year - 1}</th>
                            {y.year === year && <>
                              <th className={th} title="Parte del intake ya facturada (facturas de cualquier fecha)">Ya facturado</th>
                              <th className={th} title="Pedidos creados en el mes, abiertos, con Requested Delivery Date dentro del mes">Abierto RDD mes</th>
                              <th className={th} title="Pedidos de meses anteriores, abiertos, con Requested Delivery Date en este mes (no forman parte del intake del mes)">Abierto RDD mes (pedidos anteriores)</th>
                              <th className={th} title="Pedidos creados en el mes, abiertos, con entrega en meses siguientes del mismo año">Abierto próx. mismo año</th>
                              <th className={th} title="Pedidos creados en el mes, abiertos, con entrega el año siguiente o después">Abierto próx. año siguiente</th>
                            </>}
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
                                {MONTHS[m - 1]}
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
                              <td className="py-1.5 px-2 pl-9 text-gray-600 whitespace-nowrap">{b.label}</td>
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
                                <span className="font-semibold text-indigo-800">Sales Orders abiertas creadas en {MONTHS[m - 1].toLowerCase()} {year}:</span>{' '}
                                {stats(current, m).openOrders.sort((a, b) => b.pending - a.pending).map((o, i) => (
                                  <span key={o.no}>{i ? ' · ' : ''}{o.no} {o.customerName} ({num(o.pending, 2)}{o.invoiced ? `, ya facturado ${num(o.invoiced, 2)}` : ''}, RDD {date(o.requestedDeliveryDate)})</span>
                                ))}
                              </td>
                            </tr>
                          )}
                          {open[m] && stats(current, m).backlog.length > 0 && (
                            <tr className="border-b border-gray-100 bg-amber-50/40 text-[12px]">
                              <td colSpan={1 + years.reduce((t, y) => t + (y.year === year ? 8 : 3), 0)} className="py-2 px-2 pl-9 text-gray-600">
                                <span className="font-semibold text-amber-800">Pedidos de meses anteriores con entrega en {MONTHS[m - 1].toLowerCase()} {year}:</span>{' '}
                                {[...stats(current, m).backlog].sort((a, b) => b.pending - a.pending).map((o, i) => (
                                  <span key={o.no}>{i ? ' · ' : ''}{o.no} {o.customerName} ({num(o.pending, 2)}, pedido {date(o.orderDate)}, RDD {date(o.requestedDeliveryDate)})</span>
                                ))}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                        <td className="py-2 px-2">Total</td>
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
                          <td className="py-1 px-2 pl-9">{b.label}</td>
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
                  Importes sin IVA en la divisa de la empresa (en EUR en el consolidado). Sin intercompañía: clientes con forma de pago INTERGROUP o empresas del grupo (CRAZE …){current?.data?.intercompanyExcluded ? `, ${num(current.data.intercompanyExcluded)} documentos de ${year} excluidos` : ''}. Facturado = Posted Sales Invoices − Posted Sales Credit Memos por Posting Date (solo documentos registrados: los movimientos con * en el nº, sin documento detrás, no cuentan).
                  &quot;Order Date del mes&quot; = Order Intake: todos los Sales Orders creados ese mes = lo ya facturado de esos pedidos (facturas de {year - 2} a {year}, cualquier mes) + lo que sigue abierto hoy, separado en &quot;Abierto RDD mes&quot; (Requested Delivery Date dentro del mes de creación), &quot;Abierto próx. mismo año&quot; y &quot;Abierto próx. año siguiente&quot;. &quot;Abierto RDD mes (pedidos anteriores)&quot; = pedidos creados en meses anteriores, aún abiertos, que deberían facturarse en este mes (no suman al intake del mes). El % es el crecimiento del Order Intake frente al mismo mes del año anterior (el año más antiguo no tiene comparación). Haz clic en un mes para ver lo facturado por antigüedad del pedido y los pedidos abiertos de ese mes.
                  {unknownCount > 0 && ` ${unknownCount} facturas de ${year} tienen un pedido que no está abierto ni archivado en BC: salen como "Pedido no encontrado".`}
                </p>
              </>
            )}
        </>}
    </Section>
  );
}
