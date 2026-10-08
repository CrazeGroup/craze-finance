'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { AlertCircle, ArrowDown, ArrowUp, Download, FileSpreadsheet, RefreshCw, Search, Upload } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

type Row = {
  code: string; country: string; item: string; desc: string;
  qty: number; turnover: number; price: number; provision: number; rate: number; lines: number;
  turnoverFob: number; domestic: number | null; fob: number | null;
};
type Report = {
  from: string; to: string; company: string; rows: Row[];
  source: 'bc' | 'excel'; service?: string; bcError?: string | null; itemsError?: string | null;
  currency: string; fx: { rate: number | null; date: string | null; error: string | null } | null;
  ratesSource?: 'bc' | 'excel' | 'default'; ratesInfo?: string | null; ratesBcError?: string | null;
  upload?: { fileName: string; uploadedAt: string; from: string; to: string; hasShipment: boolean };
  stats: { lines: number; ic: { lines: number; turnover: number; provision: number }; noItemCard: string[]; noRate: string[];
    excluded: { codes: string[]; lines: number; turnover: number } };
};
type SortKey = 'code' | 'country' | 'item' | 'desc' | 'qty' | 'turnover' | 'price' | 'provision' | 'domestic' | 'fob';

const NOT_APPLIED = 'NOT APPLIED';
const iso = (d: Date) => d.toISOString().substring(0, 10);

// Trimestre natural: offset 0 = el actual, -1 = el anterior
function quarter(offset: number) {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3) + offset;
  return { from: iso(new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1))), to: iso(new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0))) };
}
const yearToDate = () => ({ from: `${new Date().getUTCFullYear()}-01-01`, to: iso(new Date()) });

const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const money = (v: number) => nf.format(v || 0);
const pct = (v: number) => `${nf.format((v || 0) * 100)} %`;
const pctOrDash = (v: number | null) => (v == null ? '—' : pct(v));
const dateEs = (d: string) => d.split('-').reverse().join('/');

const COLUMNS: { key: SortKey; label: string; num?: boolean }[] = [
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

// Lee la exportación a Excel de la página 60000 "Documents LM Components" y deja solo lo necesario
// (sin líneas Main Item), con las descripciones por artículo aparte para que el envío sea pequeño
async function parseLmExcel(file: File) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  // La hoja de datos (puede haber otras, p. ej. una tabla dinámica añadida)
  const sheet = wb.SheetNames.map(n => XLSX.utils.sheet_to_json<any[]>(wb.Sheets[n], { header: 1, defval: null }))
    .find(r => (r[0] || []).some((h: any) => String(h ?? '').trim() === 'Royalty Code'));
  const rows = sheet || [];
  const header = (rows[0] || []).map((h: any) => String(h ?? '').trim());
  const col = (name: string) => header.indexOf(name);
  const C = {
    date: col('Posting Date'), code: col('Royalty Code'), country: col('Bill-to Country/Region Code'), item: col('No.'),
    desc: col('Description'), qty: col('Quantity'), turnover: col('Turnover Net of Provision Sales'), provision: col('Provision Royalties'),
    main: col('Main Item'), custNo: col('Bill-to Customer No.'), custName: col('Bill-to Customer Name'),
    dim: col('Customer Dimension Name'), vatBus: col('VAT Bus. Posting Group'), ship: col('Shipment Method Code'),
  };
  const missing = Object.entries(C).filter(([k, i]) => i < 0 && !['dim', 'vatBus', 'ship'].includes(k)).map(([k]) => k);
  if (missing.length) throw new Error(`El Excel no parece una exportación de "Documents LM Components" (faltan columnas: ${missing.join(', ')}).`);

  const toIso = (v: any): string => {
    if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`; }
    const t = String(v ?? '').trim();
    const m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : t.substring(0, 10);
  };
  const s = (v: any) => (v == null ? '' : String(v).trim());
  const n = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
  const isMain = (v: any) => v === true || v === 1 || v === '1' || v === 'true' || v === 'Sí' || v === 'Yes';

  const desc: Record<string, string> = {};
  const lines: any[][] = [];
  for (const r of rows.slice(1)) {
    if (!r || r[C.item] == null || isMain(r[C.main])) continue;
    const item = s(r[C.item]);
    if (!desc[item]) desc[item] = s(r[C.desc]);
    lines.push([toIso(r[C.date]), s(r[C.code]), s(r[C.country]), item, n(r[C.qty]), n(r[C.turnover]), n(r[C.provision]),
      s(r[C.custNo]), s(r[C.custName]), C.dim >= 0 ? s(r[C.dim]) : '', C.vatBus >= 0 ? s(r[C.vatBus]) : '', C.ship >= 0 ? s(r[C.ship]) : '']);
  }
  const dates = lines.map(l => l[0] as string).filter(Boolean).sort();
  return { fileName: file.name, from: dates[0] || '', to: dates[dates.length - 1] || '', desc, lines };
}

// Excel de la página 80007 "Royalties" de BC: % de royalty por Royalty Code (null si no es ese Excel)
async function parseRatesExcel(file: File) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
  const header = (rows[0] || []).map((h: any) => String(h ?? '').trim());
  const code = header.indexOf('Code'), dom = header.indexOf('% Domestic Royalty'), fob = header.indexOf('% Fob Royalty');
  if (code < 0 || dom < 0) return null;
  const n = (v: any) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')) || 0);
  const rates: Record<string, { domestic: number; fob: number }> = {};
  for (const r of rows.slice(1)) {
    const c = String(r?.[code] ?? '').trim().toUpperCase();
    if (c) rates[c] = { domestic: n(r[dom]) / 100, fob: n(r[fob >= 0 ? fob : dom]) / 100 };
  }
  return { kind: 'rates', fileName: file.name, rates };
}

const sum = (rows: Row[], k: 'qty' | 'turnover' | 'turnoverFob' | 'provision') => rows.reduce((s, r) => s + r[k], 0);

export default function RoyaltiesPage() {
  const { selectedCompany } = useCompany();
  const [range, setRange] = useState(() => quarter(-1));
  const [reload, setReload] = useState({ n: 0, force: false });
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; details?: any } | null>(null);

  const [codeFilter, setCodeFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [hideNotApplied, setHideNotApplied] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [uploading, setUploading] = useState(false);
  // Conversión a EUR (UK en GBP, AG en CHF): tipo de BC, editable
  const [inEur, setInEur] = useState(false);
  const [fxInput, setFxInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadExcel = async (file: File) => {
    setUploading(true);
    try {
      const payload = (await parseRatesExcel(file)) || (await parseLmExcel(file));
      const res = await fetch('/api/royalties/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Error al subir el Excel (${res.status})`);
      setReload(r => ({ n: r.n + 1, force: false }));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  useEffect(() => {
    if (selectedCompany === 'ALL' || !range.from || !range.to || range.from > range.to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/royalties?from=${range.from}&to=${range.to}${reload.force ? '&force=1' : ''}`)
      .then(async res => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError({ message: json.error || 'Error al cargar los royalties', details: json.details }); setData(null); }
        else setData(json);
      })
      .catch(e => { if (!cancelled) setError({ message: e.message }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCompany, range, reload]);

  useEffect(() => {
    setFxInput(data?.fx?.rate ? String(data.fx.rate).replace('.', ',') : '');
  }, [data?.fx?.rate]);
  const localCur = data?.currency || 'EUR';
  const fxRate = parseFloat(fxInput.replace(',', '.'));
  const canConvert = localCur !== 'EUR' && fxRate > 0;
  const factor = inEur && canConvert ? fxRate : 1;
  const cur = inEur && canConvert ? 'EUR' : localCur;
  const rows = useMemo(
    () => (data?.rows || []).map(r => (factor === 1 ? r : { ...r, turnover: r.turnover * factor, turnoverFob: r.turnoverFob * factor, provision: r.provision * factor, price: r.price * factor })),
    [data, factor]
  );
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
      return byCode(a.code, b.code) || a.country.localeCompare(b.country) || a.item.localeCompare(b.item);
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

  const totals = { qty: sum(visible, 'qty'), turnover: sum(visible, 'turnover'), provision: sum(visible, 'provision') };
  const licensed = visible.filter(r => r.code !== NOT_APPLIED);
  const licensedTurnover = sum(licensed, 'turnover');

  const toggleSort = (key: SortKey) =>
    setSort(s => (!s || s.key !== key ? { key, dir: COLUMNS.find(c => c.key === key)?.num ? -1 : 1 } : s.dir === -1 ? { key, dir: 1 } : null));

  const exportExcel = () => {
    const aoa: any[][] = [
      [`ROYALTIES ${selectedCompany} · ${dateEs(range.from)} – ${dateEs(range.to)} · ${cur}${cur !== localCur ? ` (1 ${localCur} = ${fxInput} EUR)` : ''}`],
      ['Royalty Code', 'Bill-to Country/Region Code', 'No.', 'Description', 'Quantity', 'Turnover Net of Provision Sales', 'of which FOB', 'Price Per Unit', 'Provision Royalties', '% Domestic Royalty', '% Fob Royalty'],
      ...visible.map(r => [r.code, r.country, r.item, r.desc, r.qty, r.turnover, r.turnoverFob, r.price, r.provision, r.domestic, r.fob]),
      ['Total', '', '', '', totals.qty, totals.turnover, sum(visible, 'turnoverFob'), null, totals.provision, null, null],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let r = 2; r < aoa.length; r++) {
      for (const c of [4, 5, 6, 7, 8, 9, 10]) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.t === 'n') cell.z = c === 4 ? '#,##0' : c >= 9 ? '0.00%' : '#,##0.00';
      }
    }
    ws['!cols'] = [{ wch: 24 }, { wch: 10 }, { wch: 12 }, { wch: 50 }, { wch: 12 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Royalties');
    XLSX.writeFile(wb, `Royalties_${selectedCompany}_${range.from}_${range.to}_${cur}.xlsx`.replace(/\s+/g, '_'));
  };

  const presets = [
    { label: 'Último trimestre', ...quarter(-1) },
    { label: 'Trimestre actual', ...quarter(0) },
    { label: 'Año en curso', ...yearToDate() },
  ];

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="max-w-[1800px] mx-auto px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg">Royalties</p>
            <p className="text-xs text-gray-500">{selectedCompany} · {dateEs(range.from)} – {dateEs(range.to)} · importes en {cur}{cur !== localCur ? ` (1 ${localCur} = ${fxInput} EUR)` : ''} · Royalty Code de la ficha de artículo (CRAZE GmbH) · sin Main Item ni intercompañía</p>
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
            <input type="date" value={range.from} max={range.to} onChange={e => e.target.value && setRange(r => ({ ...r, from: e.target.value }))}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" />
            <span className="text-gray-400 text-sm">–</span>
            <input type="date" value={range.to} min={range.from} onChange={e => e.target.value && setRange(r => ({ ...r, to: e.target.value }))}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" />
            {localCur !== 'EUR' && (
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
                  <input value={fxInput} onChange={e => setFxInput(e.target.value)} inputMode="decimal" placeholder="tipo"
                    className="w-20 border border-gray-300 rounded-md px-2 py-1 text-sm font-semibold text-gray-900 bg-white text-right" />
                  EUR
                </label>
              </div>
            )}
            <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={loading} title="Volver a leer de Business Central"
              className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => e.target.files?.[0] && uploadExcel(e.target.files[0])} />
            <button onClick={() => fileRef.current?.click()} disabled={uploading || selectedCompany === 'ALL'} title='Cargar la exportación a Excel de "Documents LM Components" (líneas de la empresa) o de "Royalties" (% por Royalty Code)'
              className="flex items-center gap-2 border border-gray-300 bg-white text-gray-700 text-sm font-semibold px-3 py-2 rounded-lg hover:text-gray-900 disabled:opacity-40">
              <Upload size={16} className={uploading ? 'animate-pulse' : ''} /> {uploading ? 'Cargando…' : 'Cargar Excel'}
            </button>
            <button onClick={exportExcel} disabled={loading || !visible.length}
              className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
              <Download size={16} /> Exportar Excel
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto px-4 md:px-8 pt-6 space-y-6">
        {selectedCompany === 'CRAZE' && <GroupSummary range={range} reload={reload} />}
        {selectedCompany === 'ALL' ? (
          <p className="text-sm text-gray-600">Selecciona una empresa concreta en el menú lateral para ver sus royalties.</p>
        ) : error ? (
          <SetupError error={error} />
        ) : loading && !data ? (
          <p className="text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Leyendo líneas de royalties de Business Central…</p>
        ) : data && (
          <>
            {data.source === 'excel' && data.upload && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
                <FileSpreadsheet size={16} className="mt-0.5 shrink-0" />
                <div>
                  Datos del Excel <b>{data.upload.fileName}</b> (cargado el {new Date(data.upload.uploadedAt).toLocaleString('es-ES')}, líneas del {dateEs(data.upload.from)} al {dateEs(data.upload.to)}), no de Business Central en directo.
                  {(range.from < data.upload.from || range.to > data.upload.to) && <> El periodo elegido sale del rango del Excel: las fechas fuera de él no tienen datos.</>}
                  {!data.upload.hasShipment && (
                    <b className="block mt-1">Este Excel se cargó sin la condición de envío: las ventas FOB se están calculando con el % Domestic. Vuelve a cargarlo para aplicar el % FOB.</b>
                  )}
                  {data.bcError && <span className="block text-xs text-amber-700 mt-1">BC: {data.bcError}</span>}
                </div>
              </div>
            )}
            {data.ratesSource && data.ratesSource !== 'bc' && (
              <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700">
                % de royalty tomados de {data.ratesSource === 'excel' ? <>el Excel <b>{data.ratesInfo}</b></> : <>la <b>{data.ratesInfo}</b></>}, no de RoyaltiesCRZ en directo.
                Para actualizarlos, carga con &quot;Cargar Excel&quot; la exportación de la página Royalties de CRAZE GmbH.
                {data.ratesBcError && <span className="block text-xs text-gray-500 mt-1">BC: {data.ratesBcError}</span>}
              </div>
            )}
            {data.stats.excluded.codes.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700">
                {selectedCompany} no puede vender <b>{data.stats.excluded.codes.join(', ')}</b>: excluido del informe
                ({data.stats.excluded.lines} líneas, turnover {money(data.stats.excluded.turnover * factor)} {cur}).
              </div>
            )}
            {data.stats.noRate.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
                Royalty Codes sin % en RoyaltiesCRZ (no provisionan): <b>{data.stats.noRate.join(', ')}</b>
              </div>
            )}
            {data.itemsError ? (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800 flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <div>
                  No se han podido leer los Royalty Codes de las fichas de artículo de CRAZE GmbH: se muestran los de la LM, que pueden no ser correctos.
                  <span className="block text-xs mt-1">{data.itemsError}</span>
                </div>
              </div>
            ) : data.stats.noItemCard.length > 0 && (
              <details className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700">
                <summary className="cursor-pointer">{data.stats.noItemCard.length} artículos no existen en CRAZE GmbH: se usa su Royalty Code de la LM.</summary>
                <p className="mt-2 font-mono text-xs break-words">{data.stats.noItemCard.join(', ')}</p>
              </details>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Kpi label={`Provisión royalties (${cur})`} value={money(totals.provision)} sub={licensedTurnover ? `${pct(totals.provision / licensedTurnover)} sobre ventas con licencia` : undefined} />
              <Kpi label={`Turnover neto de provisión (${cur})`} value={money(totals.turnover)} sub={`Con licencia: ${money(licensedTurnover)}`} />
              <Kpi label="Cantidad" value={qf.format(totals.qty)} sub={`${visible.length} líneas de artículo`} />
              <Kpi label={`Excluido intercompañía (${cur})`} value={money(data.stats.ic.turnover * factor)}
                sub={`${data.stats.ic.lines} líneas · provisión ${money(data.stats.ic.provision * factor)}`} />
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
                  Ocultar NOT APPLIED
                </label>
              </div>
              <div className="overflow-x-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500 sticky top-0">
                    <tr>
                      {COLUMNS.map(c => (
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
                      <tr key={`${r.code}|${r.country}|${r.item}`} className={`border-t border-gray-100 ${r.code === NOT_APPLIED ? 'text-gray-500' : 'text-gray-900'}`}>
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
                      <tr><td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-gray-500">No hay líneas de royalties para este periodo y filtros.</td></tr>
                    )}
                  </tbody>
                  {visible.length > 0 && (
                    <tfoot className="bg-gray-50 font-bold text-gray-900 sticky bottom-0">
                      <tr className="border-t-2 border-gray-300">
                        <td className="px-3 py-2" colSpan={4}>Total</td>
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
              Fuente: página 60000 &quot;AIT Documents LM Components&quot; de Business Central ({data.source === 'bc' ? `servicio ${data.service}` : 'Excel cargado'}), sin líneas Main Item ni intercompañía. Royalty Code de la ficha de artículo y provisión = turnover × % Domestic Royalty de RoyaltiesCRZ (% FOB en envíos FOB), ambos de CRAZE GmbH. Precio por unidad = turnover ÷ cantidad; % efectivo = provisión ÷ turnover.
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
  error: string | null; source: 'bc' | 'excel' | null; upload?: { fileName: string; uploadedAt: string; from: string; to: string };
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
  // Solo las empresas con datos (BC o Excel cargado)
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
                    <span className="block normal-case tracking-normal font-normal text-gray-400"
                      title={c.upload ? `${c.upload.fileName}: ${dateEs(c.upload.from)} – ${dateEs(c.upload.to)}` : ''}>
                      {`${c.source === 'bc' ? 'BC' : 'Excel'}${c.currency !== 'EUR' ? ` · ${c.currency}→EUR` : ''}`}
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
      {(missingFx.length > 0 || cols.some(c => c.upload && (range.from < c.upload.from || range.to > c.upload.to))) && (
        <div className="px-4 py-2 border-t border-gray-100 text-xs text-amber-800 bg-amber-50 space-y-0.5">
          {missingFx.length > 0 && <p>Falta el tipo de cambio de {missingFx.join(', ')}: esas empresas suman 0 hasta que lo indiques.</p>}
          {cols.filter(c => c.upload && (range.from < c.upload.from || range.to > c.upload.to)).map(c => (
            <p key={c.company}>{SHORT[c.company] || c.company}: su Excel cubre del {dateEs(c.upload!.from)} al {dateEs(c.upload!.to)}, no todo el periodo elegido.</p>
          ))}
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

function MgSummary({ to, reload, rate, fxReady }: {
  to: string; reload: { n: number; force: boolean }; rate: (cur: string) => number; fxReady: (cur: string) => boolean;
}) {
  const [data, setData] = useState<{ contracts: MgContract[]; byStart: Record<string, GroupCompany[]> } | null>(null);
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
            {[...data.contracts].sort((a, b) => companyOrder(a.owner) - companyOrder(b.owner) || a.licence.localeCompare(b.licence)).map(c => <MgContractCard key={c.id} contract={c} companies={data.byStart[c.start] || []} to={to} rate={rate} fxReady={fxReady} />)}
          </div>
        )}
    </section>
  );
}

const companyOrder = (company: string) => { const i = Object.keys(SHORT).indexOf(company); return i < 0 ? 99 : i; };

function MgContractCard({ contract: c, companies, to, rate, fxReady }: {
  contract: MgContract; companies: GroupCompany[]; to: string; rate: (cur: string) => number; fxReady: (cur: string) => boolean;
}) {
  const withData = companies.filter(x => !x.error && Object.keys(x.byCodeCountry || {}).length > 0);
  // Provisión (EUR) de los códigos de la licencia por país de facturación
  const byCountry: Record<string, number> = {};
  for (const co of withData) {
    const r = rate(co.currency);
    for (const code of c.codes) {
      for (const [country, v] of Object.entries(co.byCodeCountry[code] || {})) byCountry[country] = (byCountry[country] || 0) + v * r;
    }
  }
  const outside = Object.entries(byCountry).filter(([country]) => !c.guarantees.some(g => countsCountry(g, country)));
  const outsideTotal = outside.reduce((s, [, v]) => s + v, 0);
  const missingFx = Array.from(new Set(withData.map(x => x.currency))).filter(cur => cur !== 'EUR' && !fxReady(cur));
  const lateData = withData.filter(x => x.upload && x.upload.from > c.start);

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
            const provision = Object.entries(byCountry).filter(([country]) => countsCountry(g, country)).reduce((s, [, v]) => s + v, 0);
            const total = g.instalments.reduce((s, i) => s + i.amount, 0);
            let remaining = Math.max(0, provision);
            // Solo la MG ya activa a la fecha de corte puede consumirse; lo que la supera se factura
            const rows = [...g.instalments].sort((a, b) => a.date.localeCompare(b.date)).map(i => {
              const due = i.date <= to;
              const consumed = due ? Math.min(i.amount, remaining) : 0;
              remaining -= consumed;
              return { ...i, consumed, open: i.amount - consumed, due };
            });
            const consumed = rows.reduce((s, r) => s + r.consumed, 0);
            const active = rows.filter(r => r.due).reduce((s, r) => s + r.amount, 0);
            const future = total - active;
            const toInvoice = Math.max(0, provision - active);
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
                      <th className="text-right px-3 py-1.5">Minimum Guarantee</th>
                      <th className="text-right px-3 py-1.5">Provisión mata MG</th>
                      <th className="text-right px-3 py-1.5">MG abierta</th>
                      <th className="text-right px-3 py-1.5">Provisión a facturar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className={`border-t border-gray-100 ${r.due ? 'text-gray-900' : 'text-gray-500'}`}>
                        <td className="px-3 py-1.5 whitespace-nowrap">{dateEs(r.date)}</td>
                        <td className="px-3 py-1.5">{r.label}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(r.amount)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.consumed ? money(r.consumed) : '—'}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${!r.due ? '' : r.open ? 'font-semibold' : 'text-green-700'}`}>
                          {!r.due ? <span title={`Se activa el ${dateEs(r.date)}`}>{money(r.open)} <span className="text-[10px] uppercase">futura</span></span> : r.open ? money(r.open) : 'Consumida'}
                        </td>
                        <td className="px-3 py-1.5" />
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 font-bold text-gray-900">
                    <tr className="border-t-2 border-gray-300">
                      <td className="px-3 py-2" colSpan={2}>Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(total)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(consumed)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(active - consumed)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${toInvoice ? 'text-amber-800' : ''}`}>{money(toInvoice)}</td>
                    </tr>
                  </tfoot>
                </table>
                </div>
                <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-600">
                  Provisión royalties acumulada: <b>{money(provision)}</b> = mata MG {money(consumed)} + a facturar {money(toInvoice)}.
                  {toInvoice > 0
                    ? <span className="text-amber-800"> La MG activa a {dateEs(to)} ya está consumida: el licenciante debería facturar {money(toInvoice)}.</span>
                    : <> Quedan {money(active - consumed)} de MG activa por consumir antes de que facturen royalties.</>}
                  {future > 0 && <> MG futura (aún no activa): {money(future)}.</>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {(c.notes || outsideTotal !== 0 || missingFx.length > 0 || lateData.length > 0) && (
        <div className="text-xs text-gray-500 space-y-0.5">
          {c.notes && <p>{c.notes}</p>}
          {outsideTotal !== 0 && (
            <p>Provisión fuera de los territorios con garantía (no consume MG): {money(outsideTotal)} ({outside.map(([k, v]) => `${k || 'sin país'} ${money(v)}`).join(', ')}).</p>
          )}
          {missingFx.length > 0 && <p className="text-amber-800">Falta el tipo de cambio de {missingFx.join(', ')}: esas empresas no suman.</p>}
          {lateData.map(x => (
            <p key={x.company} className="text-amber-800">{SHORT[x.company] || x.company}: su Excel empieza el {dateEs(x.upload!.from)}; faltan los royalties desde el {dateEs(c.start)}.</p>
          ))}
        </div>
      )}
    </div>
  );
}

// NOT APPLIED siempre al final
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
