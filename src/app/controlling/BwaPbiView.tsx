'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Loading, Section } from '../reporting/ui';
import BwaAccountDrill, { type DrillSpec } from './BwaAccountDrill';
import { parseDatev, type DatevFile } from './datevParse';

// Controlling · BWA (Power BI): las páginas del Power BI "BWA" (Annual, Monthly, Annual - Detail, Exchg_Cur) leídas de
// BC en vivo. Filas = líneas BWA, desplegables por nivel (cuenta de mapeo); columnas según la página.
type Line = { code: string; description: string; formula: string[] | null; highlight: 'high' | 'med' | null };
type Account = { account: string; bwa: string; level: string; description: string };
type Data = {
  year: number; rates: { GBP: number | null; CHF: number | null };
  currencies: { code: string; description: string; rate: number; date: string }[];
  lines: Line[]; accounts: Account[]; companies: string[]; cells: [string, number, string, string, number][];
};

const INTERCO = 'CRAZE Intercompany';
const CONSOL = 'CRAZE Consolidated';
const SALES = 'SALES REVENUES';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const PAGES = [
  { id: 'annual', label: 'Annual' },
  { id: 'datev', label: 'Annual vs DATEV' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'detail', label: 'Annual - Detail' },
  { id: 'fx', label: 'Exchange Rates' },
] as const;
type Page = typeof PAGES[number]['id'];
// Annual vs DATEV: apartados de la Jahresübersicht que son ingresos (se mantiene el signo; el resto son gastos y se
// invierten, como el BWA) y línea BWA de cada apartado para las cuentas que no están en el mapeo de BC
const DATEV_INCOME = new Set(['1020', '1040', '1045', '1090', '1322', '1323', '1324']);
const DATEV_SECTION_LINE: [RegExp, RegExp][] = [
  [/^(1020|1045|1090)$/, /^sales revenues$/i], [/^1040$/, /sales provision/i], [/^1060$/, /cost of goods/i], [/^1100$/, /personnel/i],
  [/^1200$/, /marketing/i], [/^1220$/, /logistic/i], [/^1240$/, /depreciation/i], [/^(13\d\d)$/, /financial/i], [/./, /other expenses/i],
];
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap text-right';
const td = 'py-1.5 px-2 whitespace-nowrap tabular-nums text-right';
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

export default function BwaPbiView({ fmt }: { fmt: Fmt }) {
  const { num, date } = fmt;
  const now = new Date();
  const [page, setPage] = useState<Page>('annual');
  const [year, setYear] = useState(now.getFullYear());
  // Hasta mes (acumulado del año): por defecto el último mes cerrado
  const [toMonth, setToMonth] = useState(now.getMonth() === 0 ? 12 : now.getMonth());
  const [company, setCompany] = useState(CONSOL);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetch(`/api/controlling/bwa-pbi?year=${year}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!cancelled) setState(res.ok && !data.error ? { data, loading: false, error: null } : { data: null, loading: false, error: data.error || `HTTP ${res.status}` });
      })
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [year, reload]);

  const d = state.data;

  // ---------- Annual vs DATEV: Jahresübersicht del año anterior subida por el usuario ----------
  const [datev, setDatev] = useState<{ file: DatevFile | null; updatedAt: string | null; loading: boolean; error: string | null }>({ file: null, updatedAt: null, loading: false, error: null });
  const [datevN, setDatevN] = useState(0);
  const datevCompany = company === CONSOL || company === INTERCO ? 'CRAZE' : company;
  useEffect(() => { if (page === 'datev' && (company === CONSOL || company === INTERCO)) setCompany('CRAZE'); }, [page, company]);
  useEffect(() => {
    if (page !== 'datev') return;
    let cancelled = false;
    setDatev(x => ({ ...x, loading: true, error: null }));
    fetch(`/api/controlling/bwa-pbi/datev?company=${encodeURIComponent(datevCompany)}&year=${year - 1}`, { cache: 'no-store' })
      .then(r => r.json()).then(j => !cancelled && setDatev({ file: j.file, updatedAt: j.updatedAt, loading: false, error: null }))
      .catch(e => !cancelled && setDatev(x => ({ ...x, loading: false, error: e.message })));
    return () => { cancelled = true; };
  }, [page, datevCompany, year, datevN]);
  const uploadDatev = async (f: File | undefined) => {
    if (!f) return;
    try {
      const file = await parseDatev(f);
      if (file.year !== year - 1) throw new Error(`El Excel es de ${file.year}; para comparar con ${year} hace falta el de ${year - 1}.`);
      const r = await fetch('/api/controlling/bwa-pbi/datev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company: datevCompany, file }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setDatevN(n => n + 1);
    } catch (e: any) {
      setDatev(x => ({ ...x, error: e.message }));
    }
  };
  // Cada cuenta DATEV (602000) a la cuenta de BC (6020 00): si está en el mapeo, a su línea; si no, a la línea de una
  // cuenta mapeada con las mismas 4 primeras cifras o, si tampoco, a la del apartado DATEV (cuenta añadida "DATEV")
  const datevMap = useMemo(() => {
    const values = new Map<string, number[]>();
    const extra: Account[] = [];
    const stats = { exact: 0, prefix: 0, section: 0 };
    if (!d || !datev.file) return { values, extra, stats };
    const byNo = new Map(d.accounts.map(a => [a.account, a]));
    const lineFor = (section: string) => {
      const re = DATEV_SECTION_LINE.find(([sec]) => sec.test(section))?.[1];
      return d.lines.find(l => !l.formula && re?.test(l.description))?.code || '';
    };
    for (const a of datev.file.accounts) {
      const bc = `${a.account.substring(0, 4)} ${a.account.substring(4)}`;
      const sign = DATEV_INCOME.has(a.section) ? 1 : -1;
      const vals = a.values.map(v => v * sign);
      values.set(bc, (values.get(bc) || vals.map(() => 0)).map((v, i) => v + vals[i]));
      if (byNo.has(bc) || extra.some(x => x.account === bc)) { if (byNo.has(bc)) stats.exact++; continue; }
      const sibling = d.accounts.find(x => x.account.substring(0, 4) === bc.substring(0, 4));
      const bwa = sibling?.bwa || lineFor(a.section);
      if (sibling) stats.prefix++; else stats.section++;
      if (bwa) extra.push({ account: bc, bwa, level: 'zz', description: `${a.name || 'Cuenta DATEV'} · DATEV (${sibling ? `como ${sibling.account}` : `apartado ${a.section}`})` });
    }
    return { values, extra, stats };
  }, [d, datev.file]);
  const datevSum = (accs: Account[]) => {
    let s = 0;
    for (const a of accs) { const v = datevMap.values.get(a.account); if (v) for (let i = 0; i < Math.min(toMonth, v.length); i++) s += v[i]; }
    return s;
  };

  // Índice: columna (sociedad / Intercompany / Consolidated) → cuenta → mes → importe
  const index = useMemo(() => {
    const idx = new Map<string, Map<string, Map<string, number>>>();
    const put = (col: string, acc: string, m: string, v: number) => {
      const byAcc = idx.get(col) || new Map(); idx.set(col, byAcc);
      const byMonth = byAcc.get(acc) || new Map(); byAcc.set(acc, byMonth);
      byMonth.set(m, (byMonth.get(m) || 0) + v);
    };
    for (const [c, el, acc, m, v] of d?.cells || []) {
      put(c, acc, m, v);
      put(el ? INTERCO : CONSOL, acc, m, v);
    }
    return idx;
  }, [d]);

  const accountsOf = useMemo(() => {
    const map = new Map<string, Account[]>();
    for (const a of [...(d?.accounts || []), ...(page === 'datev' ? datevMap.extra : [])]) map.set(a.bwa, [...(map.get(a.bwa) || []), a]);
    return map;
  }, [d, page, datevMap]);
  const lineAccounts = (l: Line) => (l.formula || [l.code]).flatMap(c => accountsOf.get(c) || []);

  const sum = (col: string, accs: Account[], months: string[]) => {
    const byAcc = index.get(col);
    if (!byAcc) return 0;
    let s = 0;
    for (const a of accs) { const bm = byAcc.get(a.account); if (bm) for (const m of months) s += bm.get(m) || 0; }
    return s;
  };
  const ytd = (y: number) => Array.from({ length: toMonth }, (_, i) => ym(y, i + 1));
  const salesLine = d?.lines.find(l => l.description === SALES);
  const salesOf = (col: string, months: string[]) => (salesLine ? sum(col, lineAccounts(salesLine), months) : 0);

  const columnsCompanies = d ? [...d.companies, INTERCO, CONSOL] : [];
  const money = (v: number) => (Math.abs(v) < 0.005 ? '' : num(v, 0));
  const pctTxt = (v: number | null) => (v == null || !isFinite(v) ? '' : `${num(v * 100, 1)} %`);
  const div = (a: number, b: number) => (b ? a / b : null);

  // ---------- Definición de columnas de cada página ----------
  // drill: sociedad y meses del importe, para el desglose de una cuenta al hacer clic en la celda
  type Col = { key: string; label: string; sub?: string; value: (accs: Account[], line: Line | null) => number | null; kind: 'money' | 'pct'; red?: (accs: Account[], line: Line | null) => boolean; drill?: { scope: string; months: string[]; label: string } };
  const columns: Col[] = useMemo(() => {
    if (!d) return [];
    if (page === 'annual') {
      const cur = ytd(year), prev = ytd(year - 1);
      const isSales = (l: Line | null) => l?.description === SALES;
      const pCur = (accs: Account[], l: Line | null) => (isSales(l) ? null : div(sum(company, accs, cur), salesOf(company, cur)));
      const pPrev = (accs: Account[], l: Line | null) => (isSales(l) ? null : div(sum(company, accs, prev), salesOf(company, prev)));
      const pDiff = (accs: Account[], l: Line | null) => { const a = pCur(accs, l), b = pPrev(accs, l); return a == null || b == null ? null : a - b; };
      return [
        { key: 'prev', label: 'Year -1', sub: `${year - 1}`, kind: 'money', value: accs => sum(company, accs, prev), drill: { scope: company, months: prev, label: `Year -1 (${year - 1})` } },
        { key: 'pprev', label: '%', kind: 'pct', value: pPrev },
        { key: 'cur', label: 'Year', sub: `${year}`, kind: 'money', value: accs => sum(company, accs, cur), drill: { scope: company, months: cur, label: `Year (${year})` } },
        { key: 'pcur', label: '%', kind: 'pct', value: pCur },
        { key: 'diff', label: '€ diff.', kind: 'money', value: accs => sum(company, accs, cur) - sum(company, accs, prev) },
        { key: 'pdiff', label: '%', sub: 'p.p.', kind: 'pct', value: pDiff, red: (accs, l) => (pDiff(accs, l) ?? 0) < 0 },
      ];
    }
    if (page === 'datev') {
      const cur = ytd(year), prev = ytd(year - 1);
      const isSales = (l: Line | null) => l?.description === SALES;
      const salesPrev = salesLine ? datevSum(lineAccounts(salesLine)) : 0;
      const pCur = (accs: Account[], l: Line | null) => (isSales(l) ? null : div(sum(company, accs, cur), salesOf(company, cur)));
      const pPrev = (accs: Account[], l: Line | null) => (isSales(l) ? null : div(datevSum(accs), salesPrev));
      const pDiff = (accs: Account[], l: Line | null) => { const a = pCur(accs, l), b = pPrev(accs, l); return a == null || b == null ? null : a - b; };
      return [
        { key: 'prev', label: 'Year -1 DATEV', sub: `${year - 1}`, kind: 'money', value: accs => datevSum(accs) },
        { key: 'pprev', label: '%', kind: 'pct', value: pPrev },
        { key: 'cur', label: 'Year', sub: `${year}`, kind: 'money', value: accs => sum(company, accs, cur), drill: { scope: company, months: cur, label: `Year (${year})` } },
        { key: 'pcur', label: '%', kind: 'pct', value: pCur },
        { key: 'diff', label: '€ diff.', kind: 'money', value: accs => sum(company, accs, cur) - datevSum(accs) },
        { key: 'pdiff', label: '%', sub: 'p.p.', kind: 'pct', value: pDiff, red: (accs, l) => (pDiff(accs, l) ?? 0) < 0 },
        { key: 'bcprev', label: 'Year -1 BC', sub: `${year - 1}`, kind: 'money', value: accs => sum(company, accs, prev), drill: { scope: company, months: prev, label: `Year -1 BC (${year - 1})` } },
        { key: 'gap', label: 'DATEV − BC', kind: 'money', value: accs => datevSum(accs) - sum(company, accs, prev) },
      ];
    }
    if (page === 'monthly') {
      return [
        ...MONTHS.map((m, i) => ({ key: m, label: m, kind: 'money' as const, value: (accs: Account[]) => sum(company, accs, [ym(year, i + 1)]), drill: { scope: company, months: [ym(year, i + 1)], label: `${m} ${year}` } })),
        { key: 'total', label: 'Total', sub: `${year}`, kind: 'money', value: accs => sum(company, accs, MONTHS.map((_, i) => ym(year, i + 1))), drill: { scope: company, months: MONTHS.map((_, i) => ym(year, i + 1)), label: `Año ${year}` } },
      ];
    }
    // Annual - Detail: una columna por sociedad + Consolidated y su % sobre Sales Revenues
    const cur = ytd(year);
    return [
      ...d.companies.map(c => ({ key: c, label: c, kind: 'money' as const, value: (accs: Account[]) => sum(c, accs, cur), drill: { scope: c, months: cur, label: `${year} hasta ${MONTHS_ES[toMonth - 1].toLowerCase()}` } })),
      { key: 'consol', label: 'Consolidated', kind: 'money', value: accs => sum(CONSOL, accs, cur), drill: { scope: CONSOL, months: cur, label: `${year} hasta ${MONTHS_ES[toMonth - 1].toLowerCase()}` } },
      { key: 'pconsol', label: '%', sub: 's/ Sales Rev.', kind: 'pct', value: (accs, l) => (l?.description === SALES ? null : div(sum(CONSOL, accs, cur), salesOf(CONSOL, cur))) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, page, year, toMonth, company, index, datevMap]);

  // Desglose abierto por cuenta (clic en el nombre = columna principal de la página; clic en un importe = ese importe)
  const [drills, setDrills] = useState<Record<string, DrillSpec>>({});
  const mainDrillCol = page === 'annual' || page === 'datev' ? 'cur' : page === 'monthly' ? 'total' : 'consol';
  const lastDay = (ymStr: string) => { const [y, m] = ymStr.split('-').map(Number); return `${ymStr}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
  const openDrill = (a: Account, c: Col | undefined) => {
    if (!c?.drill || !c.drill.months.length) return;
    const spec: DrillSpec = {
      account: a.account, accountName: a.description, scope: c.drill.scope, label: c.drill.label,
      from: `${c.drill.months[0]}-01`, to: lastDay(c.drill.months[c.drill.months.length - 1]),
    };
    setDrills(ds => {
      const cur = ds[a.account];
      const same = cur && cur.scope === spec.scope && cur.from === spec.from && cur.to === spec.to;
      const next = { ...ds };
      if (same) delete next[a.account]; else next[a.account] = spec;
      return next;
    });
  };
  useEffect(() => { setDrills({}); }, [page, year, toMonth, company]);

  const cell = (c: Col, accs: Account[], line: Line | null) => {
    const v = c.value(accs, line);
    return c.kind === 'pct' ? pctTxt(v) : money(v || 0);
  };

  const exportExcel = () => {
    if (!d) return;
    const rows: Record<string, string | number | null>[] = [];
    for (const l of d.lines) {
      const accs = lineAccounts(l);
      const row: Record<string, string | number | null> = { 'BWA Group': l.description, 'No.': '', Level: '', Description: '' };
      columns.forEach(c => { row[`${c.label}${c.sub ? ` ${c.sub}` : ''}`] = c.value(accs, l); });
      rows.push(row);
      if (!l.formula) for (const a of accountsOf.get(l.code) || []) {
        const sub: Record<string, string | number | null> = { 'BWA Group': l.description, 'No.': a.account, Level: a.level, Description: a.description };
        columns.forEach(c => { sub[`${c.label}${c.sub ? ` ${c.sub}` : ''}`] = c.value([a], null); });
        rows.push(sub);
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), PAGES.find(p => p.id === page)!.label.substring(0, 31));
    XLSX.writeFile(wb, `BWA_${page}_${page === 'detail' ? 'empresas' : company}_${year}${page === 'monthly' ? '' : `_hasta_${toMonth}`}.xlsx`.replace(/\s+/g, '_'));
  };

  // Annual y Annual - Detail: principales desviaciones frente al año anterior (líneas BWA con más diferencia, sus cuentas
  // y, en Detail, qué sociedades la explican). Annual: empresa elegida; Detail: consolidado.
  const devScope = page === 'detail' ? CONSOL : company;
  const devDrillCol = page === 'detail' ? 'consol' : 'cur';
  const deviations = (() => {
    if (!d || (page !== 'annual' && page !== 'detail')) return null;
    const company = devScope;
    const cur = ytd(year), prev = ytd(year - 1);
    const salesCur = salesOf(company, cur), salesPrev = salesOf(company, prev);
    const lines = d.lines.filter(l => !l.formula).map(l => {
      const accs = accountsOf.get(l.code) || [];
      const vCur = sum(company, accs, cur), vPrev = sum(company, accs, prev);
      const accounts = accs.map(a => ({ a, cur: sum(company, [a], cur), prev: sum(company, [a], prev) }))
        .map(x => ({ ...x, diff: x.cur - x.prev })).filter(x => Math.abs(x.diff) >= 1)
        .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
      // Por sociedad (cada una con sus movimientos, como las columnas de Detail) e Intercompany
      const byCompany = page === 'detail'
        ? [...d.companies, INTERCO].map(c => ({ c, diff: sum(c === INTERCO ? INTERCO : c, accs, cur) - sum(c === INTERCO ? INTERCO : c, accs, prev) }))
          .filter(x => Math.abs(x.diff) >= 1).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
        : [];
      return { l, cur: vCur, prev: vPrev, diff: vCur - vPrev, pp: salesCur && salesPrev ? vCur / salesCur - vPrev / salesPrev : null, accounts, byCompany };
    }).filter(x => Math.abs(x.diff) >= 1).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
    // Las 6 líneas con más diferencia y las cuentas que explican la mayor parte (hasta 4)
    return lines.slice(0, 6).map(x => ({ ...x, accounts: x.accounts.slice(0, 4) }));
  })();
  const pctChange = (cur: number, prev: number) => (prev ? `${cur - prev >= 0 ? '+' : ''}${num(((cur - prev) / Math.abs(prev)) * 100, 1)} %` : 'nuevo');
  const tone = (diff: number) => (diff > 0 ? 'text-emerald-700' : diff < 0 ? 'text-[#C0392B]' : 'text-gray-500');

  const select = 'block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal';
  const label = 'text-[11px] font-semibold uppercase tracking-wider text-gray-500';
  const rowStyle = (l: Line) => l.highlight === 'high' ? 'bg-[#333333] text-white font-bold' : l.highlight === 'med' ? 'bg-[#E6E6E6] text-gray-900 font-bold' : 'text-gray-900';
  const expandable = d?.lines.filter(l => !l.formula && (accountsOf.get(l.code)?.length || 0) > 0) || [];
  const allOpen = expandable.length > 0 && expandable.every(l => open[l.code]);

  return (
    <Section title="BWA (Power BI)" source="glEntriesUnion + mappingAccounts + bwas (API custom de BC) · GBP/CHF a EUR con Currencies_Excel · igual que el Power BI BWA">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex bg-gray-100 rounded-lg p-1">
          {PAGES.map(p => (
            <button key={p.id} onClick={() => setPage(p.id)}
              className={`px-3 py-1 rounded-md text-sm font-semibold ${page === p.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <label className={label}>
          Año
          <select value={year} onChange={e => setYear(Number(e.target.value))} className={select}>
            {Array.from({ length: 5 }, (_, i) => now.getFullYear() - i).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        {(page === 'annual' || page === 'datev' || page === 'detail') && (
          <label className={label}>
            Hasta mes
            <select value={toMonth} onChange={e => setToMonth(Number(e.target.value))} className={select}>
              {MONTHS_ES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </label>
        )}
        {(page === 'annual' || page === 'datev' || page === 'monthly') && (
          <label className={label}>
            CRAZE Company
            <select value={company} onChange={e => setCompany(e.target.value)} className={select}>
              {columnsCompanies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        <div className="ml-auto flex gap-2">
          {page !== 'fx' && (
            <button onClick={exportExcel} disabled={state.loading || !d}
              className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
              <FileDown size={16} /> Exportar Excel
            </button>
          )}
          <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={state.loading} title="Volver a leer de BC"
            className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
            <RefreshCw size={16} className={state.loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {state.error ? <ErrorBox message={state.error} />
        : state.loading || !d ? <Loading text={`Leyendo los movimientos contables de ${year - 1} y ${year} de Business Central…`} />
        : page === 'fx' ? (
          <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto max-w-xl">
            <p className="px-4 pt-4 font-bold text-gray-900">Currency Exchange Rates</p>
            <table className="w-full text-[13px] mt-2">
              <thead><tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                <th className={`${th} text-left`}>Code</th><th className={`${th} text-left`}>Description</th><th className={th}>Exchange Rate Amt</th><th className={th}>Exchange Rate Date</th>
              </tr></thead>
              <tbody>
                {d.currencies.map(c => (
                  <tr key={c.code} className="border-b border-gray-100">
                    <td className="py-2 px-2 font-semibold">{c.code}</td><td className="py-2 px-2">{c.description}</td>
                    <td className={td}>{num(c.rate, 6)}</td><td className={td}>{date(c.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-3 text-xs text-gray-500">Importes de UK (GBP) y Group AG (CHF) × este tipo = EUR, como en el Power BI.</p>
          </div>
        ) : (
          <>
            {page === 'datev' && (
              <div className="rpt-card bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap items-center gap-4 text-sm">
                <div className="flex-1 min-w-[300px]">
                  <p className="font-bold text-gray-900">Year -1 desde la Jahresübersicht de DATEV · {datevCompany} {year - 1}</p>
                  {datev.loading ? <p className="text-gray-500">Cargando…</p>
                    : datev.file ? (
                      <p className="text-gray-600">
                        {datev.file.name} · enero–{MONTHS_ES[datev.file.months - 1].toLowerCase()} {datev.file.year}
                        {datev.updatedAt && ` · subido ${new Date(datev.updatedAt).toLocaleDateString('es-ES')}`}
                        {' · '}{datevMap.stats.exact} cuentas con el mapeo de BC, {datevMap.stats.prefix} aproximadas por cuenta parecida y {datevMap.stats.section} por apartado DATEV
                      </p>
                    ) : <p className="text-amber-800">Sube la Jahresübersicht de DATEV de {year - 1} para comparar.</p>}
                  {datev.file && toMonth > datev.file.months && <p className="text-amber-800">El Excel llega hasta {MONTHS_ES[datev.file.months - 1].toLowerCase()}: Year -1 DATEV solo suma esos meses; elige "Hasta mes" {MONTHS_ES[datev.file.months - 1]} para comparar el mismo periodo.</p>}
                  {datev.error && <p className="text-red-700">{datev.error}</p>}
                </div>
                <label className="cursor-pointer inline-flex items-center gap-2 bg-gray-900 text-white font-semibold px-3 py-2 rounded-lg hover:bg-black">
                  {datev.file ? 'Sustituir Excel DATEV' : 'Cargar Excel DATEV'}
                  <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => { uploadDatev(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
            )}
            <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                    <th className={`${th} text-left`}>
                      <button onClick={() => setOpen(allOpen ? {} : Object.fromEntries(expandable.map(l => [l.code, true])))}
                        className="flex items-center gap-1 uppercase hover:text-gray-900" title="Desplegar o plegar todos los niveles">
                        {allOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} BWA Group → No.
                      </button>
                    </th>
                    {columns.map(c => (
                      <th key={c.key} className={th}>{c.label}{c.sub && <span className="block font-normal normal-case tracking-normal">{c.sub}</span>}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map(l => {
                    const accs = lineAccounts(l);
                    const subs = l.formula ? [] : accountsOf.get(l.code) || [];
                    return (
                      <Fragment key={l.code}>
                        <tr className={`border-b border-gray-100 ${rowStyle(l)} ${subs.length ? 'cursor-pointer' : ''}`} onClick={() => subs.length && setOpen(o => ({ ...o, [l.code]: !o[l.code] }))}>
                          <td className="py-1.5 px-2 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1">
                              {subs.length ? (open[l.code] ? <ChevronDown size={13} className="opacity-60" /> : <ChevronRight size={13} className="opacity-60" />) : <span className="w-[13px]" />}
                              {l.description}
                            </span>
                          </td>
                          {columns.map(c => (
                            <td key={c.key} className={`${td} ${c.red?.(accs, l) ? 'bg-[#FFBABD] text-[#80292E]' : ''} ${c.kind === 'pct' && !l.highlight ? 'text-[#2B408E]' : ''}`}>{cell(c, accs, l)}</td>
                          ))}
                        </tr>
                        {open[l.code] && subs.map(a => (
                          <Fragment key={a.account}>
                            <tr className={`border-b border-gray-100 text-[12px] text-gray-600 ${drills[a.account] ? 'bg-[#FDF2F7]' : ''}`}>
                              <td className="py-1 px-2 pl-9 whitespace-nowrap cursor-pointer hover:text-[#C8186C]" title={`BWA level ${a.level} · clic para ver el desglose`}
                                onClick={() => openDrill(a, columns.find(c => c.key === mainDrillCol))}>
                                <span className="inline-block w-16 tabular-nums">{a.account}</span>{a.description}
                              </td>
                              {columns.map(c => (
                                <td key={c.key} onClick={c.drill ? () => openDrill(a, c) : undefined}
                                  title={c.drill ? `Desglose de ${c.drill.label}` : undefined}
                                  className={`${td} py-1 ${c.kind === 'pct' ? 'text-[#2B408E]' : ''} ${c.drill ? 'cursor-pointer hover:underline hover:text-[#C8186C]' : ''}`}>{cell(c, [a], null)}</td>
                              ))}
                            </tr>
                            {drills[a.account] && (
                              <tr><td colSpan={columns.length + 1} className="p-0">
                                <BwaAccountDrill fmt={fmt} spec={drills[a.account]} onClose={() => setDrills(ds => { const next = { ...ds }; delete next[a.account]; return next; })} />
                              </td></tr>
                            )}
                          </Fragment>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500">
              {page === 'datev' && `Year -1 = Jahresübersicht de DATEV (cuentas DATEV 602000 = BC 6020 00, con el mapeo BWA de BC; las cuentas sin mapeo se asignan como la cuenta de BC con las mismas 4 cifras o por su apartado DATEV y aparecen marcadas "DATEV"). Gastos con el signo invertido, como el BWA. "Year -1 BC" y "DATEV − BC" muestran lo que registra BC para el mismo periodo. `}
              {page === 'annual' && `Acumulado de enero a ${MONTHS_ES[toMonth - 1].toLowerCase()} de ${year} frente al mismo periodo de ${year - 1}, ${company}. % = sobre Sales Revenues; el último % es la diferencia en puntos (en rojo si baja).`}
              {page === 'monthly' && `Importe de cada mes de ${year}, ${company}.`}
              {page === 'detail' && `Acumulado de enero a ${MONTHS_ES[toMonth - 1].toLowerCase()} de ${year} por sociedad (cada una con sus movimientos de eliminación) y consolidado (sin eliminaciones).`}
              {' '}Importes en EUR con el signo invertido (ingresos en positivo). Haz clic en una línea para ver sus niveles.
            </p>
            {deviations && deviations.length > 0 && (
              <div className="rpt-card bg-white rounded-xl border border-gray-200 p-5">
                <p className="text-xs font-bold uppercase tracking-widest text-[#C8186C] mb-1">Principales desviaciones · {year} vs {year - 1}</p>
                <p className="text-xs text-gray-500 mb-4">
                  Enero a {MONTHS_ES[toMonth - 1].toLowerCase()}, {devScope}. Las 6 partidas con más diferencia en euros, las cuentas que más la explican{page === 'detail' ? ' y la variación de cada sociedad (cada una con sus eliminaciones, como sus columnas; consolidado = suma de sociedades − Intercompany)' : ''}.
                  En verde mejora el resultado (más ingreso o menos gasto), en rojo lo empeora. Haz clic en una cuenta para ver su desglose en la tabla.
                </p>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {deviations.map(x => (
                    <div key={x.l.code} className={`rounded-lg border p-3 ${x.diff < 0 ? 'border-red-200 bg-red-50/40' : 'border-emerald-200 bg-emerald-50/40'}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="font-bold text-gray-900">{x.l.description}</p>
                        <p className={`font-bold tabular-nums ${tone(x.diff)}`}>{x.diff > 0 ? '+' : ''}{num(x.diff, 0)} €</p>
                      </div>
                      <p className="text-xs text-gray-600 mt-0.5">
                        {num(x.prev, 0)} → {num(x.cur, 0)} ({pctChange(x.cur, x.prev)})
                        {x.pp != null && x.l.description !== SALES && <> · {x.pp >= 0 ? '+' : ''}{num(x.pp * 100, 1)} p.p. s/ Sales Revenues</>}
                      </p>
                      <table className="w-full text-[12px] mt-2">
                        <tbody>
                          {x.accounts.map(c => (
                            <tr key={c.a.account} className="border-t border-gray-200/70 cursor-pointer hover:bg-white"
                              onClick={() => { setOpen(o => ({ ...o, [x.l.code]: true })); openDrill(c.a, columns.find(col => col.key === devDrillCol)); }}
                              title="Ver el desglose de esta cuenta en la tabla">
                              <td className="py-1 pr-2 text-gray-700"><span className="tabular-nums text-gray-500 mr-1.5">{c.a.account}</span>{c.a.description}</td>
                              <td className={`py-1 text-right tabular-nums whitespace-nowrap font-semibold ${tone(c.diff)}`}>{c.diff > 0 ? '+' : ''}{num(c.diff, 0)}</td>
                              <td className="py-1 pl-2 text-right tabular-nums whitespace-nowrap text-gray-500">{pctChange(c.cur, c.prev)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {x.byCompany.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-gray-200/70">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">Por sociedad</p>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
                            {x.byCompany.map(b => (
                              <span key={b.c} className="whitespace-nowrap">
                                <span className="text-gray-600">{b.c === INTERCO ? 'Intercompany' : b.c}</span>{' '}
                                <span className={`font-semibold tabular-nums ${tone(b.diff)}`}>{b.diff > 0 ? '+' : ''}{num(b.diff, 0)}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
    </Section>
  );
}
