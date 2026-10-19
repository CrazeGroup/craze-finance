'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';

// Controlling · Ventas por licencia: venta (Turnover de la LM, como Royalties) por Royalty Code de la empresa activa,
// del 1 de enero a la fecha elegida, comparada con el mismo periodo de años anteriores.
type Agg = { turnover: number; amount: number; qty: number; provision: number };
type YearData = {
  from: string; to: string; currency: string; ratesSource: 'bc' | 'lm'; amountField: string | null; shipCountryField: string | null; byCode: Record<string, Agg>; lines: number;
  breakdown: Record<string, { ship: Record<string, Agg>; group: Record<string, Agg> }>; groupNames: Record<string, string>;
};
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
// Qué se compara: importes de la LM, provisión de royalties (calculada como en Royalties) o unidades
const MEASURES = [
  { id: 'amount', label: 'Venta (Amount)' },
  { id: 'turnover', label: 'Venta (Turnover Net of Provision Sales)' },
  { id: 'provision', label: 'Provision Royalties' },
  { id: 'qty', label: 'Unidades' },
] as const;
type MeasureKey = typeof MEASURES[number]['id'];
const measureLabel = (k: MeasureKey) => MEASURES.find(m => m.id === k)!.label;
const th = 'py-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap';
const td = 'py-2 px-3 whitespace-nowrap tabular-nums';

export default function LicenseSalesView({ fmt, company }: { fmt: Fmt; company: string }) {
  const { num, date } = fmt;
  const [to, setTo] = useState(defaultTo);
  const [yearsBack, setYearsBack] = useState(2);
  // Venta por Turnover Net of Provision Sales o por Amount de la LM, o unidades
  const [key, setKey] = useState<MeasureKey>('turnover');
  const measure = key === 'qty' ? 'qty' : 'turnover';   // importe o unidades
  // Subnivel al desplegar un Royalty Code: país de envío o Customer Group
  const [level, setLevel] = useState<'ship' | 'group'>('ship');
  const [open, setOpen] = useState<Record<string, boolean>>({});
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
  const value = (y: YearState, code: string) => y.data?.byCode[code]?.[key] || 0;
  const total = (y: YearState) => Object.values(y.data?.byCode || {}).reduce((s, c) => s + (c[key] || 0), 0);
  const subValue = (y: YearState, code: string, k: string) => y.data?.breakdown?.[code]?.[level]?.[k]?.[key] || 0;
  // Subniveles de un código en cualquier año, ordenados por el año más reciente
  const subKeys = (code: string) => {
    const all = new Set(years.flatMap(y => Object.keys(y.data?.breakdown?.[code]?.[level] || {})));
    return Array.from(all).sort((a, b) => {
      for (let i = years.length - 1; i >= 0; i--) {
        const diff = subValue(years[i], code, b) - subValue(years[i], code, a);
        if (diff) return diff;
      }
      return a.localeCompare(b);
    });
  };
  const groupNames = Object.assign({}, ...years.map(y => y.data?.groupNames || {})) as Record<string, string>;
  const subLabel = (k: string) => level === 'group'
    ? (k ? `${k}${groupNames[k] ? ` · ${groupNames[k]}` : ''}` : '(sin Customer Group)')
    : (k || '(sin país)');
  const shipFromBill = level === 'ship' && years.some(y => y.data && !y.data.shipCountryField);
  const allOpen = (list: string[]) => list.length > 0 && list.every(c => open[c]);
  const noAmount = key === 'amount' && years.some(y => y.data && !y.data.amountField);
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
  }, [years, key]);

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

  // ---------- Puntos clave (calculados de la tabla, sin IA) ----------
  const unitLabel = measure === 'turnover' ? currency : 'uds.';
  const amt = (v: number) => `${num(v, 0)} ${unitLabel}`;
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), 0)} ${unitLabel}`;
  const pctTxt = (cur: number, prev: number) => (prev ? `${cur >= prev ? '+' : '−'}${num(Math.abs((cur - prev) / prev) * 100, 1)} %` : 'nueva');
  const B = ({ children }: { children: React.ReactNode }) => <span className="font-semibold text-gray-900">{children}</span>;
  const Tone = ({ v, children }: { v: number; children: React.ReactNode }) => <span className={`font-semibold ${v > 0 ? 'text-emerald-700' : v < 0 ? 'text-[#C0392B]' : 'text-gray-500'}`}>{children}</span>;

  const keyPoints = (): React.ReactNode[] => {
    if (!current?.data || !previous?.data) return [];
    const levelName = level === 'ship' ? 'país' : 'Customer Group';
    const licences = codes.filter(c => c !== 'NON-ROYALTY');
    const cur = (c: string) => value(current, c);
    const prev = (c: string) => value(previous, c);
    const tCur = total(current), tPrev = total(previous);
    const points: React.ReactNode[] = [];

    points.push(<>Total {current.year}: <B>{amt(tCur)}</B> frente a {amt(tPrev)} en {previous.year} (<Tone v={tCur - tPrev}>{signed(tCur - tPrev)}, {pctTxt(tCur, tPrev)}</Tone>).</>);

    // Licencias principales: las que suman el 80 % de la venta del año (entre 3 y 6)
    const top: string[] = [];
    let acc = 0;
    for (const c of [...licences].sort((a, b) => cur(b) - cur(a))) {
      if (cur(c) <= 0 || top.length >= 6 || (top.length >= 3 && acc >= 0.8 * tCur)) break;
      top.push(c); acc += cur(c);
    }
    for (const c of top) {
      const d = cur(c) - prev(c);
      const subs = subKeys(c).map(k => ({ k, d: subValue(current, c, k) - subValue(previous, c, k) }));
      const ups = subs.filter(x => x.d > 0).sort((a, b) => b.d - a.d).slice(0, 2);
      const downs = subs.filter(x => x.d < 0).sort((a, b) => a.d - b.d).slice(0, 2);
      const list = (xs: typeof subs) => xs.map((x, i) => <span key={x.k}>{i ? ' y ' : ''}{subLabel(x.k)} (<Tone v={x.d}>{signed(x.d)}</Tone>)</span>);
      points.push(
        <>
          <B>{c}</B>: {amt(cur(c))} ({tCur ? num((cur(c) / tCur) * 100, 1) : 0} % del total), <Tone v={d}>{signed(d)} ({pctTxt(cur(c), prev(c))})</Tone> vs {previous.year}.
          {ups.length > 0 && <> Sube sobre todo en {list(ups)}.</>}
          {downs.length > 0 && <> Baja en {list(downs)}.</>}
        </>
      );
    }

    // Mayores movimientos entre todas las licencias
    const moves = licences.map(c => ({ c, d: cur(c) - prev(c) }));
    const up = moves.filter(m => m.d > 0).sort((a, b) => b.d - a.d)[0];
    const down = moves.filter(m => m.d < 0).sort((a, b) => a.d - b.d)[0];
    if (up || down) points.push(<>
      {up && <>Mayor subida: <B>{up.c}</B> (<Tone v={up.d}>{signed(up.d)}</Tone>). </>}
      {down && <>Mayor caída: <B>{down.c}</B> (<Tone v={down.d}>{signed(down.d)}</Tone>).</>}
    </>);

    // Mayores movimientos por país / Customer Group sumando todas las licencias
    const bySub: Record<string, number> = {};
    for (const c of licences) for (const k of subKeys(c)) bySub[k] = (bySub[k] || 0) + subValue(current, c, k) - subValue(previous, c, k);
    const subMoves = Object.entries(bySub).filter(([, d]) => d);
    const subUp = subMoves.filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const subDown = subMoves.filter(([, d]) => d < 0).sort((a, b) => a[1] - b[1]).slice(0, 3);
    if (subUp.length || subDown.length) points.push(<>
      Por {levelName}, todas las licencias:
      {subUp.length > 0 && <> crecen {subUp.map(([k, d], i) => <span key={k}>{i ? ', ' : ''}<B>{subLabel(k)}</B> (<Tone v={d}>{signed(d)}</Tone>)</span>)}.</>}
      {subDown.length > 0 && <> Caen {subDown.map(([k, d], i) => <span key={k}>{i ? ', ' : ''}<B>{subLabel(k)}</B> (<Tone v={d}>{signed(d)}</Tone>)</span>)}.</>}
    </>);

    // Licencias nuevas o sin venta este año
    const fresh = licences.filter(c => cur(c) > 0 && !prev(c));
    const lost = licences.filter(c => prev(c) > 0 && !cur(c));
    if (fresh.length) points.push(<>Licencias nuevas en {current.year} (sin venta en el mismo periodo de {previous.year}): {fresh.map((c, i) => <span key={c}>{i ? ', ' : ''}<B>{c}</B> ({amt(cur(c))})</span>)}.</>);
    if (lost.length) points.push(<>Sin venta en {current.year} (sí en {previous.year}): {lost.map((c, i) => <span key={c}>{i ? ', ' : ''}<B>{c}</B> ({amt(prev(c))})</span>)}.</>);
    return points;
  };

  const exportExcel = () => {
    const unit = measure === 'turnover' ? `${measureLabel(key)} ${currency}` : 'Unidades';
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
    const subName = level === 'ship' ? 'País' : 'Customer Group';
    const subRows = codes.flatMap(code => subKeys(code).map(k => {
      const row: Record<string, string | number | null> = { 'Royalty Code': code, [subName]: subLabel(k) };
      years.forEach(y => { row[`${unit} ${y.year}`] = subValue(y, code, k); });
      if (current && previous) {
        const { d, pct } = delta(subValue(current, code, k), subValue(previous, code, k));
        row[`Δ ${current.year} vs ${previous.year}`] = d;
        row[`Δ % ${current.year} vs ${previous.year}`] = pct == null ? null : pct;
      }
      return row;
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Ventas por licencia');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(subRows), `Por ${subName}`.substring(0, 31));
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
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Comparar
          <select value={key} onChange={e => setKey(e.target.value as MeasureKey)}
            className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal">
            {MEASURES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Desglose</span>
          <div className="flex bg-gray-100 rounded-lg p-1">
            {([['ship', 'País (Ship-to)'], ['group', 'Customer Group']] as const).map(([id, label]) => (
              <button key={id} onClick={() => setLevel(id)}
                className={`px-3 py-1 rounded-md text-sm font-semibold ${level === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                {label}
              </button>
            ))}
          </div>
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

      {noAmount && <ErrorBox message="El servicio de la LM en BC no publica el campo Amount: no se puede comparar por Amount. Publica el campo en la página 60000 o usa Turnover Net of Provision Sales." />}
      {key === 'provision' && years.some(y => y.data?.ratesSource === 'lm') && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">No se ha podido leer RoyaltiesCRZ de BC: la provisión es la que trae la LM.</p>}
      {shipFromBill && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">El servicio de la LM en BC no publica el país de envío (Ship-to Country/Region Code): el desglose por país usa el país de facturación.</p>}
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
                    <th className={`${th} text-left`}>
                      <button onClick={() => setOpen(allOpen(codes) ? {} : Object.fromEntries(codes.map(c => [c, true])))} className="flex items-center gap-1 uppercase hover:text-gray-900" title="Desplegar o plegar todos">
                        {allOpen(codes) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        Royalty Code <span className="normal-case tracking-normal font-normal">→ {level === 'ship' ? 'país' : 'Customer Group'}</span>
                      </button>
                    </th>
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
                    <Fragment key={code}>
                      <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => setOpen(o => ({ ...o, [code]: !o[code] }))}>
                        <td className={`${td} font-semibold text-gray-900`}>
                          <span className="inline-flex items-center gap-1">
                            {open[code] ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                            {code}
                          </span>
                        </td>
                        {years.map(y => <td key={y.year} className={`${td} text-right ${y === current ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{fmtV(value(y, code))}</td>)}
                        {current && previous && <Delta cur={value(current, code)} prev={value(previous, code)} />}
                      </tr>
                      {open[code] && subKeys(code).map(k => (
                        <tr key={`${code}|${k}`} className="border-b border-gray-100 bg-gray-50/60 text-[12px]">
                          <td className={`${td} pl-10 text-gray-600`}>{subLabel(k)}</td>
                          {years.map(y => <td key={y.year} className={`${td} text-right text-gray-600`}>{fmtV(subValue(y, code, k))}</td>)}
                          {current && previous && <Delta cur={subValue(current, code, k)} prev={subValue(previous, code, k)} />}
                        </tr>
                      ))}
                    </Fragment>
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
            {current && previous && (
              <div className="rpt-card bg-white rounded-xl border border-gray-200 p-5">
                <p className="text-xs font-bold uppercase tracking-widest text-[#C8186C] mb-3">
                  Puntos clave · {current.year} vs {previous.year} · por {level === 'ship' ? 'país' : 'Customer Group'}
                </p>
                <ul className="space-y-2 text-sm text-gray-700 list-disc pl-5">
                  {keyPoints().map((p, i) => <li key={i}>{p}</li>)}
                </ul>
                <p className="mt-3 text-xs text-gray-400">Calculado con las cifras de la tabla ({measureLabel(key)}). Cambia el desglose para verlo por {level === 'ship' ? 'Customer Group' : 'país'}.</p>
              </div>
            )}
            <p className="text-xs text-gray-500">
              Importes en la divisa de la empresa ({currency}), {key === 'provision' ? 'Provision Royalties (Turnover × % de la licencia en RoyaltiesCRZ, como en Royalties)' : `${measureLabel(key)} de la LM de BC`}. Cada año se compara del 1 de enero a la misma fecha.
              Las licencias se asignan con el Royalty Code actual de la ficha del artículo, también en los años anteriores.
            </p>
          </>
        )}
    </Section>
  );
}
