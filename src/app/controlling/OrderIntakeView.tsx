'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';

// Controlling · Facturación según Order Date: lo facturado cada mes desglosado por el mes de la Order Date del pedido,
// más (año en curso) las Sales Orders abiertas con Order Date y Requested Delivery Date en ese mismo mes.
// Comparado con los mismos meses de los 2 años anteriores (solo facturas: histórico).
type Invoice = { no: string; postingDate: string; customerNo: string; customerName: string; amount: number; orderNo: string; orderDate: string | null };
type OpenOrder = { no: string; customerNo: string; customerName: string; orderDate: string; requestedDeliveryDate: string; amount: number; invoiced: number; pending: number; currency: string };
type YearData = { year: number; from: string; to: string; invoices: Invoice[]; openOrders: OpenOrder[]; warnings: string[] };
type YearState = { year: number; data: YearData | null; error: string | null; loading: boolean };

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const COMPARE_YEARS = 2;
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
] as const;
type Bucket = typeof BUCKETS[number]['id'];
function bucketOf(i: Invoice): Bucket {
  if (!i.orderNo) return 'none';
  if (!i.orderDate) return 'unknown';
  const months = (Number(i.postingDate.substring(0, 4)) - Number(i.orderDate.substring(0, 4))) * 12
    + Number(i.postingDate.substring(5, 7)) - Number(i.orderDate.substring(5, 7));
  return months < 0 ? 'later' : months === 0 ? 'same' : months === 1 ? 'm1' : months === 2 ? 'm2' : 'm3';
}
const month = (date: string) => Number(date.substring(5, 7));

export default function OrderIntakeView({ fmt, company }: { fmt: Fmt; company: string }) {
  const { num, date } = fmt;
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [fromMonth, setFromMonth] = useState(1);
  const [toMonth, setToMonth] = useState(new Date().getMonth() + 1);
  const [reload, setReload] = useState({ n: 0, force: false });
  const [years, setYears] = useState<YearState[]>([]);
  const [open, setOpen] = useState<Record<number, boolean>>({});

  const yearList = useMemo(() => Array.from({ length: COMPARE_YEARS + 1 }, (_, i) => year - COMPARE_YEARS + i), [year]);
  const months = useMemo(() => Array.from({ length: Math.max(0, toMonth - fromMonth + 1) }, (_, i) => fromMonth + i), [fromMonth, toMonth]);
  const withOpen = year === thisYear;

  // Un año por petición (cada una lee BC por separado y no pasa del límite de 60 s)
  useEffect(() => {
    if (fromMonth > toMonth) return;
    let cancelled = false;
    setYears(yearList.map(y => ({ year: y, data: null, error: null, loading: true })));
    yearList.forEach(y => {
      const params = `year=${y}&from=${fromMonth}&to=${toMonth}${y === year && withOpen ? '&open=1' : ''}${reload.force ? '&force=1' : ''}`;
      fetch(`/api/controlling/order-intake?${params}`, { cache: 'no-store' })
        .then(async res => {
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          if (cancelled) return;
          setYears(ys => ys.map(s => s.year !== y ? s : res.ok && !data.error
            ? { ...s, data, loading: false } : { ...s, error: data.error || `HTTP ${res.status}`, loading: false }));
        })
        .catch(err => !cancelled && setYears(ys => ys.map(s => s.year === y ? { ...s, error: err.message, loading: false } : s)));
    });
    return () => { cancelled = true; };
  }, [yearList, fromMonth, toMonth, year, withOpen, reload, company]);

  const loading = years.some(y => y.loading);
  const current = years.find(y => y.year === year);
  const previous = years.find(y => y.year === year - 1);

  // Cifras de un año y mes
  const stats = (y: YearState | undefined, m: number) => {
    const inv = (y?.data?.invoices || []).filter(i => month(i.postingDate) === m);
    const byBucket = Object.fromEntries(BUCKETS.map(b => [b.id, 0])) as Record<Bucket, number>;
    for (const i of inv) byBucket[bucketOf(i)] += i.amount;
    const billed = inv.reduce((s, i) => s + i.amount, 0);
    const ym = `${y?.year}-${String(m).padStart(2, '0')}`;
    const openOrders = (y?.data?.openOrders || []).filter(o => o.orderDate.startsWith(ym) && o.requestedDeliveryDate.startsWith(ym));
    const pending = openOrders.reduce((s, o) => s + o.pending, 0);
    return { inv, billed, same: byBucket.same, byBucket, openOrders, pending, total: byBucket.same + pending };
  };
  const sum = (y: YearState | undefined, k: 'billed' | 'same' | 'pending' | 'total') => months.reduce((s, m) => s + stats(y, m)[k], 0);
  const sumBucket = (y: YearState | undefined, b: Bucket) => months.reduce((s, m) => s + stats(y, m).byBucket[b], 0);
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
        row[`${y.year} Facturado con Order Date del mes`] = st.same;
        row[`${y.year} % del mes`] = st.billed ? st.same / st.billed : 0;
        if (y.year === year && withOpen) {
          row[`${y.year} Sales Orders abiertas (OD y RDD en el mes)`] = st.pending;
          row[`${y.year} Total del mes`] = st.total;
        }
      });
      return row;
    });
    const invoices = years.flatMap(y => (y.data?.invoices || []).filter(i => months.includes(month(i.postingDate))).map(i => ({
      'Año': y.year, 'Posting Date': i.postingDate, 'Factura': i.no, 'Cliente': i.customerNo, 'Nombre': i.customerName,
      'Importe sin IVA': i.amount, 'Order No.': i.orderNo, 'Order Date': i.orderDate || '',
      'Antigüedad del pedido': BUCKETS.find(b => b.id === bucketOf(i))!.label,
    })));
    const orders = (current?.data?.openOrders || []).map(o => ({
      'Sales Order': o.no, 'Cliente': o.customerNo, 'Nombre': o.customerName, 'Order Date': o.orderDate,
      'Requested Delivery Date': o.requestedDeliveryDate, 'Importe sin IVA': o.amount, 'Ya facturado': o.invoiced, 'Pendiente': o.pending,
      'Divisa del pedido': o.currency || 'local',
      'Cuenta en el mes': o.orderDate.substring(0, 7) === o.requestedDeliveryDate.substring(0, 7) && months.includes(month(o.requestedDeliveryDate)) && o.requestedDeliveryDate.startsWith(String(year)) ? 'Sí' : 'No',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Resumen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(invoices), 'Facturas');
    if (withOpen) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orders), 'Sales Orders abiertas');
    XLSX.writeFile(wb, `Facturacion_Order_Date_${company}_${year}_${fromMonth}-${toMonth}.xlsx`.replace(/\s+/g, '_'));
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
        <label className={label}>
          Desde
          <select value={fromMonth} onChange={e => setFromMonth(Number(e.target.value))} className={select}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </label>
        <label className={label}>
          Hasta
          <select value={toMonth} onChange={e => setToMonth(Number(e.target.value))} className={select}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </label>
        <p className="text-xs text-gray-500 pb-2">Comparado con {year - 2} y {year - 1}</p>
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

      {fromMonth > toMonth ? <ErrorBox message="El mes Desde es posterior a Hasta." />
        : <>
          {years.filter(y => y.error).map(y => <ErrorBox key={y.year} message={`${y.year}: ${y.error}`} />)}
          {warnings.map(w => <p key={w} className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{w}</p>)}
          {loading ? <Loading text={`Leyendo facturas y pedidos de ${years.filter(y => y.loading).map(y => y.year).join(', ')} de Business Central…`} />
            : (
              <>
                <Grid cols={4}>
                  <Kpi label={`Facturado ${year}`} value={num(sum(current, 'billed'), 0)} sub={`${MONTHS[fromMonth - 1]} – ${MONTHS[toMonth - 1]}`} />
                  <Kpi label="Con Order Date del mismo mes" value={num(sum(current, 'same'), 0)}
                    sub={`${pct(sum(current, 'same'), sum(current, 'billed'))} (${year - 1}: ${pct(sum(previous, 'same'), sum(previous, 'billed'))})`} />
                  {withOpen
                    ? <Kpi label="Sales Orders abiertas del mes" value={num(sum(current, 'pending'), 0)} sub="Order Date y Requested Delivery Date en el mismo mes, pendiente de facturar" />
                    : <Kpi label={`Facturado ${year - 1}`} value={num(sum(previous, 'billed'), 0)} sub="mismo periodo" />}
                  <Kpi highlight tone="main" label={withOpen ? 'Pedido y facturable en el mes' : `Variación vs ${year - 1}`}
                    value={withOpen ? num(sum(current, 'total'), 0) : `${num(sum(current, 'billed') - sum(previous, 'billed'), 0)}`}
                    sub={withOpen ? 'Facturado con Order Date del mes + Sales Orders abiertas del mes' : pct(sum(current, 'billed') - sum(previous, 'billed'), sum(previous, 'billed'))} />
                </Grid>

                <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className={`${th} text-left`} />
                        {years.map(y => (
                          <th key={y.year} colSpan={y.year === year && withOpen ? 5 : 3}
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
                            <th className={th}>Order Date del mes</th>
                            <th className={th}>%</th>
                            {y.year === year && withOpen && <>
                              <th className={th} title="Sales Orders abiertas con Order Date y Requested Delivery Date en el mes (pendiente de facturar)">+ Abiertas del mes</th>
                              <th className={th}>= Total del mes</th>
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
                                  <td className={`${td} font-semibold text-gray-900`}>{money(st.same)}</td>
                                  <td className={`${td} text-gray-500`}>{pct(st.same, st.billed)}</td>
                                  {y.year === year && withOpen && <>
                                    <td className={`${td} text-indigo-700`}>{money(st.pending)}</td>
                                    <td className={`${td} font-bold text-[#C8186C]`}>{money(st.total)}</td>
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
                                    {y.year === year && withOpen && <><td className={td} /><td className={td} /></>}
                                  </Fragment>
                                );
                              })}
                            </tr>
                          ))}
                          {open[m] && withOpen && stats(current, m).openOrders.length > 0 && (
                            <tr className="border-b border-gray-100 bg-indigo-50/40 text-[12px]">
                              <td colSpan={1 + years.reduce((s, y) => s + (y.year === year ? 5 : 3), 0)} className="py-2 px-2 pl-9 text-gray-600">
                                <span className="font-semibold text-indigo-800">Sales Orders abiertas del mes:</span>{' '}
                                {stats(current, m).openOrders.sort((a, b) => b.pending - a.pending).map((o, i) => (
                                  <span key={o.no}>{i ? ' · ' : ''}{o.no} {o.customerName} ({num(o.pending, 2)}{o.invoiced ? `, ya facturado ${num(o.invoiced, 2)}` : ''}, RDD {date(o.requestedDeliveryDate)})</span>
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
                            <td className={td}>{money(sum(y, 'same'))}</td>
                            <td className={td}>{pct(sum(y, 'same'), sum(y, 'billed'))}</td>
                            {y.year === year && withOpen && <>
                              <td className={`${td} text-indigo-700`}>{money(sum(y, 'pending'))}</td>
                              <td className={`${td} text-[#C8186C]`}>{money(sum(y, 'total'))}</td>
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
                              {y.year === year && withOpen && <><td className={td} /><td className={td} /></>}
                            </Fragment>
                          ))}
                        </tr>
                      ))}
                    </tfoot>
                  </table>
                </div>
                <p className="text-xs text-gray-500">
                  Importes sin IVA en la divisa de la empresa. Facturado = Posted Sales Invoices por Posting Date (sin abonos).
                  &quot;Order Date del mes&quot; = facturas cuyo pedido tiene la Order Date en el mismo mes que la factura. Haz clic en un mes para ver el desglose por antigüedad del pedido.
                  {withOpen && ' "Abiertas del mes" = Sales Orders abiertas hoy con Order Date y Requested Delivery Date en ese mes, menos lo ya facturado del pedido en el periodo; solo existen para el año en curso.'}
                  {unknownCount > 0 && ` ${unknownCount} facturas de ${year} tienen un pedido que no está abierto ni archivado en BC: salen como "Pedido no encontrado".`}
                </p>
              </>
            )}
        </>}
    </Section>
  );
}
