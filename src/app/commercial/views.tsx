'use client';

import { Fragment, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { FileDown, MinusSquare, PlusSquare } from 'lucide-react';
import { Ctx, Facts, Filters, groupBy, keyFn, PARAMS, ParamId, pctVar, projection, records, totals, type Pair, type Rec } from './engine';
import { Bars, Card, COLORS, Donut, fmtMoney, fmtNum, fmtPct, fmtShare, Gauge, Kpi, LineArea, tone } from './ui';
import { useT } from '@/contexts/LanguageContext';

// Páginas de Commercial Analysis (mismas que el Power BI): YoY Status, Sales Performance, Budget (Summary, Analysis,
// MoTD vs Forecast).

type P = { ctx: Ctx; facts: Facts[]; filters: Filters };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap text-right';
const td = 'py-1.5 px-2 whitespace-nowrap tabular-nums text-right';

// t + etiqueta de grupo: las de "(sin …)" del motor se traducen; los nombres de BC no
function useTL() {
  const { t } = useT();
  const L = (k: string) => (k.startsWith('(') ? t(k) : k);
  return { t, L };
}

function ParamSelect({ value, onChange, label }: { value: ParamId; onChange: (v: ParamId) => void; label?: string }) {
  const { t } = useT();
  return (
    <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2">
      {label ?? t('View by')}
      <select value={value} onChange={e => onChange(e.target.value as ParamId)} className="border border-gray-300 rounded-lg px-2 py-1 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal">
        {PARAMS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
    </label>
  );
}
const Var = ({ v }: { v: number | null }) => <span className={tone(v)}>{fmtPct(v)}</span>;
const exportRows = (name: string, rows: Record<string, unknown>[]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.substring(0, 31));
  XLSX.writeFile(wb, `Commercial_${name.replace(/\s+/g, '_')}.xlsx`);
};
const ExportBtn = ({ onClick }: { onClick: () => void }) => {
  const { t } = useT();
  return <button onClick={onClick} title={t('Export to Excel')} className="p-1.5 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900"><FileDown size={15} /></button>;
};
const sortedEntries = (map: Map<string, Pair>, by: (p: Pair) => number) => Array.from(map.entries()).sort((a, b) => by(b[1]) - by(a[1]));

// ---------- YoY Status ----------
export function YoYStatus({ ctx, facts, filters }: P) {
  const { t, L } = useTL();
  const recs = useMemo(() => records(ctx, facts, filters, 'ytd'), [ctx, facts, filters]);
  const tot = totals(recs);
  const cur = ctx.currency;
  const byMonth = groupBy(recs, r => String(r.m));
  const months = Array.from({ length: ctx.cutMonth }, (_, i) => i + 1);
  const byDim = sortedEntries(groupBy(recs, keyFn(ctx, 'dimension')), p => p.cur.sIn).slice(0, 15);
  const byKam = sortedEntries(groupBy(recs, keyFn(ctx, 'kam')), p => p.cur.sIn);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
        <Kpi highlight title={`Sell-in YTD ${ctx.year}`} value={fmtMoney(tot.cur.sIn, cur)}
          sub={<><p>YoY <Var v={pctVar(tot.cur.sIn, tot.prev.sIn)} /></p><p>vs. Budget <Var v={pctVar(tot.cur.sIn, tot.cur.bdg)} /></p></>} />
        <Kpi title={`Sell-in Prev. Year (${ctx.year - 1})`} value={fmtMoney(tot.prev.sIn, cur)} sub={<p className="text-gray-500">{t('Same period last year')}</p>} />
        <Kpi title="Budget MoTD" value={fmtMoney(tot.cur.bdg, cur)} sub={<p className="text-gray-500">{t('Budget of the months up to today')}</p>} />
        <Kpi title={t('Invoiced / Open orders')} value={fmtMoney(tot.cur.inv, cur)} sub={<p className="text-gray-500">{t('+ {amount} in open orders', { amount: fmtMoney(tot.cur.so, cur) })}</p>} />
        <Kpi highlight title={`Sell-in Units YTD ${ctx.year}`} value={fmtNum(tot.cur.sInQty)}
          sub={<><p>YoY <Var v={pctVar(tot.cur.sInQty, tot.prev.sInQty)} /></p><p>vs. Budget <Var v={pctVar(tot.cur.sInQty, tot.cur.bdgQty)} /></p></>} />
        <Kpi title="Sell-in Units Prev. Year" value={fmtNum(tot.prev.sInQty)} />
        <Kpi title="Budget Units MoTD" value={fmtNum(tot.cur.bdgQty)} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={t('Sell-in by month')}>
          <LineArea labels={months.map(m => MONTHS[m - 1])} series={[
            { label: 'Sell-in Prev. Year', data: months.map(m => byMonth.get(String(m))?.prev.sIn || 0), color: COLORS.prev },
            { label: 'Sell-in Year', data: months.map(m => byMonth.get(String(m))?.cur.sIn || 0), color: COLORS.cur, fill: true },
            { label: 'Budget MoTD', data: months.map(m => byMonth.get(String(m))?.cur.bdg || 0), color: COLORS.bdg, dash: true },
          ]} />
        </Card>
        <Card title={t('Sell-in by Dimension (top 15)')}>
          <Bars horizontal height={Math.max(260, byDim.length * 28)} labels={byDim.map(([k]) => L(k))} series={[
            { label: 'Sell-in Prev. Year', data: byDim.map(([, p]) => p.prev.sIn), color: COLORS.prev },
            { label: 'Sell-in Year', data: byDim.map(([, p]) => p.cur.sIn), color: COLORS.cur },
            { label: 'Budget MoTD', data: byDim.map(([, p]) => p.cur.bdg), color: COLORS.bdg },
          ]} />
        </Card>
        <Card title={t('Sell-in Year by KAM ({year})', { year: ctx.year })}><Donut labels={byKam.map(([k]) => L(k))} data={byKam.map(([, p]) => Math.max(0, p.cur.sIn))} /></Card>
        <Card title={t('Sell-in Prev. Year by KAM ({year})', { year: ctx.year - 1 })}><Donut labels={byKam.map(([k]) => L(k))} data={byKam.map(([, p]) => Math.max(0, p.prev.sIn))} /></Card>
      </div>
    </div>
  );
}

// ---------- Sales Performance ----------
// Como la página del Power BI (sin filtro de fecha): el año entero, con los pedidos abiertos de meses futuros
export function SalesPerformance({ ctx, facts, filters }: P) {
  const { t } = useT();
  const recs = useMemo(() => records(ctx, facts, filters, 'full'), [ctx, facts, filters]);
  const months = Array.from({ length: 12 }, (_, i) => i + 1).filter(m => !filters.months.length || filters.months.includes(m));
  const byMonth = groupBy(recs, r => String(r.m));
  const tot = totals(recs);
  const cur = ctx.currency;
  // Δ desde ayer: pedidos de venta con Order Date desde el día laborable anterior (el lunes, desde el viernes), por el mes de
  // su Requested Delivery Date (solo datos calculados hoy: los guardados de un día anterior traen los pedidos de esos días)
  const todayFacts = useMemo(() => facts.filter(f => f.cutoff === new Date().toISOString().substring(0, 10)), [facts]);
  const dRecs = useMemo(() => records(ctx, todayFacts, filters, 'full', 'noComponent', 'delta'), [ctx, todayFacts, filters]);
  const dByMonth = groupBy(dRecs, r => String(r.m));
  const dOf = (m: number) => dByMonth.get(String(m))?.cur.sIn || 0;
  const dTotal = totals(dRecs).cur.sIn;
  const dTitle = t('Sales orders with Order Date yesterday or today (on Monday, since Friday): amount of their lines, in the month of their Requested Delivery Date');
  const Delta = ({ v }: { v: number }) => (Math.abs(v) < 0.5 ? <span className="text-gray-300">–</span> : <span className={v > 0 ? 'text-emerald-700' : 'text-red-600'}>{v > 0 ? '+' : ''}{fmtNum(v)}</span>);
  let acm = { prev: 0, cur: 0, bdg: 0 };
  const monthRows = months.map(m => {
    const p = byMonth.get(String(m)) || { cur: totals([]).cur, prev: totals([]).prev };
    acm = { prev: acm.prev + p.prev.sIn, cur: acm.cur + p.cur.sIn, bdg: acm.bdg + p.cur.bdg };
    return { m, p, acm: { ...acm } };
  });
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={t('Month by month and cumulative (full year)')} right={<ExportBtn onClick={() => exportRows(t('Sales Performance monthly'), monthRows.map(r => ({
          [t('Month')]: MONTHS[r.m - 1], 'Sell-in Prev. Year': r.p.prev.sIn, 'Sell-in Year': r.p.cur.sIn, [t('Δ since yesterday')]: dOf(r.m), Budget: r.p.cur.bdg,
          'Acm. Sell-in Prev. Year': r.acm.prev, 'Acm. Sell-in Year': r.acm.cur, 'Acm. Budget': r.acm.bdg,
        })))} />}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="border-b border-gray-200">
                <th className={`${th} text-left`}>Mo.</th><th className={th}>Sell-in Prev. Year</th><th className={th}>%</th><th className={th}>Sell-in Year</th><th className={th} title={dTitle}>{t('Δ since yesterday')}</th><th className={th}>% vs Bdg</th><th className={th}>Budget</th>
                <th className={th}>Acm. Prev. Year</th><th className={th}>%</th><th className={th}>Acm. Year</th><th className={th}>% vs Bdg</th><th className={th}>Acm. Budget</th>
              </tr></thead>
              <tbody>
                {monthRows.map(({ m, p, acm: a }) => (
                  <tr key={m} className="border-b border-gray-100">
                    <td className="py-1.5 px-2 font-semibold">{MONTHS[m - 1]}</td>
                    <td className={td}>{fmtNum(p.prev.sIn)}</td><td className={td}><Var v={pctVar(p.cur.sIn, p.prev.sIn)} /></td>
                    <td className={`${td} font-semibold`}>{fmtNum(p.cur.sIn)}</td><td className={td} title={dTitle}><Delta v={dOf(m)} /></td><td className={td}><Var v={pctVar(p.cur.sIn, p.cur.bdg)} /></td><td className={td}>{fmtNum(p.cur.bdg)}</td>
                    <td className={td}>{fmtNum(a.prev)}</td><td className={td}><Var v={pctVar(a.cur, a.prev)} /></td>
                    <td className={`${td} font-semibold`}>{fmtNum(a.cur)}</td><td className={td}><Var v={pctVar(a.cur, a.bdg)} /></td><td className={td}>{fmtNum(a.bdg)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-gray-300 font-bold bg-gray-50">
                <td className="py-1.5 px-2">Total</td>
                <td className={td}>{fmtNum(tot.prev.sIn)}</td><td className={td}><Var v={pctVar(tot.cur.sIn, tot.prev.sIn)} /></td>
                <td className={td}>{fmtNum(tot.cur.sIn)}</td><td className={td} title={dTitle}><Delta v={dTotal} /></td><td className={td}><Var v={pctVar(tot.cur.sIn, tot.cur.bdg)} /></td><td className={td}>{fmtNum(tot.cur.bdg)}</td>
                <td colSpan={5} className={`${td} text-gray-400 font-normal`}>{cur}</td>
              </tr></tfoot>
            </table>
          </div>
        </Card>
        <Card title={t('Sell-in by month')}>
          <Bars labels={months.map(m => MONTHS[m - 1])} series={[
            { label: 'Sell-in Prev. Year', data: months.map(m => byMonth.get(String(m))?.prev.sIn || 0), color: COLORS.prev },
            { label: 'Sell-in Year', data: months.map(m => byMonth.get(String(m))?.cur.sIn || 0), color: COLORS.cur },
            { label: 'Budget', data: months.map(m => byMonth.get(String(m))?.cur.bdg || 0), color: COLORS.bdg },
          ]} />
        </Card>
      </div>
      <DetailTree ctx={ctx} recs={recs} />
    </div>
  );
}

// ---------- Detalle por varias características (como la matriz del Power BI) ----------

// Nodo de la matriz: grupo de un nivel con sus importes y, si hay más niveles, sus subgrupos
type TreeNode = { key: string; path: string; p: Pair; children: TreeNode[] };
function buildTree(ctx: Ctx, recs: Rec[], params: ParamId[], parent = ''): TreeNode[] {
  if (!params.length) return [];
  const key = keyFn(ctx, params[0]);
  const by = new Map<string, Rec[]>();
  for (const r of recs) {
    const k = key(r);
    const list = by.get(k);
    if (list) list.push(r); else by.set(k, [r]);
  }
  return Array.from(by.entries())
    .map(([k, list]) => {
      const path = parent ? `${parent}\u0001${k}` : k;
      return { key: k, path, p: totals(list), children: buildTree(ctx, list, params.slice(1), path) };
    })
    .sort((a, b) => b.p.cur.sIn - a.p.cur.sIn);
}

// Detalle (año completo): se eligen una o varias características en orden (1.º, 2.º…), como los botones del Power BI;
// cada fila del primer nivel se despliega en el siguiente
function DetailTree({ ctx, recs }: { ctx: Ctx; recs: Rec[] }) {
  const { t, L } = useTL();
  const [params, setParams] = useState<ParamId[]>(['customer']);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(ctx, recs, params), [ctx, recs, params]);
  const tot = totals(recs);
  const label = (id: ParamId) => PARAMS.find(x => x.id === id)!.label;
  const toggleParam = (id: ParamId) => {
    setParams(prev => (prev.includes(id) ? (prev.length > 1 ? prev.filter(x => x !== id) : prev) : [...prev, id]));
    setOpen(new Set());
  };
  const toggleRow = (path: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const allPaths = (nodes: TreeNode[]): string[] => nodes.flatMap(n => (n.children.length ? [n.path, ...allPaths(n.children)] : []));
  // Filas visibles: cada nodo y, si está desplegado, sus hijos
  const visible: { n: TreeNode; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      visible.push({ n, depth });
      if (n.children.length && open.has(n.path)) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  // Excel: todas las filas del último nivel, con una columna por característica
  const exportAll = () => {
    const rows: Record<string, unknown>[] = [];
    const add = (nodes: TreeNode[], keys: string[]) => {
      for (const n of nodes) {
        const ks = [...keys, n.key];
        if (n.children.length) { add(n.children, ks); continue; }
        rows.push({
          ...Object.fromEntries(params.map((id, i) => [label(id), L(ks[i])])),
          'Sell-in Prev. Year': n.p.prev.sIn, 'Sell-in Year': n.p.cur.sIn, Budget: n.p.cur.bdg,
          'Units Prev. Year': n.p.prev.sInQty, 'Units Year': n.p.cur.sInQty, 'Budget Units': n.p.cur.bdgQty,
        });
      }
    };
    add(tree, []);
    exportRows(`Sales Performance ${params.join('-')}`, rows);
  };
  const nums = (p: Pair) => (
    <>
      <td className={td}>{fmtNum(p.prev.sIn)}</td><td className={td}><Var v={pctVar(p.cur.sIn, p.prev.sIn)} /></td>
      <td className={`${td} font-semibold`}>{fmtNum(p.cur.sIn)}</td><td className={td}><Var v={pctVar(p.cur.sIn, p.cur.bdg)} /></td><td className={td}>{fmtNum(p.cur.bdg)}</td>
      <td className={td}>{fmtNum(p.prev.sInQty)}</td><td className={td}><Var v={pctVar(p.cur.sInQty, p.prev.sInQty)} /></td>
      <td className={`${td} font-semibold`}>{fmtNum(p.cur.sInQty)}</td><td className={td}><Var v={pctVar(p.cur.sInQty, p.cur.bdgQty)} /></td><td className={td}>{fmtNum(p.cur.bdgQty)}</td>
    </>
  );
  return (
    <Card title={t('Detail (full year)')} right={<div className="flex items-center gap-2">
      {params.length > 1 && (
        <>
          <button onClick={() => setOpen(new Set(allPaths(tree)))} className="text-xs font-semibold text-gray-600 hover:text-gray-900">{t('Expand all')}</button>
          <button onClick={() => setOpen(new Set())} className="text-xs font-semibold text-gray-600 hover:text-gray-900">{t('Collapse all')}</button>
        </>
      )}
      <ExportBtn onClick={exportAll} />
    </div>}>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-11 gap-1.5 mb-3">
        {PARAMS.map(x => {
          const i = params.indexOf(x.id);
          return (
            <button key={x.id} onClick={() => toggleParam(x.id)} title={i >= 0 ? t('Level {n}', { n: i + 1 }) : t('Add as next level')}
              className={`relative px-2 py-1.5 rounded-md text-xs font-semibold border ${i >= 0 ? 'bg-black text-white border-black' : 'bg-gray-100 text-gray-700 border-gray-200 hover:border-gray-400'}`}>
              {x.label}
              {i >= 0 && params.length > 1 && <span className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-[#C8186C] text-[10px] leading-4 text-white">{i + 1}</span>}
            </button>
          );
        })}
      </div>
      <div className="overflow-x-auto max-h-[600px]">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-200">
            <th className={`${th} text-left`}>{params.map(label).join(' › ')}</th>
            <th className={th}>Sell-in Prev. Year</th><th className={th}>%chg</th><th className={th}>Sell-in Year</th><th className={th}>%chg vs Bdg</th><th className={th}>Budget</th>
            <th className={th}>Units Prev. Year</th><th className={th}>%chg</th><th className={th}>Units Year</th><th className={th}>%chg vs Bdg</th><th className={th}>Budget Units</th>
          </tr></thead>
          <tbody>
            {visible.map(({ n, depth }) => (
              <tr key={n.path} className={`border-b border-gray-100 hover:bg-gray-50 ${depth === 0 && params.length > 1 ? 'font-semibold' : ''}`}>
                <td className="py-1.5 px-2 max-w-[380px]" title={L(n.key)}>
                  <div className="flex items-center gap-1.5 truncate" style={{ paddingLeft: depth * 18 }}>
                    {n.children.length ? (
                      <button onClick={() => toggleRow(n.path)} className="text-gray-500 hover:text-gray-900 shrink-0" aria-label={open.has(n.path) ? t('Collapse') : t('Expand')}>
                        {open.has(n.path) ? <MinusSquare size={14} /> : <PlusSquare size={14} />}
                      </button>
                    ) : params.length > 1 ? <span className="w-[14px] shrink-0" /> : null}
                    <span className="truncate">{L(n.key)}</span>
                  </div>
                </td>
                {nums(n.p)}
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0"><tr className="border-t-2 border-gray-300 font-bold bg-gray-50">
            <td className="py-1.5 px-2">Total</td>
            {nums(tot)}
          </tr></tfoot>
        </table>
      </div>
    </Card>
  );
}

// ---------- Budget (Summary, Analysis, MoTD vs. Forecast) ----------
export function Budget({ ctx, facts, filters }: P) {
  const { t, L } = useTL();
  const [view, setView] = useState<'summary' | 'analysis' | 'motd'>('summary');
  const [param, setParam] = useState<ParamId>('customer');
  const [monthly, setMonthly] = useState(false);
  const full = useMemo(() => records(ctx, facts, filters, 'full'), [ctx, facts, filters]);
  const motd = useMemo(() => records(ctx, facts, filters, 'motd'), [ctx, facts, filters]);
  const cur = ctx.currency;
  const tot = totals(full);
  const proj = projection(ctx, full);
  const byMonth = groupBy(full, r => String(r.m));
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const projMonth = (m: number) => projection(ctx, full.filter(r => r.m === m)).rev;

  const head = (
    <div className="grid gap-3 grid-cols-2 xl:grid-cols-5">
      <Kpi highlight title={`Sell-in ${ctx.year}`} value={fmtMoney(tot.cur.sIn, cur)} sub={<p>vs. Budget <Var v={pctVar(tot.cur.sIn, tot.cur.bdg)} /></p>} />
      <Kpi title={`Budget FY ${ctx.year}`} value={fmtMoney(tot.cur.bdg, cur)} />
      <Kpi title="Projection FY" value={fmtMoney(proj.rev, cur)} sub={<><p>vs. Budget <Var v={pctVar(proj.rev, tot.cur.bdg)} /></p><p className="text-gray-500">{t('Closed months invoiced + forecast for the rest')}</p></>} />
      <div className="xl:col-span-2 bg-white rounded-xl border border-gray-200 p-4 flex flex-col justify-center">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Sell-in vs. Budget</p>
        <Gauge value={tot.cur.sIn} target={proj.rev} max={tot.cur.bdg} currency={cur} />
      </div>
    </div>
  );

  const tabs = (
    <div className="flex bg-gray-100 rounded-lg p-1 w-fit">
      {([['summary', 'Budget Summary'], ['analysis', 'Budget Analysis'], ['motd', 'MoTD vs. Forecast']] as const).map(([id, label]) => (
        <button key={id} onClick={() => setView(id)} className={`px-3 py-1 rounded-md text-sm font-semibold ${view === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>{label}</button>
      ))}
    </div>
  );

  if (view === 'summary') {
    const byCust = sortedEntries(groupBy(full, keyFn(ctx, 'customer')), p => p.cur.bdg || p.cur.sIn);
    const byBu = sortedEntries(groupBy(full, keyFn(ctx, 'bu')), p => p.cur.sIn);
    const byKam = sortedEntries(groupBy(full, keyFn(ctx, 'kam')), p => p.cur.sIn);
    return (
      <div className="space-y-4">
        {tabs}{head}
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title={t('By month: budget, projection and sell-in')}>
            <LineArea labels={MONTHS} series={[
              { label: 'Budget', data: months.map(m => byMonth.get(String(m))?.cur.bdg || 0), color: COLORS.bdg, dash: true },
              { label: 'Projection', data: months.map(projMonth), color: COLORS.proj },
              { label: 'Sell-in Year', data: months.map(m => (m <= ctx.cutMonth ? byMonth.get(String(m))?.cur.sIn || 0 : null)), color: COLORS.cur, fill: true },
              { label: 'Sell-in Prev. Year', data: months.map(m => byMonth.get(String(m))?.prev.sIn || 0), color: COLORS.prev },
            ]} />
          </Card>
          <Card title={t('By Business Unit')}>
            <Bars labels={byBu.map(([k]) => L(k))} series={[
              { label: 'Sell-in Prev. Year', data: byBu.map(([, p]) => p.prev.sIn), color: COLORS.prev },
              { label: 'Sell-in Year', data: byBu.map(([, p]) => p.cur.sIn), color: COLORS.cur },
              { label: 'Budget', data: byBu.map(([, p]) => p.cur.bdg), color: COLORS.bdg },
            ]} />
          </Card>
          <Card title={t('Sell-in by KAM')}><Donut labels={byKam.map(([k]) => L(k))} data={byKam.map(([, p]) => Math.max(0, p.cur.sIn))} /></Card>
          <Card title={t('Budget by KAM')}><Donut labels={byKam.map(([k]) => L(k))} data={byKam.map(([, p]) => Math.max(0, p.cur.bdg))} /></Card>
        </div>
        <Card title={t('By Customer')} right={<ExportBtn onClick={() => exportRows(t('Budget by Customer'), byCust.map(([k, p]) => ({ Customer: L(k), Invoice: p.cur.inv, 'SO/RE': p.cur.so, 'Diff to Bdg': p.cur.sIn - p.cur.bdg, Budget: p.cur.bdg })))} />}>
          <div className="overflow-x-auto max-h-[500px]">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-200">
                <th className={`${th} text-left`}>Customer</th><th className={th}>Invoice</th><th className={th}>SO/RE</th><th className={th}>Diff to Bdg</th><th className={th}>Budget</th><th className={th}>% Budget</th>
              </tr></thead>
              <tbody>
                {byCust.map(([k, p]) => (
                  <tr key={k} className="border-b border-gray-100">
                    <td className="py-1.5 px-2">{L(k)}</td><td className={td}>{fmtNum(p.cur.inv)}</td><td className={td}>{fmtNum(p.cur.so)}</td>
                    <td className={`${td} ${tone(p.cur.sIn - p.cur.bdg)}`}>{fmtNum(p.cur.sIn - p.cur.bdg)}</td><td className={td}>{fmtNum(p.cur.bdg)}</td>
                    <td className={td}>{p.cur.bdg ? fmtShare(p.cur.sIn / p.cur.bdg) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  }

  if (view === 'analysis') {
    const key = keyFn(ctx, param);
    const rows = sortedEntries(groupBy(full, key), p => p.cur.bdg || p.cur.sIn);
    const projBy = (k: string, m?: number) => projection(ctx, full.filter(r => key(r) === k && (m === undefined || r.m === m)));
    // Vista por mes: 4 medidas por fila (las mismas en pantalla y en el Excel)
    const monthLines = (k: string): [string, (m: number) => number][] => [
      ['Prev. Year', m => full.filter(r => r.y === 'prev' && r.m === m && key(r) === k).reduce((s, r) => s + r.inv + r.so, 0)],
      ['Year', m => full.filter(r => r.y === 'cur' && r.m === m && key(r) === k).reduce((s, r) => s + r.inv + r.so, 0)],
      ['Projection', m => projBy(k, m).rev],
      ['Budget', m => full.filter(r => r.y === 'cur' && r.m === m && key(r) === k).reduce((s, r) => s + r.bdg, 0)],
    ];
    const paramLabel = PARAMS.find(x => x.id === param)!.label;
    const exportMonthly = () => exportRows(t('Budget Analysis {param} by month', { param }), rows.flatMap(([k]) => monthLines(k).map(([label, f]) => {
      const vals = MONTHS.map((_, mi) => f(mi + 1));
      return { [paramLabel]: L(k), [t('Measure')]: label, ...Object.fromEntries(MONTHS.map((m, mi) => [m, vals[mi]])), Total: vals.reduce((a, b) => a + b, 0) };
    })));
    return (
      <div className="space-y-4">
        {tabs}{head}
        <Card title={t('Full year: previous, current, projection and budget')} right={<div className="flex items-center gap-3">
          <ParamSelect value={param} onChange={setParam} label="Check data by" />
          <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={monthly} onChange={e => setMonthly(e.target.checked)} /> {t('by month')}</label>
          <ExportBtn onClick={() => monthly ? exportMonthly() : exportRows(`Budget Analysis ${param}`, rows.map(([k, p]) => { const pr = projBy(k); return {
            [PARAMS.find(x => x.id === param)!.label]: L(k), 'Prev. Year Turnover': p.prev.sIn, 'Year Turnover': p.cur.sIn, 'Projection Turnover': pr.rev, 'Budget Turnover': p.cur.bdg,
            'Prev. Year Units': p.prev.sInQty, 'Year Units': p.cur.sInQty, 'Projection Units': pr.qty, 'Budget Units': p.cur.bdgQty,
          }; }))} /></div>}>
          <div className="overflow-x-auto max-h-[650px]">
            {!monthly ? (
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-200">
                  <th className={`${th} text-left`}>{PARAMS.find(x => x.id === param)!.label}</th>
                  <th className={th}>Prev. Year Turnover</th><th className={th}>Year Turnover</th><th className={th}>Projection Turnover</th><th className={th}>Budget Turnover</th>
                  <th className={th}>Prev. Year Units</th><th className={th}>Year Units</th><th className={th}>Projection Units</th><th className={th}>Budget Units</th>
                </tr></thead>
                <tbody>
                  {rows.map(([k, p]) => { const pr = projBy(k); return (
                    <tr key={k} className="border-b border-gray-100">
                      <td className="py-1.5 px-2 max-w-[340px] truncate" title={L(k)}>{L(k)}</td>
                      <td className={td}>{fmtNum(p.prev.sIn)}</td><td className={`${td} font-semibold`}>{fmtNum(p.cur.sIn)}</td><td className={td}>{fmtNum(pr.rev)}</td><td className={td}>{fmtNum(p.cur.bdg)}</td>
                      <td className={td}>{fmtNum(p.prev.sInQty)}</td><td className={`${td} font-semibold`}>{fmtNum(p.cur.sInQty)}</td><td className={td}>{fmtNum(pr.qty)}</td><td className={td}>{fmtNum(p.cur.bdgQty)}</td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-200">
                  <th className={`${th} text-left`}>{PARAMS.find(x => x.id === param)!.label}</th><th className={`${th} text-left`}>{t('Measure')}</th>
                  {MONTHS.map(m => <th key={m} className={th}>{m}</th>)}
                </tr></thead>
                <tbody>
                  {rows.slice(0, 100).map(([k]) => {
                    const lines = monthLines(k);
                    return (
                      <Fragment key={k}>
                        {lines.map(([label, f], i) => (
                          <tr key={label} className={`${i === 3 ? 'border-b border-gray-200' : ''}`}>
                            {i === 0 && <td rowSpan={4} className="py-1 px-2 align-top max-w-[260px] truncate font-semibold" title={L(k)}>{L(k)}</td>}
                            <td className="py-1 px-2 text-gray-500">{label}</td>
                            {MONTHS.map((_, mi) => <td key={mi} className={`${td} py-1`}>{fmtNum(f(mi + 1))}</td>)}
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {monthly && rows.length > 100 && <p className="text-xs text-gray-500 mt-2">{t('Monthly view limited to the first 100 rows; the Excel has all of them.')}</p>}
        </Card>
      </div>
    );
  }

  // MoTD vs. Forecast: acumulado hasta el final del mes anterior, facturado frente a forecast
  const key = keyFn(ctx, param);
  const rows = sortedEntries(groupBy(motd, key), p => p.cur.fc || p.cur.inv);
  const tm = totals(motd);
  return (
    <div className="space-y-4">
      {tabs}
      <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
        <Kpi highlight title="Acm. Invoiced (MoTD)" value={fmtMoney(tm.cur.inv, cur)} sub={<p>vs. Forecast <Var v={pctVar(tm.cur.inv, tm.cur.fc)} /></p>} />
        <Kpi title="Acm. Forecast (MoTD)" value={fmtMoney(tm.cur.fc, cur)} />
        <Kpi title="Acm. Invoiced Units" value={fmtNum(tm.cur.invQty)} sub={<p>vs. Forecast <Var v={pctVar(tm.cur.invQty, tm.cur.fcQty)} /></p>} />
        <Kpi title="Acm. Forecast Units" value={fmtNum(tm.cur.fcQty)} />
      </div>
      <Card title={t('Up to the end of last month ({month} {year})', { month: MONTHS[Math.max(0, ctx.cutMonth - 2)], year: ctx.year })} right={<div className="flex items-center gap-2">
        <ParamSelect value={param} onChange={setParam} label="Check data by" />
        <ExportBtn onClick={() => exportRows(`MoTD vs Forecast ${param}`, rows.map(([k, p]) => ({
          [PARAMS.find(x => x.id === param)!.label]: L(k), 'Acm. Invoiced Turnover': p.cur.inv, 'Acm. Forecast Turnover': p.cur.fc, 'Var.': p.cur.inv - p.cur.fc,
          'Acm. Invoiced Units': p.cur.invQty, 'Acm. Forecast Units': p.cur.fcQty, 'Var. Units': p.cur.invQty - p.cur.fcQty,
        })))} /></div>}>
        <div className="overflow-x-auto max-h-[650px]">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-200">
              <th className={`${th} text-left`}>{PARAMS.find(x => x.id === param)!.label}</th>
              <th className={th}>Acm. Invoiced Turnover</th><th className={th}>Acm. Forecast Turnover</th><th className={th}>Var.</th>
              <th className={th}>Acm. Invoiced Units</th><th className={th}>Acm. Forecast Units</th><th className={th}>Var.</th>
            </tr></thead>
            <tbody>
              {rows.map(([k, p]) => (
                <tr key={k} className="border-b border-gray-100">
                  <td className="py-1.5 px-2 max-w-[340px] truncate" title={L(k)}>{L(k)}</td>
                  <td className={`${td} font-semibold`}>{fmtNum(p.cur.inv)}</td><td className={td}>{fmtNum(p.cur.fc)}</td><td className={`${td} ${tone(p.cur.inv - p.cur.fc)}`}>{fmtNum(p.cur.inv - p.cur.fc)}</td>
                  <td className={`${td} font-semibold`}>{fmtNum(p.cur.invQty)}</td><td className={td}>{fmtNum(p.cur.fcQty)}</td><td className={`${td} ${tone(p.cur.invQty - p.cur.fcQty)}`}>{fmtNum(p.cur.invQty - p.cur.fcQty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
