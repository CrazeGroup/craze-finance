'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { COMPANIES, Dims, EMPTY_FILTERS, Facts, Filters, makeCtx } from './engine';
import { MultiSelect } from './ui';
import { Budget, Rule8020, SalesPerformance, Top50, YoYStatus } from './views';

// Commercial Analysis: recreación del Power BI "Commercial Analysis" con BC en directo (datos guardados y renovados
// cada hora). Filtros comunes arriba (como los slicers del Power BI) y una pestaña por página.
const PAGES = [
  { id: 'yoy', label: 'YoY Status' },
  { id: 'performance', label: 'Sales Performance' },
  { id: 'budget', label: 'Budget' },
  { id: 'pareto', label: 'Rule 80-20' },
  { id: 'top50', label: 'Top 50 Items' },
] as const;
type PageId = typeof PAGES[number]['id'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Load = { key: string; data: Facts | null; error: string | null; loading: boolean };

export default function CommercialAnalysisPage() {
  const thisYear = new Date().getFullYear();
  const [page, setPage] = useState<PageId>('yoy');
  const [year, setYear] = useState(thisYear);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [dims, setDims] = useState<{ data: Dims | null; error: string | null }>({ data: null, error: null });
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [reload, setReload] = useState({ n: 0, force: false });
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters(f => ({ ...f, [k]: v }));

  useEffect(() => {
    try { const p = localStorage.getItem('crz-commercial-page'); if (PAGES.some(x => x.id === p)) setPage(p as PageId); } catch { /* sin almacenamiento */ }
  }, []);
  const changePage = (p: PageId) => { setPage(p); try { localStorage.setItem('crz-commercial-page', p); } catch { /* sin almacenamiento */ } };

  useEffect(() => {
    fetch(`/api/commercial/dims${reload.force ? '?force=1' : ''}`, { cache: 'no-store' })
      .then(async r => { const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` })); setDims(r.ok && !d.error ? { data: d, error: null } : { data: null, error: d.error }); })
      .catch(e => setDims({ data: null, error: e.message }));
  }, [reload]);

  // Hechos de cada empresa para el año elegido y el anterior (una petición por empresa y año)
  // (lista estable: si se recalculara en cada render, el efecto se relanzaría sin parar)
  const companiesKey = filters.companies.join(',');
  const wanted = useMemo(() => {
    const companies = companiesKey ? companiesKey.split(',') : COMPANIES.map(c => c.abbr);
    return companies.flatMap(c => [year, year - 1].map(y => `${c}|${y}`));
  }, [companiesKey, year]);
  const inflight = useRef(new Set<string>());
  const forced = useRef(0);
  useEffect(() => {
    const force = reload.force && forced.current !== reload.n;
    if (force) forced.current = reload.n;
    for (const key of wanted) {
      if (inflight.current.has(key)) continue;
      if (!force && loads[key]?.data) continue;
      const [company, y] = key.split('|');
      inflight.current.add(key);
      setLoads(l => ({ ...l, [key]: { key, data: l[key]?.data ?? null, error: null, loading: true } }));
      fetch(`/api/commercial/facts?company=${company}&year=${y}${force ? '&force=1' : ''}`, { cache: 'no-store' })
        .then(async r => {
          const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          const ok = r.ok && !d.error;
          setLoads(l => ({ ...l, [key]: { key, data: ok ? d : l[key]?.data ?? null, error: ok ? null : d.error || `HTTP ${r.status}`, loading: false } }));
        })
        .catch(e => setLoads(l => ({ ...l, [key]: { key, data: l[key]?.data ?? null, error: e.message, loading: false } })))
        .finally(() => inflight.current.delete(key));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, reload]);

  const facts = useMemo(() => wanted.map(k => loads[k]?.data).filter(Boolean) as Facts[], [wanted, loads]);
  const loading = !dims.data || wanted.some(k => !loads[k] || (loads[k].loading && !loads[k].data));
  const refreshing = wanted.some(k => loads[k]?.loading);
  const errors = wanted.filter(k => loads[k]?.error).map(k => `${k.replace('|', ' ')}: ${loads[k].error}`);
  const ctx = useMemo(() => (dims.data ? makeCtx(dims.data, facts, year, filters) : null), [dims.data, facts, year, filters]);

  // Opciones de los filtros
  const opts = useMemo(() => {
    const d = dims.data;
    if (!d) return null;
    const uniq = (list: string[]) => Array.from(new Set(list.filter(Boolean))).sort();
    const countries = (i: number) => uniq(facts.flatMap(f => f.rows.map(r => r[i] as string)));
    const usedGroups = new Set(facts.flatMap(f => f.rows.map(r => r[3] as string)));
    const usedItems = new Set(facts.flatMap(f => f.rows.map(r => r[7] as string)));
    const items = d.items.filter(i => usedItems.has(i.no));
    return {
      dimensions: uniq(d.groups.map(g => g.dim)).map(v => ({ value: v, label: d.dimensions[v] || v })).sort((a, b) => a.label.localeCompare(b.label)),
      customers: d.groups.filter(g => usedGroups.has(g.code)).map(g => ({ value: g.code, label: g.desc || g.code })).sort((a, b) => a.label.localeCompare(b.label)),
      kams: uniq(facts.flatMap(f => f.rows.map(r => r[4] as string))).map(v => ({ value: v, label: d.kams[v] || v })),
      sell: countries(5).map(v => ({ value: v, label: v })),
      ship: countries(6).map(v => ({ value: v, label: v })),
      bus: uniq(items.map(i => i.bu)).map(v => ({ value: v, label: v })),
      lines: uniq(items.map(i => i.line)).map(v => ({ value: v, label: v })),
      licenses: uniq(items.map(i => i.license)).map(v => ({ value: v, label: v })),
      articles: uniq(items.map(i => i.raw)).map(v => ({ value: v, label: `${v} ${d.rawDesc[v] || ''}`.trim() })),
    };
  }, [dims.data, facts]);

  const props = ctx ? { ctx, facts, filters } : null;
  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight">Commercial Analysis</p>
            <p className="text-xs text-gray-500">Sell-in (facturado + pedidos abiertos), presupuesto y forecast · BC en directo{ctx ? ` · importes en ${ctx.currency}` : ''}</p>
          </div>
          <div className="flex bg-gray-100 rounded-lg p-1">
            {PAGES.map(p => (
              <button key={p.id} onClick={() => changePage(p.id)} className={`px-3 py-1.5 rounded-md text-sm font-semibold ${page === p.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>{p.label}</button>
            ))}
          </div>
          <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={refreshing} title="Volver a leer de BC"
            className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="w-full px-4 md:px-8 pb-3 flex flex-wrap items-end gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-0.5">Year</p>
            <select value={year} onChange={e => setYear(Number(e.target.value))} className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm font-semibold bg-white">
              {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].filter(y => y >= 2024).map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <MultiSelect label="CRAZE Company" width="w-36" options={COMPANIES.map(c => ({ value: c.abbr, label: c.name }))} value={filters.companies} onChange={v => set('companies', v)} />
          <MultiSelect label="Month" width="w-28" options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} value={filters.months.map(String)} onChange={v => set('months', v.map(Number))} />
          {opts && <>
            <MultiSelect label="Dimension" options={opts.dimensions} value={filters.dimensions} onChange={v => set('dimensions', v)} />
            <MultiSelect label="Customer" options={opts.customers} value={filters.customers} onChange={v => set('customers', v)} />
            <MultiSelect label="KAM" width="w-36" options={opts.kams} value={filters.kams} onChange={v => set('kams', v)} />
            <MultiSelect label="Sell Country" width="w-28" options={opts.sell} value={filters.sellCountries} onChange={v => set('sellCountries', v)} />
            <MultiSelect label="Ship Country" width="w-28" options={opts.ship} value={filters.shipCountries} onChange={v => set('shipCountries', v)} />
            <MultiSelect label="Business Unit" width="w-32" options={opts.bus} value={filters.bus} onChange={v => set('bus', v)} />
            <MultiSelect label="Product Line" options={opts.lines} value={filters.lines} onChange={v => set('lines', v)} />
            <MultiSelect label="License" width="w-36" options={opts.licenses} value={filters.licenses} onChange={v => set('licenses', v)} />
            <MultiSelect label="Article Filter" width="w-48" options={opts.articles} value={filters.articles} onChange={v => set('articles', v)} />
          </>}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-0.5">Unidades</p>
            <div className="flex bg-gray-100 rounded-lg p-0.5">
              {([['raw', 'Raw Article'], ['root', 'Article To Root']] as const).map(([id, label]) => (
                <button key={id} onClick={() => set('units', id)} className={`px-2 py-1 rounded-md text-xs font-semibold ${filters.units === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{label}</button>
              ))}
            </div>
          </div>
          {JSON.stringify({ ...filters, units: 'raw' }) !== JSON.stringify(EMPTY_FILTERS) && (
            <button onClick={() => setFilters({ ...EMPTY_FILTERS, units: filters.units })} className="text-xs font-semibold text-[#C8186C] hover:underline pb-2">Quitar filtros</button>
          )}
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-6 space-y-4">
        {dims.error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">Datos maestros: {dims.error}</p>}
        {errors.map(e => <p key={e} className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{e}</p>)}
        {Array.from(new Set(facts.flatMap(f => (f.warnings || []).map(w => `${f.company} ${f.year} · ${w}`)))).map(w => <p key={w} className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">{w}</p>)}
        {loading || !props ? (
          <p className="text-sm text-gray-500 py-10 text-center">Leyendo facturación, pedidos, presupuesto y forecast de Business Central… ({wanted.filter(k => loads[k] && !loads[k].loading).length}/{wanted.length})</p>
        ) : page === 'yoy' ? <YoYStatus {...props} />
          : page === 'performance' ? <SalesPerformance {...props} />
          : page === 'budget' ? <Budget {...props} />
          : page === 'pareto' ? <Rule8020 {...props} />
          : <Top50 {...props} />}
      </main>
    </div>
  );
}
