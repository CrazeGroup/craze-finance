'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileDown, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';

// Controlling · Ventas por licencia: venta (Turnover de la LM, como Royalties) por Royalty Code de la empresa activa,
// del 1 de enero a la fecha elegida, comparada con el mismo periodo de años anteriores.
type YearData = { from: string; to: string; currency: string; byCode: Record<string, { turnover: number; qty: number }>; lines: number };
type YearState = { year: number; from: string; to: string; data: YearData | null; error: string | null; loading: boolean };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Último día del mes anterior
const defaultTo = () => { const d = new Date(); return iso(new Date(d.getFullYear(), d.getMonth(), 0)); };
// Misma fecha en otro año (29/02 → 28/02 si el año no es bisiesto)
function sameDayIn(year: number, to: string) {
  const [, m, d] = to.split('-').map(Number);
  const last = new Date(year, m, 0).getDate();
  return `${year}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
const th = 'py-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap';
const td = 'py-2 px-3 whitespace-nowrap tabular-nums';

export default function LicenseSalesView({ fmt, company }: { fmt: Fmt; company: string }) {
  const { num, date } = fmt;
  const [to, setTo] = useState(defaultTo);
  const [yearsBack, setYearsBack] = useState(2);
  const [measure, setMeasure] = useState<'turnover' | 'qty'>('turnover');
  const [reload, setReload] = useState({ n: 0, force: false });
  const [years, setYears] = useState<YearState[]>([]);

  const endYear = Number(to.substring(0, 4));
  const periods = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return [];
    return Array.from({ length: yearsBack + 1 }, (_, i) => endYear - yearsBack + i)
      .map(year => ({ year, from: `${year}-01-01`, to: sameDayIn(year, to) }));
  }, [to, yearsBack, endYear]);

  // Un periodo por petición (cada año es una lectura de BC; así ninguna pasa del límite de 60 s)
  useEffect(() => {
    let cancelled = false;
    setYears(periods.map(p => ({ ...p, data: null, error: null, loading: true })));
    periods.forEach(p => {
      fetch(`/api/controlling/license-sales?from=${p.from}&to=${p.to}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
        .then(async res => {
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          if (cancelled) return;
          setYears(ys => ys.map(y => y.year !== p.year ? y : res.ok && !data.error
            ? { ...y, data, loading: false } : { ...y, error: data.error || `HTTP ${res.status}`, loading: false }));
        })
        .catch(err => !cancelled && setYears(ys => ys.map(y => y.year === p.year ? { ...y, error: err.message, loading: false } : y)));
    });
    return () => { cancelled = true; };
  }, [periods, reload, company]);

  const loading = years.some(y => y.loading);
  const errors = years.filter(y => y.error);
  const currency = years.find(y => y.data)?.data?.currency || 'EUR';
  const value = (y: YearState, code: string) => y.data?.byCode[code]?.[measure] || 0;
  const total = (y: YearState) => Object.values(y.data?.byCode || {}).reduce((s, c) => s + c[measure], 0);
  const current = years[years.length - 1];
  const previous = years[years.length - 2];

  // Licencias de cualquier año, ordenadas por el año más reciente
  const codes = useMemo(() => {
    const all = new Set(years.flatMap(y => Object.keys(y.data?.byCode || {})));
    return Array.from(all).sort((a, b) => {
      for (let i = years.length - 1; i >= 0; i--) {
        const diff = value(years[i], b) - value(years[i], a);
        if (diff) return diff;
      }
      return a.localeCompare(b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years, measure]);

  const fmtV = (v: number) => (v ? num(v, measure === 'turnover' ? 2 : 0) : '—');
  const delta = (cur: number, prev: number) => {
    const d = cur - prev;
    const pct = prev ? d / Math.abs(prev) : null;
    return { d, pct };
  };
  const Delta = ({ cur, prev }: { cur: number; prev: number }) => {
    const { d, pct } = delta(cur, prev);
    const cls = d > 0 ? 'text-emerald-700' : d < 0 ? 'text-[#C0392B]' : 'text-gray-400';
    return (
      <>
        <td className={`${td} text-right ${cls}`}>{d ? `${d > 0 ? '+' : ''}${num(d, measure === 'turnover' ? 2 : 0)}` : '—'}</td>
        <td className={`${td} text-right ${cls}`}>{pct == null ? (cur ? 'nuevo' : '—') : `${pct > 0 ? '+' : ''}${num(pct * 100, 1)} %`}</td>
      </>
    );
  };

  const exportExcel = () => {
    const unit = measure === 'turnover' ? `Venta ${currency}` : 'Unidades';
    const rows = [...codes, 'Total'].map(code => {
      const row: Record<string, string | number | null> = { 'Royalty Code': code };
      years.forEach(y => { row[`${unit} ${y.year}`] = code === 'Total' ? total(y) : value(y, code); });
      if (current && previous) {
        const cur = code === 'Total' ? total(current) : value(current, code);
        const prev = code === 'Total' ? total(previous) : value(previous, code);
        const { d, pct } = delta(cur, prev);
        row[`Δ ${current.year} vs ${previous.year}`] = d;
        row[`Δ % ${current.year} vs ${previous.year}`] = pct == null ? null : pct;
      }
      return row;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Ventas por licencia');
    XLSX.writeFile(wb, `Ventas_por_licencia_${company}_${to}.xlsx`.replace(/\s+/g, '_'));
  };

  return (
    <Section title="Ventas por licencia" source="AIT Documents LM Components (60000) · Royalty Code de la ficha de artículo en CRAZE GmbH · sin Main Item ni ventas intercompañía (igual que Royalties)">
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Del 1 de enero hasta
          <input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)}
            className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal" />
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Comparar con
          <select value={yearsBack} onChange={e => setYearsBack(Number(e.target.value))}
            className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal">
            {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n === 1 ? 'el año anterior' : `los ${n} años anteriores`}</option>)}
          </select>
        </label>
        <div className="flex bg-gray-100 rounded-lg p-1">
          {([['turnover', `Venta (${currency})`], ['qty', 'Unidades']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setMeasure(id)}
              className={`px-3 py-1 rounded-md text-sm font-semibold ${measure === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={exportExcel} disabled={loading || !codes.length}
            className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
            <FileDown size={16} /> Exportar Excel
          </button>
          <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={loading} title="Volver a leer de BC"
            className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {errors.map(y => <ErrorBox key={y.year} message={`${y.year}: ${y.error}`} />)}
      {loading ? <Loading text={`Leyendo las ventas de ${years.filter(y => y.loading).map(y => y.year).join(', ')} de Business Central…`} />
        : !codes.length ? <p className="text-sm text-gray-600">No hay ventas en estos periodos.</p>
        : (
          <>
            {current && previous && (
              <Grid cols={3}>
                <Kpi label={`${current.year} (${date(current.from)} – ${date(current.to)})`} value={num(total(current), 0)} sub={measure === 'turnover' ? currency : 'unidades'} />
                <Kpi label={`${previous.year} (mismo periodo)`} value={num(total(previous), 0)} sub={measure === 'turnover' ? currency : 'unidades'} />
                <Kpi highlight tone={total(current) >= total(previous) ? 'main' : 'neutral'} label={`Variación ${current.year} vs ${previous.year}`}
                  value={`${total(current) - total(previous) >= 0 ? '+' : ''}${num(total(current) - total(previous), 0)}`}
                  sub={total(previous) ? `${num(((total(current) - total(previous)) / Math.abs(total(previous))) * 100, 1)} %` : undefined} />
              </Grid>
            )}

            <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className={`${th} text-left`}>Royalty Code</th>
                    {years.map(y => (
                      <th key={y.year} className={`${th} text-right`}>
                        {y.year}
                        <span className="block font-normal normal-case tracking-normal">{date(y.from)} – {date(y.to)}</span>
                      </th>
                    ))}
                    {current && previous && <>
                      <th className={`${th} text-right`}>Δ {current.year} vs {previous.year}</th>
                      <th className={`${th} text-right`}>Δ %</th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {codes.map(code => (
                    <tr key={code} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className={`${td} font-semibold text-gray-900`}>{code}</td>
                      {years.map(y => <td key={y.year} className={`${td} text-right ${y === current ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{fmtV(value(y, code))}</td>)}
                      {current && previous && <Delta cur={value(current, code)} prev={value(previous, code)} />}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                    <td className={td}>Total</td>
                    {years.map(y => <td key={y.year} className={`${td} text-right`}>{fmtV(total(y))}</td>)}
                    {current && previous && <Delta cur={total(current)} prev={total(previous)} />}
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-xs text-gray-500">
              Importes en la divisa de la empresa ({currency}), Turnover neto de la LM de BC. Cada año se compara del 1 de enero a la misma fecha.
              Las licencias se asignan con el Royalty Code actual de la ficha del artículo, también en los años anteriores.
            </p>
          </>
        )}
    </Section>
  );
}
