'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, FileDown, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import DocPdfLink from '@/components/DocPdfLink';
import { Check, code, Item, nf0, nf2, STATUS, StatusBadges, TariffTable } from './TariffCheck';

// Aduanas · Histórico: facturas Zoll del año (/api/customs/history), resumen por código arancelario declarado con los
// artículos importados en cada uno, y la lista de declaraciones con el detalle de cada una.
type Entry = {
  atc: string; file: string; date: string; orders: string[]; transport: string[]; zoll: number; eust: number;
  check: Check | null; warnings: string[]; error?: string; computedAt: string;
  invoiceNo: string; postingDate: string; status: string; amount: number;
};
type Data = { company: string; year: number; vendor: string; total: number; pending: number; entries: Entry[] };

// Orden de gravedad: el peor estado de un artículo en un código es el que se muestra
const SEVERITY: Item['status'][] = ['ok', 'ok8', 'sin_codigo', 'sin_ficha', 'distinto'];
const worst = (a: Item['status'], b: Item['status']) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a);
const BAD = new Set<Item['status']>(['distinto', 'sin_codigo', 'sin_ficha']);

type CodeItem = { no: string; description: string; bcTariff: string; bcRate: number | null; qty: number; atcs: Set<string>; status: Item['status'] };
type CodeRow = {
  tariff: string; rates: Set<number>; atcs: Set<string>; positions: number; value: number; duty: number; items: Map<string, CodeItem>;
};

const dateEs = (d: string) => (d ? d.split('-').reverse().join('.') : '—');
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
  const run = useRef(0);

  // Va llamando a la API hasta que no quedan AT/C pendientes (cada llamada procesa los que caben en ~40 s)
  const load = async (recompute?: string) => {
    const id = ++run.current;
    setLoading(true); setError(null);
    try {
      let param = recompute;
      let lastPending = Infinity;
      for (;;) {
        const res = await fetch(`/api/customs/history?year=${year}${param ? `&recompute=${encodeURIComponent(param)}` : ''}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        if (id !== run.current) return;
        setData(json);
        param = undefined;
        if (!json.pending || json.pending >= lastPending) break;
        lastPending = json.pending;
      }
    } catch (e: any) {
      if (id === run.current) setError(e.message);
    } finally {
      if (id === run.current) setLoading(false);
    }
  };
  useEffect(() => { setData(null); load(); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => data?.entries || [], [data]);

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
  const entryIssue = (e: Entry) => !!e.error || !!e.check?.unassigned.length || !!e.check?.positions.some(p => p.items.some(i => BAD.has(i.status)));
  const visibleEntries = entries.filter(e => (!onlyIssues || entryIssue(e))
    && (!s || [e.atc, e.invoiceNo, ...e.orders, ...e.transport].some(x => x.toLowerCase().includes(s))
      || !!e.check?.positions.some(p => p.tariff.includes(sCode) || p.items.some(i => i.no.toLowerCase().includes(s)))));

  const allItems = entries.flatMap(e => e.check?.positions.flatMap(p => p.items) || []);
  const count = (st: Item['status']) => allItems.filter(i => i.status === st).length;
  const errors = entries.filter(e => e.error);
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));

  const exportXlsx = () => {
    const rows = entries.flatMap(e => [
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
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Código, artículo, AT/C o pedido"
            className="border border-gray-300 rounded-lg pl-8 pr-2 py-1.5 text-sm w-72" />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={onlyIssues} onChange={e => setOnlyIssues(e.target.checked)} /> Solo lo que hay que revisar
        </label>
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
          <button onClick={() => { if (confirm('¿Volver a leer todos los PDFs del año? Tarda unos minutos.')) load('*'); }} disabled={loading}
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
          <h2 className="px-4 pt-3 pb-1 font-bold text-gray-900">Resumen por código declarado</h2>
          <p className="px-4 pb-2 text-xs text-gray-500">Cada código que ha declarado aduanas, con los artículos asignados a sus posiciones y el Tariff No. de su ficha en BC. Uds. = unidades de la factura de China asignadas.</p>
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className={th} /><th className={th}>Código declarado</th><th className={`${th} text-right`}>Zoll %</th><th className={`${th} text-right`}>Declaraciones</th>
                <th className={`${th} text-right`}>Posiciones</th><th className={`${th} text-right`}>Zollwert €</th><th className={`${th} text-right`}>Zoll €</th>
                <th className={`${th} text-right`}>Artículos</th><th className={th}>Estado artículos</th>
              </tr>
            </thead>
            <tbody>
              {visibleCodes.map(({ c, items }) => {
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
              {!visibleCodes.length && <tr><td colSpan={9} className="p-4 text-sm text-gray-500">{loading ? 'Cargando…' : 'Nada que mostrar.'}</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {data && (
        <section className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <h2 className="px-4 pt-3 pb-2 font-bold text-gray-900">Declaraciones</h2>
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className={th} /><th className={th}>Fecha</th><th className={th}>AT/C</th><th className={th}>Factura Zoll</th><th className={th}>Pedido / contenedor</th>
                <th className={th}>Factura China</th><th className={`${th} text-right`}>Posiciones</th><th className={th}>Estado</th><th className={th} />
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map(e => {
                const k = `atc:${e.atc}`;
                return (
                  <Fragment key={k}>
                    <tr className="border-t border-gray-200 hover:bg-gray-50 cursor-pointer" onClick={() => e.check && toggle(k)}>
                      <td className="p-2 w-6">{e.check ? (open[k] ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</td>
                      <td className="p-2 whitespace-nowrap tabular-nums">{dateEs(e.postingDate)}</td>
                      <td className="p-2 font-mono whitespace-nowrap">{e.atc}</td>
                      <td className="p-2 font-mono whitespace-nowrap">{e.invoiceNo}<DocPdfLink documentNo={e.invoiceNo} />{e.status === 'Draft' && <span className="ml-1 text-xs text-gray-500">(sin registrar)</span>}</td>
                      <td className="p-2 text-xs">{[e.orders.join(', '), e.transport.join(', ')].filter(Boolean).join(' / ') || '—'}</td>
                      <td className="p-2 text-xs">{e.check ? (e.check.invoices.length ? e.check.invoices.map(i => `${i.vendorInvoiceNo} (${i.no})`).join(', ') : <span className="text-amber-700">no encontrada</span>) : '—'}</td>
                      <td className="p-2 text-right tabular-nums">{e.check?.positions.length ?? '—'}</td>
                      <td className="p-2">
                        {e.error ? <span className="text-xs text-red-700 flex items-center gap-1"><AlertCircle size={13} /> {e.error}</span>
                          : e.check ? <span className="flex flex-wrap gap-1"><StatusBadges data={e.check} /></span> : null}
                      </td>
                      <td className="p-2 text-right">
                        <button onClick={ev => { ev.stopPropagation(); load(e.atc); }} disabled={loading} title="Volver a leer este PDF"
                          className="p-1 rounded text-gray-400 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-40"><RefreshCw size={13} /></button>
                      </td>
                    </tr>
                    {open[k] && e.check && (
                      <tr><td /><td colSpan={8} className="pb-3 pr-2">
                        {e.warnings.map(w => <p key={w} className="px-3 pt-2 text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> {w}</p>)}
                        <div className="border border-gray-200 rounded-lg overflow-x-auto"><TariffTable data={e.check} /></div>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {!visibleEntries.length && <tr><td colSpan={9} className="p-4 text-sm text-gray-500">{loading ? 'Cargando…' : 'No hay declaraciones.'}</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
