'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, FileDown, Pencil, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import DocPdfLink from '@/components/DocPdfLink';
import { useCompany } from '@/contexts/CompanyContext';
import { Check, code, Item, LineNote, nf0, nf2, noteKey, STATUS, StatusBadges, TariffTable } from './TariffCheck';

// Aduanas · Histórico: facturas Zoll del año (/api/customs/history), vista por código arancelario declarado con los
// artículos importados en cada uno, o por declaración (AT/C) con el detalle de cada una.
type Entry = {
  atc: string; file: string; date: string; orders: string[]; transport: string[]; zoll: number; eust: number;
  check: Check | null; warnings: string[]; error?: string; computedAt: string; dhl?: boolean;
  invoiceNo: string; postingDate: string; status: string; amount: number;
};
type Manual = { orders: string[]; transport: string[]; by?: string; at: string };
type Data = { company: string; year: number; vendor: string; total: number; pending: number; entries: Entry[]; notes?: Record<string, LineNote>; manual?: Record<string, Manual> };

// Orden de gravedad: el peor estado de un artículo en un código es el que se muestra
const SEVERITY: Item['status'][] = ['ok', 'ok8', 'sin_codigo', 'sin_ficha', 'distinto'];
const worst = (a: Item['status'], b: Item['status']) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a);
const BAD = new Set<Item['status']>(['distinto', 'sin_codigo', 'sin_ficha']);

type CodeItem = { no: string; description: string; bcTariff: string; bcRate: number | null; qty: number; atcs: Set<string>; status: Item['status'] };
type CodeRow = {
  tariff: string; rates: Set<number>; atcs: Set<string>; positions: number; value: number; duty: number; items: Map<string, CodeItem>;
};

const dateEs = (d: string) => (d ? d.split('-').reverse().join('.') : '—');
const VIEW_KEY = 'aduanas:historico:vista';
// Última carga guardada en el navegador (por empresa y año), para pintar al momento al volver a la pestaña
const cacheKey = (company: string, year: number) => `aduanas:historico:datos:${company}:${year}`;
// La lista llega resumida: la descripción de cada artículo va una sola vez en descriptions; se vuelve a poner en cada línea
function hydrate(json: any): Data {
  const d: Record<string, string> = json.descriptions || {};
  if (!json.compact) return json;
  const fill = (i: any) => ({ ...i, description: i.description || d[i.no] || '' });
  return {
    ...json,
    entries: (json.entries || []).map((e: any) => (!e.check ? e : {
      ...e, check: { ...e.check, positions: e.check.positions.map((p: any) => ({ ...p, items: p.items.map(fill) })), unassigned: e.check.unassigned.map(fill) },
    })),
  };
}
const th = 'p-2 text-left text-xs uppercase tracking-wider text-gray-500 font-semibold whitespace-nowrap';

export default function HistoryView() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [view, setView] = useState<'code' | 'atc'>('code');
  useEffect(() => { try { if (localStorage.getItem(VIEW_KEY) === 'atc') setView('atc'); } catch {} }, []);
  const changeView = (v: 'code' | 'atc') => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch {} };
  const run = useRef(0);

  const { selectedCompany } = useCompany();
  // Comprobando en BC si hay facturas Zoll nuevas, con lo guardado ya en pantalla
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Detalle completo de cada AT/C desplegado (descripciones y Positionsbefund de las posiciones)
  const [details, setDetails] = useState<Record<string, Entry>>({});
  const show = (json: any) => {
    const d = hydrate(json);
    setData(d);
    try { localStorage.setItem(cacheKey(selectedCompany, year), JSON.stringify(json)); } catch { /* sin espacio o sin almacenamiento */ }
    return d;
  };

  // Carga completa: pregunta a BC por las facturas Zoll y lee los PDF nuevos; va llamando hasta que no quedan pendientes
  // (cada llamada procesa los que caben en ~40 s). background = con lo guardado ya en pantalla (sin bloquear la página)
  const load = async (recompute?: string, background = false) => {
    const id = ++run.current;
    if (background) setChecking(true); else setLoading(true);
    setError(null);
    const before = new Set((data?.entries || []).map(e => e.atc));
    try {
      let param = recompute;
      let lastPending = Infinity;
      for (;;) {
        const res = await fetch(`/api/customs/history?year=${year}${param ? `&recompute=${encodeURIComponent(param)}` : ''}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        if (id !== run.current) return;
        // Con PDF pendientes de leer, se pasa a mostrar el progreso
        if (json.pending) { setChecking(false); setLoading(true); }
        const d = show(json);
        param = undefined;
        if (!json.pending || json.pending >= lastPending) {
          const added = before.size ? d.entries.filter(e => !before.has(e.atc)).length : 0;
          if (added) setNotice(`${added} ${added === 1 ? 'declaración nueva leída' : 'declaraciones nuevas leídas'} de BC`);
          break;
        }
        lastPending = json.pending;
      }
    } catch (e: any) {
      if (id === run.current) setError(e.message);
    } finally {
      if (id === run.current) { setLoading(false); setChecking(false); }
    }
  };

  // Al abrir: 1) lo de la última vez en este navegador, 2) lo guardado en la base de datos (sin BC, al momento),
  // 3) la comprobación con BC en segundo plano
  useEffect(() => {
    let cancelled = false;
    setData(null); setDetails({}); setNotice(null);
    try {
      const cached = localStorage.getItem(cacheKey(selectedCompany, year));
      if (cached) setData(hydrate(JSON.parse(cached)));
    } catch { /* caché dañada o sin almacenamiento */ }
    (async () => {
      let hasStored = false;
      try {
        const res = await fetch(`/api/customs/history?year=${year}&stored=1`, { cache: 'no-store' });
        const json = await res.json();
        if (!cancelled && res.ok && json.stored) { show(json); hasStored = true; }
      } catch { /* se sigue con la carga completa */ }
      if (!cancelled) load(undefined, hasStored);
    })();
    return () => { cancelled = true; };
  }, [year, selectedCompany]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detalle de un AT/C al desplegarlo (y de nuevo tras volver a leer su PDF o cambiar su pedido)
  const loadDetail = async (atc: string) => {
    try {
      const res = await fetch(`/api/customs/history?year=${year}&atc=${encodeURIComponent(atc)}`, { cache: 'no-store' });
      const json = await res.json();
      if (res.ok && json.entry) setDetails(d => ({ ...d, [atc]: json.entry }));
    } catch { /* se queda con el resumen */ }
  };
  const reread = async (atc: string) => { setDetails(({ [atc]: _x, ...rest }) => rest); await load(atc); await loadDetail(atc); };

  const [busy, setBusy] = useState<string | null>(null);
  // Pedido / factura de China y contenedor a mano (AT/C en edición)
  const [editing, setEditing] = useState<{ atc: string; orders: string; transport: string } | null>(null);
  const saveManual = async () => {
    if (!editing) return;
    try {
      const res = await fetch('/api/customs/history/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editing) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'No se ha podido guardar');
      const atc = editing.atc;
      setEditing(null);
      await reread(atc);
    } catch (e: any) { setError(e.message); }
  };
  const notes = useMemo(() => data?.notes || {}, [data]);
  // Actualizar un artículo con su ficha de BC (en todas las declaraciones) y notas por línea
  const refreshItem = async (no: string) => {
    setBusy(no);
    try {
      const res = await fetch('/api/customs/history/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ no }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'No se ha podido actualizar el artículo');
      // Solo se sustituyen las declaraciones que han cambiado (sin volver a leer todo el histórico)
      const changed: Record<string, Entry['check']> = json.checks || {};
      setData(d => (d ? { ...d, entries: d.entries.map(x => (changed[x.atc] ? { ...x, check: changed[x.atc] } : x)) } : d));
      setDetails(ds => Object.fromEntries(Object.entries(ds).map(([a, x]) => [a, changed[a] ? { ...x, check: changed[a] } : x])));
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const saveNote = async (key: string, note: { ignored: boolean; approved?: boolean; comment: string }) => {
    try {
      const res = await fetch('/api/customs/history/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, ...note }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'No se ha podido guardar');
      setData(d => (d ? { ...d, notes: json.notes } : d));
    } catch (e: any) { setError(e.message); }
  };
  // Las líneas descartadas no cuentan (fuera de los resúmenes, contadores y "solo lo que hay que revisar"); las dadas por
  // buenas cuentan como "Coincide" y, sin posición, dejan de ser incidencia
  const entries = useMemo(() => (data?.entries || []).map(e => (!e.check ? e : {
    ...e,
    check: {
      ...e.check,
      positions: e.check.positions.map(p => ({
        ...p,
        items: p.items.filter(i => !notes[noteKey(e.atc, p.pos, i.no)]?.ignored)
          .map(i => (notes[noteKey(e.atc, p.pos, i.no)]?.approved ? { ...i, status: 'ok' as const } : i)),
      })),
      unassigned: e.check.unassigned.filter(i => { const n = notes[noteKey(e.atc, null, i.no)]; return !n?.ignored && !n?.approved; }),
    },
  })), [data, notes]);
  const rawCheck = (atc: string) => data?.entries.find(x => x.atc === atc)?.check || null;

  // Resumen por código declarado → artículos asignados a sus posiciones
  const codes = useMemo(() => {
    const map = new Map<string, CodeRow>();
    for (const e of entries) {
      for (const p of e.check?.positions || []) {
        const row = map.get(p.tariff) || { tariff: p.tariff, rates: new Set<number>(), atcs: new Set<string>(), positions: 0, value: 0, duty: 0, items: new Map() };
        if (p.dutyRate != null) row.rates.add(p.dutyRate);
        row.atcs.add(e.atc); row.positions++; row.value += p.value || 0; row.duty += p.duty || 0;
        for (const i of p.items) {
          const it = row.items.get(i.no) || { no: i.no, description: i.description, bcTariff: i.bcTariff, bcRate: i.bcRate, qty: 0, atcs: new Set<string>(), status: i.status };
          it.qty += i.qty; it.atcs.add(e.atc); it.status = worst(it.status, i.status);
          row.items.set(i.no, it);
        }
        map.set(p.tariff, row);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.value - a.value);
  }, [entries]);
  // Artículos declarados con más de un código en el año
  const itemCodes = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of codes) for (const no of c.items.keys()) m.set(no, (m.get(no) || new Set()).add(c.tariff));
    return m;
  }, [codes]);

  // Búsqueda (un código se busca sin espacios) y "solo lo que hay que revisar": estado distinto / sin código / sin
  // ficha, artículos declarados con varios códigos, artículos sin posición y PDF no leídos
  const s = search.trim().toLowerCase();
  const sCode = s.replace(/\s/g, '');
  const issue = (i: CodeItem) => BAD.has(i.status) || (itemCodes.get(i.no)?.size || 0) > 1;
  const visibleCodes = codes.map(c => {
    const codeHit = !!s && c.tariff.includes(sCode);
    const items = Array.from(c.items.values()).filter(i => (!onlyIssues || issue(i))
      && (!s || codeHit || i.no.toLowerCase().includes(s) || i.description.toLowerCase().includes(s) || i.bcTariff.includes(sCode)));
    return { c, items, show: items.length > 0 || (!onlyIssues && (!s || codeHit)) };
  }).filter(v => v.show);
  const entryIssue = (e: Entry) => !!e.error || (!e.check && !e.dhl) || !!e.check?.unassigned.length || !!e.check?.positions.some(p => p.items.some(i => BAD.has(i.status)));
  const visibleEntries = entries.filter(e => (!onlyIssues || entryIssue(e))
    && (!s || [e.atc, e.invoiceNo, ...e.orders, ...e.transport].some(x => x.toLowerCase().includes(s))
      || !!e.check?.positions.some(p => p.tariff.includes(sCode) || p.items.some(i => i.no.toLowerCase().includes(s)))));

  const allItems = entries.flatMap(e => e.check?.positions.flatMap(p => p.items) || []);
  const count = (st: Item['status']) => allItems.filter(i => i.status === st).length;
  const errors = entries.filter(e => e.error);
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));

  // Excel con el detalle completo (descripciones de las posiciones), sin las líneas descartadas
  const exportXlsx = async () => {
    let list = entries;
    try {
      const res = await fetch(`/api/customs/history?year=${year}&stored=1&full=1`, { cache: 'no-store' });
      const json = await res.json();
      if (res.ok && json.stored) list = (json.entries as Entry[]).map(e => (!e.check ? e : {
        ...e, check: {
          ...e.check,
          positions: e.check.positions.map(p => ({ ...p, items: p.items.filter(i => !notes[noteKey(e.atc, p.pos, i.no)]?.ignored) })),
          unassigned: e.check.unassigned.filter(i => !notes[noteKey(e.atc, null, i.no)]?.ignored),
        },
      }));
    } catch { /* con el resumen */ }
    const rows = list.flatMap(e => [
      ...(e.check?.positions || []).flatMap(p => (p.items.length ? p.items : [null]).map(i => ({
        'AT/C': e.atc, 'Factura Zoll': e.invoiceNo, 'Fecha': e.postingDate, 'Pedido (N380)': e.orders.join(', '), 'Contenedor / AWB': e.transport.join(', '),
        'Factura China': e.check?.invoices.map(x => `${x.vendorInvoiceNo} (${x.no})`).join(', ') || '', 'Posición': p.pos, 'Código declarado': p.tariff,
        'Zoll %': p.dutyRate, 'Zollwert': p.value, 'Zoll': p.duty, 'Artículo': i?.no || '', 'Descripción': i?.description || p.description,
        'Uds.': i?.qty ?? null, 'Tariff No. BC': i?.bcTariff || '', '% BC': i?.bcRate ?? null, 'Estado': i ? STATUS[i.status].label : 'Ningún artículo asignado',
      }))),
      ...(e.check?.unassigned || []).map(i => ({
        'AT/C': e.atc, 'Factura Zoll': e.invoiceNo, 'Fecha': e.postingDate, 'Pedido (N380)': e.orders.join(', '), 'Contenedor / AWB': e.transport.join(', '),
        'Factura China': e.check?.invoices.map(x => `${x.vendorInvoiceNo} (${x.no})`).join(', ') || '', 'Posición': null, 'Código declarado': '',
        'Zoll %': null, 'Zollwert': null, 'Zoll': null, 'Artículo': i.no, 'Descripción': i.description, 'Uds.': i.qty, 'Tariff No. BC': i.bcTariff, '% BC': i.bcRate, 'Estado': 'Sin posición',
      })),
      ...(e.error ? [{ 'AT/C': e.atc, 'Factura Zoll': e.invoiceNo, 'Fecha': e.postingDate, 'Estado': e.error }] : []),
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Códigos arancelarios');
    XLSX.writeFile(wb, `Aduanas_codigos_${data?.company || ''}_${year}.xlsx`.replace(/\s+/g, '_'));
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-wrap items-center gap-3">
        <select value={year} onChange={e => setYear(Number(e.target.value))} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white">
          {[thisYear, thisYear - 1].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          {([['code', 'Por código arancelario'], ['atc', 'Por AT/C']] as const).map(([v, l]) => (
            <button key={v} onClick={() => changeView(v)}
              className={`px-3 py-1.5 font-semibold ${view === v ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{l}</button>
          ))}
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Código, artículo, AT/C o pedido"
            className="border border-gray-300 rounded-lg pl-8 pr-2 py-1.5 text-sm w-72" />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={onlyIssues} onChange={e => setOnlyIssues(e.target.checked)} /> Solo lo que hay que revisar
        </label>
        {checking && !loading && <span className="text-xs text-gray-400 flex items-center gap-1.5"><RefreshCw size={12} className="animate-spin" /> Comprobando facturas Zoll nuevas en BC…</span>}
        {notice && <span className="text-xs font-semibold text-emerald-700">{notice}</span>}
        {loading && (
          <span className="text-sm text-gray-500 flex items-center gap-2">
            <RefreshCw size={14} className="animate-spin" />
            {data ? `Leyendo PDFs de BC: ${data.total - data.pending} de ${data.total} AT/C` : 'Leyendo facturas Zoll de BC…'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={exportXlsx} disabled={!entries.length} className="inline-flex items-center gap-2 border border-gray-300 text-sm font-semibold px-3 py-1.5 rounded-lg hover:bg-gray-50 disabled:opacity-40">
            <FileDown size={14} /> Excel
          </button>
          <button onClick={() => { if (confirm('¿Volver a leer todos los PDFs del año? Tarda unos minutos.')) { setDetails({}); load('*'); } }} disabled={loading}
            title="Vuelve a leer los PDFs y a comparar con las fichas de artículo actuales"
            className="inline-flex items-center gap-2 border border-gray-300 text-sm font-semibold px-3 py-1.5 rounded-lg hover:bg-gray-50 disabled:opacity-40">
            <RefreshCw size={14} /> Recalcular todo
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border px-4 py-3 text-sm bg-red-50 border-red-200 text-red-800">{error} <button onClick={() => load()} className="underline">Reintentar</button></div>}

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          {[
            ['Declaraciones (AT/C)', `${entries.length}${data.pending ? ` de ${data.total}` : ''}`],
            ['Códigos declarados', String(codes.length)],
            ['Coinciden', String(count('ok') + count('ok8'))],
            ['Distintos', String(count('distinto'))],
            ['Sin código / ficha en BC', String(count('sin_codigo') + count('sin_ficha'))],
            ['PDF no leídos', String(errors.length)],
          ].map(([l, v]) => (
            <div key={l} className="bg-white border border-gray-200 rounded-xl p-3">
              <p className="text-xs text-gray-500">{l}</p>
              <p className="text-xl font-bold text-gray-900 tabular-nums">{v}</p>
            </div>
          ))}
        </div>
      )}

      {data && (
        <section className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <h2 className="px-4 pt-3 pb-1 font-bold text-gray-900">{view === 'code' ? 'Resumen por código declarado' : 'Resumen por AT/C'}</h2>
          <p className="px-4 pb-2 text-xs text-gray-500">{view === 'code'
            ? 'Cada código que ha declarado aduanas, con los artículos asignados a sus posiciones y el Tariff No. de su ficha en BC. Uds. = unidades de la factura de China asignadas.'
            : 'Cada declaración de aduanas con sus códigos declarados, importes y el estado de los artículos asignados. Al desplegarla: factura Zoll, pedido, factura China y sus posiciones.'}</p>
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className={th} /><th className={th}>{view === 'code' ? 'Código declarado' : 'AT/C'}</th><th className={`${th} text-right`}>Zoll %</th>
                <th className={`${th} text-right`}>{view === 'code' ? 'Declaraciones' : 'Códigos'}</th>
                <th className={`${th} text-right`}>Posiciones</th><th className={`${th} text-right`}>Zollwert €</th><th className={`${th} text-right`}>Zoll €</th>
                <th className={`${th} text-right`}>Artículos</th><th className={th}>Estado artículos</th>
              </tr>
            </thead>
            <tbody>
              {view === 'code' && visibleCodes.map(({ c, items }) => {
                const k = `code:${c.tariff}`;
                const all = Array.from(c.items.values());
                const counts = SEVERITY.map(st => [st, all.filter(i => i.status === st).length] as const).filter(([, n]) => n);
                return (
                  <Fragment key={k}>
                    <tr className="border-t border-gray-200 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(k)}>
                      <td className="p-2 w-6">{open[k] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                      <td className="p-2 font-mono font-semibold whitespace-nowrap">{code(c.tariff)}</td>
                      <td className="p-2 text-right tabular-nums whitespace-nowrap">{Array.from(c.rates).sort((a, b) => a - b).map(r => `${nf2.format(r)} %`).join(' · ') || '—'}</td>
                      <td className="p-2 text-right tabular-nums">{c.atcs.size}</td>
                      <td className="p-2 text-right tabular-nums">{c.positions}</td>
                      <td className="p-2 text-right tabular-nums">{nf2.format(c.value)}</td>
                      <td className="p-2 text-right tabular-nums">{nf2.format(c.duty)}</td>
                      <td className="p-2 text-right tabular-nums">{c.items.size}</td>
                      <td className="p-2"><span className="flex flex-wrap gap-1">
                        {counts.map(([st, n]) => <span key={st} className={`border rounded px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS[st].cls}`}>{n} {STATUS[st].label.toLowerCase()}</span>)}
                      </span></td>
                    </tr>
                    {open[k] && (
                      <tr><td /><td colSpan={8} className="pb-3 pr-2">
                        <table className="w-full text-sm border border-gray-200 rounded-lg">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className={th}>Artículo</th><th className={th}>Descripción</th><th className={`${th} text-right`}>Uds.</th><th className={`${th} text-right`}>Declaraciones</th>
                              <th className={th}>Tariff No. BC</th><th className={`${th} text-right`}>% BC</th><th className={th}>Estado</th><th className={th}>Otros códigos declarados</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...items].sort((a, b) => SEVERITY.indexOf(b.status) - SEVERITY.indexOf(a.status) || b.qty - a.qty).map(i => {
                              const others = Array.from(itemCodes.get(i.no) || []).filter(t => t !== c.tariff);
                              const rateDiff = i.bcRate != null && c.rates.size === 1 && Math.abs(i.bcRate - Array.from(c.rates)[0]) > 0.001;
                              return (
                                <tr key={i.no} className="border-t border-gray-100">
                                  <td className="p-2 font-mono whitespace-nowrap">{i.no}</td>
                                  <td className="p-2">{i.description || <span className="text-gray-400">—</span>}</td>
                                  <td className="p-2 text-right tabular-nums">{i.qty ? nf0.format(i.qty) : '—'}</td>
                                  <td className="p-2 text-right tabular-nums" title={Array.from(i.atcs).join('\n')}>{i.atcs.size}</td>
                                  <td className="p-2 font-mono whitespace-nowrap">{code(i.bcTariff)}</td>
                                  <td className={`p-2 text-right tabular-nums ${rateDiff ? 'text-red-700 font-semibold' : ''}`}>{i.bcRate != null ? `${nf2.format(i.bcRate)} %` : '—'}</td>
                                  <td className="p-2"><span className={`border rounded px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS[i.status].cls}`}>{STATUS[i.status].label}</span></td>
                                  <td className="p-2 font-mono text-xs whitespace-nowrap text-[#C8186C]">{others.map(code).join(' · ')}</td>
                                </tr>
                              );
                            })}
                            {!items.length && <tr><td colSpan={8} className="p-2 text-xs text-gray-400">Ningún artículo asignado a este código</td></tr>}
                          </tbody>
                        </table>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {view === 'code' && !visibleCodes.length && <tr><td colSpan={9} className="p-4 text-sm text-gray-500">{loading ? 'Cargando…' : 'Nada que mostrar.'}</td></tr>}
              {view === 'atc' && visibleEntries.map(e => {
                const k = `atc:${e.atc}`;
                const ps = e.check?.positions || [];
                const sum = (f: (p: typeof ps[number]) => number | null | undefined) => ps.reduce((t, p) => t + (f(p) || 0), 0);
                const rates = Array.from(new Set(ps.map(p => p.dutyRate).filter((r): r is number => r != null))).sort((a, b) => a - b);
                const tariffs = Array.from(new Set(ps.map(p => p.tariff)));
                return (
                  <Fragment key={k}>
                    <tr className="border-t border-gray-200 hover:bg-gray-50 cursor-pointer" onClick={() => { toggle(k); if (!open[k] && !details[e.atc]) loadDetail(e.atc); }}>
                      <td className="p-2 w-6">{open[k] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                      <td className="p-2 whitespace-nowrap">
                        <span className="font-mono font-semibold">{e.atc}</span>
                        {e.dhl && <span className="ml-2 border rounded px-1.5 py-px text-[10px] font-bold bg-yellow-50 text-yellow-800 border-yellow-300" title="Despacho de DHL Express (Hub Leipzig)">DHL</span>}
                        <span className="ml-2 text-xs text-gray-500 tabular-nums">{dateEs(e.postingDate)}</span>
                      </td>
                      <td className="p-2 text-right tabular-nums whitespace-nowrap">{rates.map(r => `${nf2.format(r)} %`).join(' · ') || '—'}</td>
                      <td className="p-2 text-right tabular-nums" title={tariffs.map(code).join('\n')}>{e.check ? tariffs.length : '—'}</td>
                      <td className="p-2 text-right tabular-nums">{e.check ? ps.length : '—'}</td>
                      <td className="p-2 text-right tabular-nums">{e.check ? nf2.format(sum(p => p.value)) : '—'}</td>
                      <td className="p-2 text-right tabular-nums">{e.check ? nf2.format(sum(p => p.duty)) : '—'}</td>
                      <td className="p-2 text-right tabular-nums">{e.check ? new Set(ps.flatMap(p => p.items.map(i => i.no))).size : '—'}</td>
                      <td className="p-2">
                        {ps.some(p => p.final != null) && (() => {
                          const def = ps.filter(p => p.final === true).length, no = ps.filter(p => p.final === false).length;
                          return <span className={`inline-block mb-1 mr-1 border rounded px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${no ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-gray-50 text-gray-600 border-gray-200'}`}
                            title="Abschließend / nicht abschließend festgesetzt">{def} definitiva{def === 1 ? '' : 's'}{no ? ` · ${no} no definitiva${no === 1 ? '' : 's'}` : ''}</span>;
                        })()}
                        {e.error ? <span className="text-xs text-red-700 flex items-center gap-1"><AlertCircle size={13} /> {e.error}</span>
                          : e.check ? <span className="flex flex-wrap gap-1"><StatusBadges data={e.check} /></span>
                          : e.dhl ? <span className="text-xs text-gray-500">Despacho DHL Express: el PDF no trae códigos arancelarios</span>
                          : <span className="text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> El PDF no trae las posiciones (parte &quot;Beleg&quot;)</span>}
                      </td>
                    </tr>
                    {open[k] && (
                      <tr><td /><td colSpan={8} className="pb-3 pr-2">
                        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-1 pb-2 text-xs text-gray-600">
                          <span>Factura Zoll: <span className="font-mono text-gray-900">{e.invoiceNo}</span><DocPdfLink documentNo={e.invoiceNo} />{e.status === 'Draft' && <span className="ml-1 text-gray-500">(sin registrar)</span>}</span>
                          <span>Pedido / contenedor: <span className="text-gray-900">{[e.orders.join(', '), e.transport.join(', ')].filter(Boolean).join(' / ') || '—'}</span></span>
                          <span>Factura China: {e.check ? (e.check.invoices.length ? <span className="text-gray-900">{e.check.invoices.map(i => `${i.vendorInvoiceNo} (${i.no})`).join(', ')}</span> : <span className="text-amber-700">no encontrada</span>) : '—'}</span>
                          <button onClick={() => setEditing({ atc: e.atc, orders: (data?.manual?.[e.atc]?.orders || e.orders).join(', '), transport: (data?.manual?.[e.atc]?.transport || e.transport).join(', ') })}
                            title="Indicar a mano el pedido / factura de China y el contenedor (si el PDF no los trae o están mal)"
                            className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100"><Pencil size={12} /> Pedido / contenedor</button>
                          <button onClick={() => reread(e.atc)} disabled={loading} title="Volver a leer este PDF"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-40"><RefreshCw size={12} /> Volver a leer el PDF</button>
                        </div>
                        {editing?.atc === e.atc && (
                          <div className="mx-1 mb-2 p-3 rounded-lg border border-indigo-200 bg-indigo-50/50 flex flex-wrap items-end gap-3 text-xs">
                            <label className="font-semibold text-gray-600">Pedido / factura de China
                              <input autoFocus value={editing.orders} onChange={ev => setEditing({ ...editing, orders: ev.target.value })} placeholder="2365-GWM-389 o CRZ-PI26-04421"
                                className="block mt-1 w-64 border border-gray-300 rounded px-2 py-1 text-sm font-mono bg-white" />
                            </label>
                            <label className="font-semibold text-gray-600">Contenedor / AWB
                              <input value={editing.transport} onChange={ev => setEditing({ ...editing, transport: ev.target.value })} placeholder="UACU5774331"
                                className="block mt-1 w-56 border border-gray-300 rounded px-2 py-1 text-sm font-mono bg-white" />
                            </label>
                            <button onClick={saveManual} disabled={loading} className="bg-indigo-600 text-white font-semibold px-3 py-1.5 rounded hover:bg-indigo-700 disabled:opacity-40">Guardar y comparar</button>
                            <button onClick={() => setEditing(null)} className="px-2 py-1.5 text-gray-600 hover:text-gray-900">Cancelar</button>
                            <span className="basis-full text-gray-500">Varios separados por comas. Vacíos = se usa lo que trae el PDF. Con la factura de China se comparan sus artículos aunque el PDF no traiga las posiciones.</span>
                          </div>
                        )}
                        {e.warnings.map(w => <p key={w} className="px-3 pt-2 text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> {w}</p>)}
                        {e.check && <div className="border border-gray-200 rounded-lg overflow-x-auto"><TariffTable data={details[e.atc]?.check || rawCheck(e.atc) || e.check} actions={{ atc: e.atc, notes, busy, onRefresh: refreshItem, onNote: saveNote }} /></div>}
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {view === 'atc' && !visibleEntries.length && <tr><td colSpan={9} className="p-4 text-sm text-gray-500">{loading ? 'Cargando…' : 'No hay declaraciones.'}</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
