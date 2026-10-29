'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { AlertCircle, ArrowDown, ArrowUp, Download, RefreshCw, Search } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

type Row = {
  company?: string; code: string; country: string; item: string; desc: string;
  qty: number; turnover: number; price: number; provision: number; rate: number; lines: number;
  turnoverFob: number; domestic: number | null; fob: number | null;
};
type Report = {
  from: string; to: string; company: string; rows: Row[];
  source: 'bc'; service?: string; itemsError?: string | null;
  currency: string; fx: { rate: number | null; date: string | null; error: string | null } | null;
  ratesSource?: 'bc' | 'lm'; ratesBcError?: string | null;
  stats: { lines: number; ic: { lines: number; turnover: number; provision: number }; noItemCard: string[]; noRate: string[];
    excluded: { codes: string[]; lines: number; turnover: number } };
};
type SortKey = 'company' | 'code' | 'country' | 'item' | 'desc' | 'qty' | 'turnover' | 'price' | 'provision' | 'domestic' | 'fob';

const NOT_APPLIED = 'NON-ROYALTY';
// Empresas del grupo (GROUP_COMPANIES de src/lib/royalties.ts)
const GROUP = ['CRAZE', 'Craze Iberia SL', 'Craze UK', 'CRAZE Group AG', 'Craze Entertainment'];
const iso = (d: Date) => d.toISOString().substring(0, 10);

// Trimestre natural: offset 0 = el actual, -1 = el anterior
function quarter(offset: number) {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3) + offset;
  return { from: iso(new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1))), to: iso(new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0))) };
}
// Trimestre q (1–4) de un año
const qRange = (y: number, q: number) => ({ from: iso(new Date(Date.UTC(y, q * 3 - 3, 1))), to: iso(new Date(Date.UTC(y, q * 3, 0))) });
const yearToDate = () => ({ from: `${new Date().getUTCFullYear()}-01-01`, to: iso(new Date()) });

const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const money = (v: number) => nf.format(v || 0);
const pct = (v: number) => `${nf.format((v || 0) * 100)} %`;
const pctOrDash = (v: number | null) => (v == null ? '—' : pct(v));
const dateEs = (d: string) => d.split('-').reverse().join('/');

const COLUMNS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: 'company', label: 'Empresa' },
  { key: 'code', label: 'Royalty Code' },
  { key: 'country', label: 'País fact.' },
  { key: 'item', label: 'Nº' },
  { key: 'desc', label: 'Descripción' },
  { key: 'qty', label: 'Cantidad', num: true },
  { key: 'turnover', label: 'Turnover neto de provisión', num: true },
  { key: 'price', label: 'Precio por unidad', num: true },
  { key: 'provision', label: 'Provisión royalties', num: true },
  { key: 'domestic', label: '% Domestic', num: true },
  { key: 'fob', label: '% FOB', num: true },
];

const sum = (rows: Row[], k: 'qty' | 'turnover' | 'turnoverFob' | 'provision') => rows.reduce((s, r) => s + r[k], 0);

export default function RoyaltiesPage() {
  const { selectedCompany } = useCompany();
  const [range, setRange] = useState(() => quarter(-1));
  const [reload, setReload] = useState({ n: 0, force: false });
  // Empresas del informe (una o varias; todas = CRAZE Consolidated, en EUR). Arranca con la del menú.
  const [companies, setCompanies] = useState<string[]>([]);
  useEffect(() => { setCompanies(selectedCompany === 'ALL' ? GROUP : [selectedCompany]); }, [selectedCompany]);
  const multi = companies.length > 1;
  const [reports, setReports] = useState<Record<string, Report>>({});
  const [errors, setErrors] = useState<Record<string, { message: string; details?: any }>>({});
  const [loading, setLoading] = useState(false);

  const [codeFilter, setCodeFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [hideNotApplied, setHideNotApplied] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  // Conversión a EUR (UK en GBP, AG en CHF): tipo de BC, editable
  const [inEur, setInEur] = useState(false);

  // Cada empresa se pide por separado (cada llamada a BC dentro de los 60 s de Vercel); se guardan por empresa y periodo
  const keyOf = (c: string) => `${c}|${range.from}|${range.to}`;
  const forcedRun = useRef(0);   // el botón de actualizar fuerza BC una sola vez, no en cada cambio de empresas
  useEffect(() => {
    if (!companies.length || !range.from || !range.to || range.from > range.to) return;
    const force = reload.force && forcedRun.current !== reload.n;
    forcedRun.current = reload.n;
    const missing = companies.filter(c => force || (!reports[keyOf(c)] && !errors[keyOf(c)]));
    if (!missing.length) return;
    let cancelled = false;
    setLoading(true);
    Promise.all(missing.map(async c => {
      try {
        const res = await fetch(`/api/royalties?company=${encodeURIComponent(c)}&from=${range.from}&to=${range.to}${force ? '&force=1' : ''}`);
        const json = await res.json();
        return res.ok ? { c, report: json as Report } : { c, error: { message: json.error || 'Error al cargar los royalties', details: json.details } };
      } catch (e: any) {
        return { c, error: { message: e.message as string } };
      }
    })).then(results => {
      if (cancelled) return;
      setReports(prev => { const next = { ...prev }; results.forEach(r => { if (r.report) next[keyOf(r.c)] = r.report; else delete next[keyOf(r.c)]; }); return next; });
      setErrors(prev => { const next = { ...prev }; results.forEach(r => { if (r.error) next[keyOf(r.c)] = r.error; else delete next[keyOf(r.c)]; }); return next; });
      setLoading(false);
    });
    return () => { cancelled = true; setLoading(false); };
  }, [companies, range, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = companies.map(c => reports[keyOf(c)]).filter(Boolean) as Report[];
  const failed = companies.filter(c => errors[keyOf(c)]).map(c => ({ company: c, ...errors[keyOf(c)] }));
  const data = loaded[0] || null;

  // Tipos de cambio a EUR (Currencies_Excel de CRAZE GmbH), editables por divisa
  const [fxInputs, setFxInputs] = useState<Record<string, string>>({});
  useEffect(() => {
    setFxInputs(prev => {
      const next = { ...prev };
      loaded.forEach(r => { if (r.fx?.rate && !next[r.currency]) next[r.currency] = String(r.fx.rate).replace('.', ','); });
      return next;
    });
  }, [loaded.map(r => r.company).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const rateOf = (c: string) => (c === 'EUR' ? 1 : parseFloat((fxInputs[c] || '').replace(',', '.')) || 0);
  const localCur = multi ? 'EUR' : data?.currency || 'EUR';
  const canConvert = localCur !== 'EUR' && rateOf(localCur) > 0;
  const toEur = multi || (inEur && canConvert);
  const cur = toEur ? 'EUR' : localCur;
  const factorOf = (r: Report) => (toEur ? rateOf(r.currency) || 1 : 1);
  const missingFx = multi ? Array.from(new Set(loaded.map(r => r.currency).filter(c => !rateOf(c)))) : [];
  const fxNote = toEur ? Array.from(new Set(loaded.map(r => r.currency).filter(c => c !== 'EUR'))).map(c => `1 ${c} = ${fxInputs[c]} EUR`).join(', ') : '';
  const rows = useMemo(
    () => loaded.flatMap(rep => {
      const f = factorOf(rep);
      return rep.rows.map(r => ({ ...r, company: rep.company, turnover: r.turnover * f, turnoverFob: r.turnoverFob * f, provision: r.provision * f, price: r.price * f }));
    }),
    [loaded.map(r => `${r.company}${r.from}${r.to}${r.rows.length}`).join('|'), fxInputs, toEur] // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Avisos y estadísticas de todas las empresas cargadas
  const stats = {
    ic: loaded.reduce((a, r) => ({ lines: a.lines + r.stats.ic.lines, turnover: a.turnover + r.stats.ic.turnover * factorOf(r), provision: a.provision + r.stats.ic.provision * factorOf(r) }), { lines: 0, turnover: 0, provision: 0 }),
    noRate: Array.from(new Set(loaded.flatMap(r => r.stats.noRate))),
    noItemCard: Array.from(new Set(loaded.flatMap(r => r.stats.noItemCard))),
    excluded: loaded.filter(r => r.stats.excluded.codes.length),
  };
  const companiesLabel = companies.length === GROUP.length ? 'CRAZE Consolidated' : companies.map(c => (multi ? SHORT[c] || c : c)).join(' + ');
  const columns = COLUMNS.filter(c => multi || c.key !== 'company');
  const codes = useMemo(() => Array.from(new Set(rows.map(r => r.code))).sort(byCode), [rows]);
  const countries = useMemo(() => Array.from(new Set(rows.map(r => r.country))).sort(), [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows.filter(r =>
      (!codeFilter || r.code === codeFilter) &&
      (!countryFilter || r.country === countryFilter) &&
      (!hideNotApplied || r.code !== NOT_APPLIED) &&
      (!q || r.item.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q)));
    return list.sort((a, b) => {
      if (sort) {
        const va = a[sort.key], vb = b[sort.key];
        const num = COLUMNS.find(c => c.key === sort.key)?.num;
        return (num ? ((va as number | null) ?? -1) - ((vb as number | null) ?? -1) : String(va).localeCompare(String(vb))) * sort.dir;
      }
      return byCode(a.code, b.code) || (a.company || '').localeCompare(b.company || '') || a.country.localeCompare(b.country) || a.item.localeCompare(b.item);
    });
  }, [rows, codeFilter, countryFilter, hideNotApplied, search, sort]);

  // Resumen por Royalty Code (sobre el filtro de país y búsqueda, no sobre el de código)
  const byCodeSummary = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = rows.filter(r => (!countryFilter || r.country === countryFilter) && (!q || r.item.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q)));
    const map = new Map<string, Row[]>();
    base.forEach(r => map.set(r.code, [...(map.get(r.code) || []), r]));
    return Array.from(map.entries())
      .map(([code, list]) => ({
        code, n: list.length, qty: sum(list, 'qty'), turnover: sum(list, 'turnover'), turnoverFob: sum(list, 'turnoverFob'),
        provision: sum(list, 'provision'), domestic: list[0].domestic, fob: list[0].fob,
      }))
      .sort((a, b) => (a.code === NOT_APPLIED ? 1 : b.code === NOT_APPLIED ? -1 : b.provision - a.provision));
  }, [rows, countryFilter, search]);
  const codeTotal = byCodeSummary.reduce((t, c) => ({ n: t.n + c.n, qty: t.qty + c.qty, turnover: t.turnover + c.turnover, turnoverFob: t.turnoverFob + c.turnoverFob, provision: t.provision + c.provision }),
    { n: 0, qty: 0, turnover: 0, turnoverFob: 0, provision: 0 });

  const totals = { qty: sum(visible, 'qty'), turnover: sum(visible, 'turnover'), provision: sum(visible, 'provision') };
  const licensed = visible.filter(r => r.code !== NOT_APPLIED);
  const licensedTurnover = sum(licensed, 'turnover');

  const toggleSort = (key: SortKey) =>
    setSort(s => (!s || s.key !== key ? { key, dir: COLUMNS.find(c => c.key === key)?.num ? -1 : 1 } : s.dir === -1 ? { key, dir: 1 } : null));

  const exportExcel = () => {
    const aoa: any[][] = [
      [`ROYALTIES ${companiesLabel} · ${dateEs(range.from)} – ${dateEs(range.to)} · ${cur}${fxNote ? ` (${fxNote})` : ''}`],
      [...(multi ? ['Company'] : []), 'Royalty Code', 'Bill-to Country/Region Code', 'No.', 'Description', 'Quantity', 'Turnover Net of Provision Sales', 'of which FOB', 'Price Per Unit', 'Provision Royalties', '% Domestic Royalty', '% Fob Royalty'],
      ...visible.map(r => [...(multi ? [r.company] : []), r.code, r.country, r.item, r.desc, r.qty, r.turnover, r.turnoverFob, r.price, r.provision, r.domestic, r.fob]),
      [...(multi ? [''] : []), 'Total', '', '', '', totals.qty, totals.turnover, sum(visible, 'turnoverFob'), null, totals.provision, null, null],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let r = 2; r < aoa.length; r++) {
      for (const c0 of [4, 5, 6, 7, 8, 9, 10]) {
        const c = c0 + (multi ? 1 : 0);
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.t === 'n') cell.z = c0 === 4 ? '#,##0' : c0 >= 9 ? '0.00%' : '#,##0.00';
      }
    }
    ws['!cols'] = [...(multi ? [{ wch: 20 }] : []), { wch: 24 }, { wch: 10 }, { wch: 12 }, { wch: 50 }, { wch: 12 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Royalties');
    XLSX.writeFile(wb, `Royalties_${companiesLabel}_${range.from}_${range.to}_${cur}.xlsx`.replace(/\s+/g, '_'));
  };

  const presets = [
    { label: 'Último trimestre', ...quarter(-1) },
    { label: 'Trimestre actual', ...quarter(0) },
    { label: 'Año en curso', ...yearToDate() },
  ];
  // Selector Q1–Q4 del año de la fecha de inicio
  const qYear = Number(range.from.substring(0, 4)) || new Date().getUTCFullYear();
  const activeQ = [1, 2, 3, 4].find(q => { const r = qRange(qYear, q); return r.from === range.from && r.to === range.to; });
  const thisYear = new Date().getUTCFullYear();
  const qYears = Array.from(new Set([thisYear - 3, thisYear - 2, thisYear - 1, thisYear, qYear])).sort();

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg">Royalties</p>
            <p className="text-xs text-gray-500">{companiesLabel} · {dateEs(range.from)} – {dateEs(range.to)} · importes en {cur}{fxNote ? ` (${fxNote})` : ''} · Royalty Code de la ficha de artículo (CRAZE GmbH) · sin Main Item ni intercompañía</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex bg-gray-100 rounded-lg p-1">
              {presets.map(p => (
                <button key={p.label} onClick={() => setRange({ from: p.from, to: p.to })}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold ${range.from === p.from && range.to === p.to ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center bg-gray-100 rounded-lg p-1">
              <select value={qYear} onChange={e => setRange(qRange(Number(e.target.value), activeQ || 1))}
                className="bg-transparent text-xs font-semibold text-gray-900 px-1 py-1.5 focus:outline-none" title="Año del trimestre">
                {qYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              {[1, 2, 3, 4].map(q => (
                <button key={q} onClick={() => setRange(qRange(qYear, q))}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold ${activeQ === q ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                  Q{q}
                </button>
              ))}
            </div>
            <input type="date" value={range.from} max={range.to} onChange={e => e.target.value && setRange(r => ({ ...r, from: e.target.value }))}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" />
            <span className="text-gray-400 text-sm">–</span>
            <input type="date" value={range.to} min={range.from} onChange={e => e.target.value && setRange(r => ({ ...r, to: e.target.value }))}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" />
            {multi && Array.from(new Set(loaded.map(r => r.currency).filter(c => c !== 'EUR'))).map(c => (
              <label key={c} className="flex items-center gap-1 text-xs text-gray-500" title="Tipo de Currencies_Excel (CRAZE GmbH), editable">
                1 {c} =
                <input value={fxInputs[c] || ''} onChange={e => setFxInputs(f => ({ ...f, [c]: e.target.value }))} inputMode="decimal" placeholder="tipo"
                  className="w-20 border border-gray-300 rounded-md px-2 py-1 text-sm font-semibold text-gray-900 bg-white text-right" />
                EUR
              </label>
            ))}
            {!multi && localCur !== 'EUR' && (
              <div className="flex items-center gap-2">
                <div className="flex bg-gray-100 rounded-lg p-1">
                  {[localCur, 'EUR'].map(c => (
                    <button key={c} onClick={() => setInEur(c === 'EUR')} disabled={c === 'EUR' && !canConvert}
                      title={c === 'EUR' && !canConvert ? 'Indica el tipo de cambio' : `Ver importes en ${c}`}
                      className={`px-3 py-1.5 rounded-md text-xs font-semibold disabled:opacity-40 ${cur === c ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                      {c}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-1 text-xs text-gray-500"
                  title={data?.fx?.rate ? `Tipo de Currencies_Excel (CRAZE GmbH)${data.fx.date ? ' del ' + dateEs(data.fx.date) : ''}` : data?.fx?.error || ''}>
                  1 {localCur} =
                  <input value={fxInputs[localCur] || ''} onChange={e => setFxInputs(f => ({ ...f, [localCur]: e.target.value }))} inputMode="decimal" placeholder="tipo"
                    className="w-20 border border-gray-300 rounded-md px-2 py-1 text-sm font-semibold text-gray-900 bg-white text-right" />
                  EUR
                </label>
              </div>
            )}
            <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={loading} title="Volver a leer de Business Central"
              className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={exportExcel} disabled={loading || !visible.length}
              className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
              <Download size={16} /> Exportar Excel
            </button>
          </div>
        </div>
        <div className="w-full px-4 md:px-8 pb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold uppercase tracking-wider text-gray-500 mr-1">CRAZE Company</span>
          <button onClick={() => setCompanies(GROUP)}
            className={`px-3 py-1.5 rounded-full border font-semibold ${companies.length === GROUP.length ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-300 hover:text-gray-900'}`}>
            CRAZE Consolidated
          </button>
          {GROUP.map(c => {
            const on = companies.includes(c);
            return (
              <button key={c} title={on && companies.length > 1 ? 'Quitar del informe' : 'Añadir al informe (clic con Alt: solo esta)'}
                onClick={e => setCompanies(prev => (e.altKey ? [c] : on ? (prev.length > 1 ? prev.filter(x => x !== c) : prev) : GROUP.filter(x => x === c || prev.includes(x))))}
                className={`px-3 py-1.5 rounded-full border font-semibold ${on ? 'bg-indigo-50 text-indigo-700 border-indigo-300' : 'bg-white text-gray-500 border-gray-300 hover:text-gray-900'}`}>
                {on ? '✓ ' : ''}{SHORT[c] || c}
              </button>
            );
          })}
          {multi && <span className="text-gray-500 ml-1">Varias empresas: importes en EUR</span>}
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-6 space-y-6">
        {selectedCompany === 'CRAZE' && <GroupSummary range={range} reload={reload} />}
        {failed.map(f => (
          <div key={f.company}>
            {multi && <p className="text-sm font-semibold text-gray-900 mb-1">{f.company}</p>}
            <SetupError error={f} />
          </div>
        ))}
        {missingFx.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
            Falta el tipo de cambio a EUR de {missingFx.join(', ')}: esos importes se muestran sin convertir.
          </div>
        )}
        {loading && !loaded.length ? (
          <p className="text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Leyendo líneas de royalties de Business Central…</p>
        ) : data && (
          <>
            {loading && <p className="text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Leyendo las demás empresas de Business Central…</p>}
            {loaded.some(r => r.ratesSource === 'lm') && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
                No se han podido leer los % de royalty de RoyaltiesCRZ (CRAZE GmbH): la provisión mostrada es la que calcula la LM de BC, sin recalcular.
                {loaded.find(r => r.ratesBcError)?.ratesBcError && <span className="block text-xs mt-1">{loaded.find(r => r.ratesBcError)!.ratesBcError}</span>}
              </div>
            )}
            {stats.excluded.map(r => (
              <div key={r.company} className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700">
                {r.company} no puede vender <b>{r.stats.excluded.codes.join(', ')}</b>: excluido del informe
                ({r.stats.excluded.lines} líneas, turnover {money(r.stats.excluded.turnover * factorOf(r))} {cur}).
              </div>
            ))}
            {stats.noRate.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
                Royalty Codes sin % en RoyaltiesCRZ (no provisionan): <b>{stats.noRate.join(', ')}</b>
              </div>
            )}
            {loaded.find(r => r.itemsError) ? (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800 flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <div>
                  No se han podido leer los Royalty Codes de las fichas de artículo de CRAZE GmbH: se muestran los de la LM, que pueden no ser correctos.
                  <span className="block text-xs mt-1">{loaded.find(r => r.itemsError)!.itemsError}</span>
                </div>
              </div>
            ) : stats.noItemCard.length > 0 && (
              <details className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700">
                <summary className="cursor-pointer">{stats.noItemCard.length} artículos no existen en CRAZE GmbH: se usa su Royalty Code de la LM.</summary>
                <p className="mt-2 font-mono text-xs break-words">{stats.noItemCard.join(', ')}</p>
              </details>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Kpi label={`Provisión royalties (${cur})`} value={money(totals.provision)} sub={licensedTurnover ? `${pct(totals.provision / licensedTurnover)} sobre ventas con licencia` : undefined} />
              <Kpi label={`Turnover neto de provisión (${cur})`} value={money(totals.turnover)} sub={`Con licencia: ${money(licensedTurnover)}`} />
              <Kpi label="Cantidad" value={qf.format(totals.qty)} sub={`${visible.length} líneas de artículo`} />
              <Kpi label={`Excluido intercompañía (${cur})`} value={money(stats.ic.turnover)}
                sub={`${stats.ic.lines} líneas · provisión ${money(stats.ic.provision)}`} />
            </div>

            <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <h2 className="px-4 py-3 text-sm font-bold text-gray-900 border-b border-gray-200">Resumen por Royalty Code</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
                    <tr>
                      <th className="text-left px-4 py-2">Royalty Code</th>
                      <th className="text-right px-4 py-2">Artículos</th>
                      <th className="text-right px-4 py-2">Cantidad</th>
                      <th className="text-right px-4 py-2">Turnover neto</th>
                      <th className="text-right px-4 py-2">de ello FOB</th>
                      <th className="text-right px-4 py-2">% Domestic</th>
                      <th className="text-right px-4 py-2">% FOB</th>
                      <th className="text-right px-4 py-2">Provisión royalties</th>
                      <th className="text-right px-4 py-2">% efectivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCodeSummary.map(c => (
                      <tr key={c.code} onClick={() => setCodeFilter(f => (f === c.code ? '' : c.code))}
                        className={`border-t border-gray-100 cursor-pointer hover:bg-gray-50 ${codeFilter === c.code ? 'bg-indigo-50' : ''} ${c.code === NOT_APPLIED ? 'text-gray-500' : 'text-gray-900'}`}>
                        <td className="px-4 py-2 font-semibold">{c.code}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{c.n}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{qf.format(c.qty)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{money(c.turnover)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600">{c.turnoverFob ? money(c.turnoverFob) : '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{pctOrDash(c.domestic)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{pctOrDash(c.fob)}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold">{money(c.provision)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{c.turnover ? pct(c.provision / c.turnover) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  {byCodeSummary.length > 0 && (
                    <tfoot className="bg-gray-50 font-bold text-gray-900">
                      <tr className="border-t-2 border-gray-300">
                        <td className="px-4 py-2">TOTAL</td>
                        <td className="px-4 py-2 text-right tabular-nums">{codeTotal.n}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{qf.format(codeTotal.qty)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{money(codeTotal.turnover)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{codeTotal.turnoverFob ? money(codeTotal.turnoverFob) : '—'}</td>
                        <td className="px-4 py-2" colSpan={2} />
                        <td className="px-4 py-2 text-right tabular-nums">{money(codeTotal.provision)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{codeTotal.turnover ? pct(codeTotal.provision / codeTotal.turnover) : '—'}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </section>

            <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-3">
                <h2 className="text-sm font-bold text-gray-900 mr-auto">Detalle por artículo y país</h2>
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Nº o descripción"
                    className="border border-gray-300 rounded-lg pl-8 pr-3 py-1.5 text-sm w-52" />
                </div>
                <select value={codeFilter} onChange={e => setCodeFilter(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white">
                  <option value="">Todos los Royalty Codes</option>
                  {codes.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={countryFilter} onChange={e => setCountryFilter(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white">
                  <option value="">Todos los países</option>
                  {countries.map(c => <option key={c} value={c}>{c || '(sin país)'}</option>)}
                </select>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={hideNotApplied} onChange={e => setHideNotApplied(e.target.checked)} />
                  Ocultar NON-ROYALTY
                </label>
                <button onClick={exportExcel} disabled={loading || !visible.length} title="Descargar esta tabla (con los filtros aplicados) en Excel"
                  className="flex items-center gap-1.5 border border-gray-300 bg-white text-gray-700 text-sm font-semibold px-3 py-1.5 rounded-lg hover:bg-gray-50 disabled:opacity-40">
                  <Download size={14} /> Excel
                </button>
              </div>
              <div className="overflow-x-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500 sticky top-0">
                    <tr>
                      {columns.map(c => (
                        <th key={c.key} onClick={() => toggleSort(c.key)}
                          className={`px-3 py-2 cursor-pointer select-none whitespace-nowrap hover:text-gray-900 ${c.num ? 'text-right' : 'text-left'}`}>
                          <span className="inline-flex items-center gap-1">
                            {c.label}
                            {sort?.key === c.key && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(r => (
                      <tr key={`${r.company}|${r.code}|${r.country}|${r.item}`} className={`border-t border-gray-100 ${r.code === NOT_APPLIED ? 'text-gray-500' : 'text-gray-900'}`}>
                        {multi && <td className="px-3 py-1.5 whitespace-nowrap">{SHORT[r.company || ''] || r.company}</td>}
                        <td className="px-3 py-1.5 whitespace-nowrap">{r.code}</td>
                        <td className="px-3 py-1.5">{r.country}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{r.item}</td>
                        <td className="px-3 py-1.5 min-w-[260px]">{r.desc}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{qf.format(r.qty)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(r.turnover)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(r.price)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{money(r.provision)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{pctOrDash(r.domestic)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{pctOrDash(r.fob)}</td>
                      </tr>
                    ))}
                    {!visible.length && (
                      <tr><td colSpan={columns.length} className="px-3 py-6 text-center text-gray-500">No hay líneas de royalties para este periodo y filtros.</td></tr>
                    )}
                  </tbody>
                  {visible.length > 0 && (
                    <tfoot className="bg-gray-50 font-bold text-gray-900 sticky bottom-0">
                      <tr className="border-t-2 border-gray-300">
                        <td className="px-3 py-2" colSpan={multi ? 5 : 4}>Total</td>
                        <td className="px-3 py-2 text-right tabular-nums">{qf.format(totals.qty)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(totals.turnover)}</td>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-right tabular-nums">{money(totals.provision)}</td>
                        <td className="px-3 py-2" colSpan={2} />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </section>
            <p className="text-xs text-gray-500">
              Fuente: página 60000 &quot;AIT Documents LM Components&quot; de Business Central (servicio {data.service}), sin líneas Main Item ni intercompañía. Royalty Code de la ficha de artículo y provisión = turnover × % Domestic Royalty de RoyaltiesCRZ (% FOB en envíos FOB), ambos de CRAZE GmbH. Precio por unidad = turnover ÷ cantidad; % efectivo = provisión ÷ turnover.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

// ---------- Resumen de grupo (en CRAZE) ----------

type GroupCompany = {
  company: string; currency: string; fx: number | null; fxDate: string | null; byCode: Record<string, number>;
  byCodeCountry: Record<string, Record<string, number>>;
  error: string | null; source: 'bc' | null;
};
const SHORT: Record<string, string> = { 'CRAZE': 'CRAZE GmbH', 'Craze Iberia SL': 'Iberia', 'Craze UK': 'UK', 'CRAZE Group AG': 'Group AG', 'Craze Entertainment': 'Entertainment' };

function GroupSummary({ range, reload }: { range: { from: string; to: string }; reload: { n: number; force: boolean } }) {
  const [companies, setCompanies] = useState<GroupCompany[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fx, setFx] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!range.from || !range.to || range.from > range.to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/royalties/group?from=${range.from}&to=${range.to}${reload.force ? '&force=1' : ''}`)
      .then(async res => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(json.error || 'Error al cargar el resumen del grupo'); return; }
        setCompanies(json.companies);
        // Tipos de BC como valor inicial (editables); se mantienen los que ya se hayan escrito
        setFx(prev => {
          const next = { ...prev };
          (json.companies as GroupCompany[]).forEach(c => {
            if (c.currency !== 'EUR' && !next[c.currency] && c.fx) next[c.currency] = String(c.fx).replace('.', ',');
          });
          return next;
        });
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range, reload]);

  const rate = (cur: string) => (cur === 'EUR' ? 1 : parseFloat((fx[cur] || '').replace(',', '.')) || 0);
  // Solo las empresas con datos en BC
  const cols = (companies || []).filter(c => !c.error && Object.keys(c.byCode).length > 0);
  const omitted = (companies || []).filter(c => !cols.includes(c)).map(c => SHORT[c.company] || c.company);
  const currencies = Array.from(new Set(cols.map(c => c.currency).filter(c => c !== 'EUR')));
  const codes = Array.from(new Set(cols.flatMap(c => Object.keys(c.byCode)))).filter(c => c !== NOT_APPLIED)
    .map(code => {
      const values = cols.map(c => (c.byCode[code] || 0) * rate(c.currency));
      return { code, values, total: values.reduce((a, b) => a + b, 0) };
    })
    .filter(r => r.values.some(v => Math.abs(v) >= 0.005))
    .sort((a, b) => b.total - a.total);
  const colTotals = cols.map((_, i) => codes.reduce((s, r) => s + r.values[i], 0));
  const grand = colTotals.reduce((a, b) => a + b, 0);
  const missingFx = currencies.filter(c => !rate(c));

  const exportExcel = () => {
    const aoa: any[][] = [
      [`PROVISIÓN ROYALTIES GRUPO (EUR) · ${dateEs(range.from)} – ${dateEs(range.to)} · ${currencies.map(c => `1 ${c} = ${fx[c]} EUR`).join(' · ')}`],
      ['Royalty Code', ...cols.map(c => SHORT[c.company] || c.company), 'Total'],
      ...codes.map(r => [r.code, ...r.values, r.total]),
      ['Total', ...colTotals, grand],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let r = 2; r < aoa.length; r++) for (let c = 1; c <= cols.length + 1; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === 'n') cell.z = '#,##0.00';
    }
    ws['!cols'] = [{ wch: 24 }, ...cols.map(() => ({ wch: 14 })), { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Grupo');
    XLSX.writeFile(wb, `Royalties_Grupo_${range.from}_${range.to}_EUR.xlsx`);
  };

  return (
    <>
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-bold text-gray-900 mr-auto">
          Provisión royalties del grupo por licencia (EUR)
          {loading && <RefreshCw size={12} className="inline ml-2 animate-spin text-gray-400" />}
        </h2>
        {currencies.map(c => (
          <label key={c} className="flex items-center gap-1 text-xs text-gray-500"
            title={(() => { const d = cols.find(x => x.currency === c)?.fxDate; return `Tipo de Currencies_Excel (CRAZE GmbH)${d ? ' del ' + dateEs(d) : ''}`; })()}>
            1 {c} =
            <input value={fx[c] || ''} onChange={e => setFx(f => ({ ...f, [c]: e.target.value }))} inputMode="decimal" placeholder="tipo"
              className="w-20 border border-gray-300 rounded-md px-2 py-1 text-sm font-semibold text-gray-900 bg-white text-right" />
            EUR
          </label>
        ))}
        <button onClick={exportExcel} disabled={loading || !codes.length}
          className="flex items-center gap-2 border border-gray-300 bg-white text-gray-700 text-sm font-semibold px-3 py-1.5 rounded-lg hover:text-gray-900 disabled:opacity-40">
          <Download size={14} /> Excel
        </button>
      </div>
      {error ? (
        <p className="px-4 py-3 text-sm text-red-700">{error}</p>
      ) : !companies ? (
        <p className="px-4 py-3 text-sm text-gray-500">Leyendo los royalties de todas las empresas…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Royalty Code</th>
                {cols.map(c => (
                  <th key={c.company} className="text-right px-4 py-2 align-bottom">
                    {SHORT[c.company] || c.company}
                    <span className="block normal-case tracking-normal font-normal text-gray-400">
                      {c.currency !== 'EUR' ? `${c.currency}→EUR` : 'EUR'}
                    </span>
                  </th>
                ))}
                <th className="text-right px-4 py-2 align-bottom">Total</th>
              </tr>
            </thead>
            <tbody>
              {codes.map(r => (
                <tr key={r.code} className="border-t border-gray-100 text-gray-900">
                  <td className="px-4 py-2 font-semibold whitespace-nowrap">{r.code}</td>
                  {r.values.map((v, i) => <td key={i} className="px-4 py-2 text-right tabular-nums">{v ? money(v) : '—'}</td>)}
                  <td className="px-4 py-2 text-right tabular-nums font-semibold">{money(r.total)}</td>
                </tr>
              ))}
              {!codes.length && (
                <tr><td colSpan={cols.length + 2} className="px-4 py-6 text-center text-gray-500">No hay provisión de royalties en el grupo para este periodo.</td></tr>
              )}
            </tbody>
            {codes.length > 0 && (
              <tfoot className="bg-gray-50 font-bold text-gray-900">
                <tr className="border-t-2 border-gray-300">
                  <td className="px-4 py-2">Total</td>
                  {colTotals.map((v, i) => <td key={i} className="px-4 py-2 text-right tabular-nums">{money(v)}</td>)}
                  <td className="px-4 py-2 text-right tabular-nums">{money(grand)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {omitted.length > 0 && companies && (
        <p className="px-4 py-2 border-t border-gray-100 text-xs text-gray-500">Sin datos para el periodo (no se muestran): {omitted.join(', ')}.</p>
      )}
      {missingFx.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-100 text-xs text-amber-800 bg-amber-50 space-y-0.5">
          {missingFx.length > 0 && <p>Falta el tipo de cambio de {missingFx.join(', ')}: esas empresas suman 0 hasta que lo indiques.</p>}
        </div>
      )}
    </section>
    <MgSummary to={range.to} reload={reload} rate={rate} fxReady={c => !!rate(c)} />
    </>
  );
}

// ---------- Minimum Guarantees (en CRAZE) ----------

type MgInstalment = { date: string; amount: number; label: string };
type MgGuarantee = { id: string; territory: string; countries: string[] | 'ALL_EXCEPT'; exceptCountries?: string[]; instalments: MgInstalment[] };
type MgContract = {
  id: string; licence: string; owner: string; codes: string[]; licensor: string; licensee: string; reference: string;
  start: string; end: string; rates: string; notes?: string; guarantees: MgGuarantee[];
};
const countsCountry = (g: MgGuarantee, country: string) =>
  g.countries === 'ALL_EXCEPT' ? !(g.exceptCountries || []).includes(country) : g.countries.includes(country);

type MgCompany = Omit<GroupCompany, 'byCode' | 'byCodeCountry'> & { dated: Record<string, Record<string, Record<string, number>>> };

function MgSummary({ to, reload, rate, fxReady }: {
  to: string; reload: { n: number; force: boolean }; rate: (cur: string) => number; fxReady: (cur: string) => boolean;
}) {
  const [data, setData] = useState<{ contracts: MgContract[]; companies: MgCompany[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/royalties/mg?to=${to}${reload.force ? '&force=1' : ''}`)
      .then(async res => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(json.error || 'Error al cargar las Minimum Guarantees');
        else setData(json);
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [to, reload]);

  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <h2 className="text-sm font-bold text-gray-900">
          Minimum Guarantees por licencia (EUR)
          {loading && <RefreshCw size={12} className="inline ml-2 animate-spin text-gray-400" />}
        </h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Provisión de royalties de todas las empresas del grupo desde el inicio de cada contrato hasta el {dateEs(to)}, asignada a cada garantía por país de facturación.
          Solo la MG ya activa a esa fecha puede consumirse; la provisión que la supere la debería facturar el licenciante.
        </p>
      </div>
      {error ? <p className="px-4 py-3 text-sm text-red-700">{error}</p>
        : !data ? <p className="px-4 py-3 text-sm text-gray-500">Calculando las Minimum Guarantees…</p>
        : (
          <div className="divide-y divide-gray-200">
            {[...data.contracts].sort((a, b) => companyOrder(a.owner) - companyOrder(b.owner) || a.licence.localeCompare(b.licence)).map(c => <MgContractCard key={c.id} contract={c} companies={data.companies} to={to} rate={rate} fxReady={fxReady} />)}
          </div>
        )}
    </section>
  );
}

const companyOrder = (company: string) => { const i = Object.keys(SHORT).indexOf(company); return i < 0 ? 99 : i; };

// Día anterior a una fecha YYYY-MM-DD
const dayBefore = (d: string) => new Date(Date.parse(d) - 86400000).toISOString().substring(0, 10);

function MgContractCard({ contract: c, companies, to, rate, fxReady }: {
  contract: MgContract; companies: MgCompany[]; to: string; rate: (cur: string) => number; fxReady: (cur: string) => boolean;
}) {
  const withData = companies.filter(x => !x.error && x.source);
  // Provisión (EUR) de los códigos de la licencia por país y fecha, desde el inicio del contrato
  const byCountryDate: Record<string, Record<string, number>> = {};
  for (const co of withData) {
    const r = rate(co.currency);
    for (const code of c.codes) {
      for (const [country, dates] of Object.entries(co.dated?.[code] || {})) {
        for (const [date, v] of Object.entries(dates)) {
          if (date < c.start || date > to) continue;
          const m = (byCountryDate[country] ||= {});
          m[date] = (m[date] || 0) + v * r;
        }
      }
    }
  }
  const countryTotal = (country: string) => Object.values(byCountryDate[country] || {}).reduce((a, b) => a + b, 0);
  const outside = Object.keys(byCountryDate).filter(country => !c.guarantees.some(g => countsCountry(g, country))).map(k => [k, countryTotal(k)] as const);
  const outsideTotal = outside.reduce((s, [, v]) => s + v, 0);
  const missingFx = Array.from(new Set(withData.map(x => x.currency))).filter(cur => cur !== 'EUR' && !fxReady(cur));

  return (
    <div className="px-4 py-4 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-base font-bold text-gray-900">{c.licence}</h3>
        <span className="text-xs font-semibold text-indigo-700 bg-indigo-50 rounded px-2 py-0.5">Contrato de {SHORT[c.owner] || c.owner}</span>
        <span className="text-xs text-gray-500">{c.codes.join(' + ')}</span>
        <span className="text-xs text-gray-500">{c.licensor} · {c.reference}</span>
        <span className="text-xs text-gray-500">Contrato {dateEs(c.start)} – {dateEs(c.end)} · {c.rates}</span>
      </div>
      {c.start > to ? <p className="text-sm text-gray-500">El contrato empieza después de la fecha de corte.</p> : (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
          {c.guarantees.map(g => {
            // Provisión del territorio entre dos fechas (incluidas)
            const provisionBetween = (from: string, until: string) => Object.entries(byCountryDate)
              .filter(([country]) => countsCountry(g, country))
              .reduce((s, [, dates]) => s + Object.entries(dates).filter(([d]) => d >= from && d <= until).reduce((a, [, v]) => a + v, 0), 0);
            const instalments = [...g.instalments].sort((a, b) => a.date.localeCompare(b.date));
            const total = instalments.reduce((s, i) => s + i.amount, 0);
            // Cada plazo abre un periodo hasta el siguiente plazo (o la fecha de corte). La MG se activa en su fecha y
            // se acumula con la no consumida de plazos anteriores; la provisión del periodo va a MG mientras quede MG
            // activa y el resto se factura. El primer periodo empieza en el inicio del contrato.
            let pool = 0;
            const rows = instalments.map((i, k) => {
              const due = i.date <= to;
              if (!due) return { ...i, due, from: '', until: '', provision: 0, toMg: 0, toInvoice: 0, open: i.amount };
              const from = k === 0 ? c.start : i.date;
              const next = instalments[k + 1];
              const until = next && next.date <= to ? dayBefore(next.date) : to;
              pool += i.amount;
              const provision = provisionBetween(from, until);
              const toMg = provision < 0 ? provision : Math.min(provision, pool);
              pool -= toMg;
              return { ...i, due, from, until, provision, toMg, toInvoice: provision - toMg, open: pool };
            });
            const sumOf = (f: (r: typeof rows[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
            const active = rows.filter(r => r.due).reduce((s, r) => s + r.amount, 0);
            const future = total - active;
            const provision = sumOf(r => r.provision), toMg = sumOf(r => r.toMg), toInvoice = sumOf(r => r.toInvoice);
            return (
              <div key={g.id} className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex flex-wrap items-baseline gap-x-3">
                  <span className="text-sm font-semibold text-gray-900">{g.territory}</span>
                  <span className="text-xs text-gray-500">MG total {money(total)} · activa a {dateEs(to)}: {money(active)} · futura: {money(future)}</span>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-wider text-gray-500 whitespace-nowrap">
                    <tr>
                      <th className="text-left px-3 py-1.5">Vencimiento</th>
                      <th className="text-left px-3 py-1.5">Concepto</th>
                      <th className="text-left px-3 py-1.5">Periodo</th>
                      <th className="text-right px-3 py-1.5">Minimum Guarantee</th>
                      <th className="text-right px-3 py-1.5">Provision Royalty</th>
                      <th className="text-right px-3 py-1.5">Royalty to MG</th>
                      <th className="text-right px-3 py-1.5">Royalty to Invoice</th>
                      <th className="text-right px-3 py-1.5">MG abierta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className={`border-t border-gray-100 ${r.due ? 'text-gray-900' : 'text-gray-500'}`}>
                        <td className="px-3 py-1.5 whitespace-nowrap">{dateEs(r.date)}</td>
                        <td className="px-3 py-1.5">{r.label}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-xs">{r.due ? `${dateEs(r.from)} – ${dateEs(r.until)}` : <span className="uppercase text-[10px]">futura</span>}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(r.amount)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.due ? money(r.provision) : '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.due ? money(r.toMg) : '—'}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${r.toInvoice > 0.005 ? 'text-amber-800 font-semibold' : ''}`}>{r.due ? money(r.toInvoice) : '—'}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${!r.due ? '' : r.open > 0.005 ? 'font-semibold' : 'text-green-700'}`}>
                          {!r.due ? money(r.open) : r.open > 0.005 ? money(r.open) : 'Consumida'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 font-bold text-gray-900">
                    <tr className="border-t-2 border-gray-300">
                      <td className="px-3 py-2" colSpan={3}>Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(total)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(provision)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(toMg)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${toInvoice > 0.005 ? 'text-amber-800' : ''}`}>{money(toInvoice)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(active - toMg)}</td>
                    </tr>
                  </tfoot>
                </table>
                </div>
                <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-600">
                  Provision Royalty {money(provision)} = Royalty to MG {money(toMg)} + Royalty to Invoice {money(toInvoice)}.
                  {toInvoice > 0.005
                    ? <span className="text-amber-800"> El licenciante debería facturar {money(toInvoice)} (provisión por encima de la MG activa en su periodo).</span>
                    : <> Quedan {money(active - toMg)} de MG activa por consumir antes de que facturen royalties.</>}
                  {future > 0 && <> MG futura (aún no activa): {money(future)}.</>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {(c.notes || outsideTotal !== 0 || missingFx.length > 0) && (
        <div className="text-xs text-gray-500 space-y-0.5">
          {c.notes && <p>{c.notes}</p>}
          {outsideTotal !== 0 && (
            <p>Provisión fuera de los territorios con garantía (no consume MG): {money(outsideTotal)} ({outside.map(([k, v]) => `${k || 'sin país'} ${money(v)}`).join(', ')}).</p>
          )}
          {missingFx.length > 0 && <p className="text-amber-800">Falta el tipo de cambio de {missingFx.join(', ')}: esas empresas no suman.</p>}
        </div>
      )}
    </div>
  );
}

// NON-ROYALTY siempre al final
function byCode(a: string, b: string) {
  if (a === b) return 0;
  if (a === NOT_APPLIED) return 1;
  if (b === NOT_APPLIED) return -1;
  return a.localeCompare(b);
}

function Kpi({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`bg-white rounded-xl border p-4 ${warn ? 'border-amber-300' : 'border-gray-200'}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 tabular-nums mt-1">{value}</p>
      {sub && <p className={`text-xs mt-1 ${warn ? 'text-amber-700' : 'text-gray-500'}`}>{sub}</p>}
    </div>
  );
}

function SetupError({ error }: { error: { message: string; details?: any } }) {
  const d = error.details;
  const list: string[] | undefined = d?.availableFields || (d?.odataServices && [...d.odataServices, ...(d.apiEntities || [])]);
  return (
    <div className="bg-white border border-red-200 rounded-xl p-4 space-y-2">
      <p className="text-sm font-semibold text-red-700 flex items-center gap-2"><AlertCircle size={16} /> {error.message}</p>
      {list && list.length > 0 && (
        <details className="text-xs text-gray-600">
          <summary className="cursor-pointer">{d.availableFields ? 'Campos disponibles en el servicio' : 'Servicios disponibles en Business Central'} ({list.length})</summary>
          <p className="mt-2 font-mono break-words">{list.join(', ')}</p>
        </details>
      )}
    </div>
  );
}
