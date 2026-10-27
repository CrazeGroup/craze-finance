'use client';

import { Fragment, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { FileDown } from 'lucide-react';
import { Ctx, Facts, Filters, groupBy, keyFn, PARAMS, ParamId, pctVar, projection, records, totals, type Pair } from './engine';
import { Bars, Card, COLORS, Donut, fmtMoney, fmtNum, fmtPct, fmtShare, Gauge, Kpi, LineArea, tone } from './ui';

// Páginas de Commercial Analysis (mismas que el Power BI): YoY Status, Sales Performance, Budget (Summary, Analysis,
// MoTD vs Forecast), Rule 80-20 y Top 50 Items.

type P = { ctx: Ctx; facts: Facts[]; filters: Filters };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap text-right';
const td = 'py-1.5 px-2 whitespace-nowrap tabular-nums text-right';

function ParamSelect({ value, onChange, label = 'Ver por' }: { value: ParamId; onChange: (v: ParamId) => void; label?: string }) {
  return (
    <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2">
      {label}
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
const ExportBtn = ({ onClick }: { onClick: () => void }) => (
  <button onClick={onClick} title="Exportar a Excel" className="p-1.5 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900"><FileDown size={15} /></button>
);
const sortedEntries = (map: Map<string, Pair>, by: (p: Pair) => number) => Array.from(map.entries()).sort((a, b) => by(b[1]) - by(a[1]));

// ---------- YoY Status ----------
export function YoYStatus({ ctx, facts, filters }: P) {
  const recs = useMemo(() => records(ctx, facts, filters, 'ytd'), [ctx, facts, filters]);
  const t = totals(recs);
  const cur = ctx.currency;
  const byMonth = groupBy(recs, r => String(r.m));
  const months = Array.from({ length: ctx.cutMonth }, (_, i) => i + 1);
  const byDim = sortedEntries(groupBy(recs, keyFn(ctx, 'dimension')), p => p.cur.sIn).slice(0, 15);
  const byKam = sortedEntries(groupBy(recs, keyFn(ctx, 'kam')), p => p.cur.sIn);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
        <Kpi highlight title={`Sell-in YTD ${ctx.year}`} value={fmtMoney(t.cur.sIn, cur)}
          sub={<><p>YoY <Var v={pctVar(t.cur.sIn, t.prev.sIn)} /></p><p>vs. Budget <Var v={pctVar(t.cur.sIn, t.cur.bdg)} /></p></>} />
        <Kpi title={`Sell-in Prev. Year (${ctx.year - 1})`} value={fmtMoney(t.prev.sIn, cur)} sub={<p className="text-gray-500">Mismo periodo del año anterior</p>} />
        <Kpi title="Budget MoTD" value={fmtMoney(t.cur.bdg, cur)} sub={<p className="text-gray-500">Presupuesto de los meses hasta hoy</p>} />
        <Kpi title="Facturado / Pedidos abiertos" value={fmtMoney(t.cur.inv, cur)} sub={<p className="text-gray-500">+ {fmtMoney(t.cur.so, cur)} en pedidos abiertos</p>} />
        <Kpi highlight title={`Sell-in Units YTD ${ctx.year}`} value={fmtNum(t.cur.sInQty)}
          sub={<><p>YoY <Var v={pctVar(t.cur.sInQty, t.prev.sInQty)} /></p><p>vs. Budget <Var v={pctVar(t.cur.sInQty, t.cur.bdgQty)} /></p></>} />
        <Kpi title="Sell-in Units Prev. Year" value={fmtNum(t.prev.sInQty)} />
        <Kpi title="Budget Units MoTD" value={fmtNum(t.cur.bdgQty)} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Sell-in por mes">
          <LineArea labels={months.map(m => MONTHS[m - 1])} series={[
            { label: 'Sell-in Prev. Year', data: months.map(m => byMonth.get(String(m))?.prev.sIn || 0), color: COLORS.prev },
            { label: 'Sell-in Year', data: months.map(m => byMonth.get(String(m))?.cur.sIn || 0), color: COLORS.cur, fill: true },
            { label: 'Budget MoTD', data: months.map(m => byMonth.get(String(m))?.cur.bdg || 0), color: COLORS.bdg, dash: true },
          ]} />
        </Card>
        <Card title="Sell-in por Dimension (top 15)">
          <Bars horizontal height={Math.max(260, byDim.length * 28)} labels={byDim.map(([k]) => k)} series={[
            { label: 'Sell-in Prev. Year', data: byDim.map(([, p]) => p.prev.sIn), color: COLORS.prev },
            { label: 'Sell-in Year', data: byDim.map(([, p]) => p.cur.sIn), color: COLORS.cur },
            { label: 'Budget MoTD', data: byDim.map(([, p]) => p.cur.bdg), color: COLORS.bdg },
          ]} />
        </Card>
        <Card title={`Sell-in Year por KAM (${ctx.year})`}><Donut labels={byKam.map(([k]) => k)} data={byKam.map(([, p]) => Math.max(0, p.cur.sIn))} /></Card>
        <Card title={`Sell-in Prev. Year por KAM (${ctx.year - 1})`}><Donut labels={byKam.map(([k]) => k)} data={byKam.map(([, p]) => Math.max(0, p.prev.sIn))} /></Card>
      </div>
    </div>
  );
}

// ---------- Sales Performance ----------
// Como la página del Power BI (sin filtro de fecha): el año entero, con los pedidos abiertos de meses futuros
export function SalesPerformance({ ctx, facts, filters }: P) {
  const [param, setParam] = useState<ParamId>('customer');
  const recs = useMemo(() => records(ctx, facts, filters, 'full'), [ctx, facts, filters]);
  const months = Array.from({ length: 12 }, (_, i) => i + 1).filter(m => !filters.months.length || filters.months.includes(m));
  const byMonth = groupBy(recs, r => String(r.m));
  const detail = sortedEntries(groupBy(recs, keyFn(ctx, param)), p => p.cur.sIn);
  const t = totals(recs);
  const cur = ctx.currency;
  // Δ hoy: pedidos de venta con Order Date de hoy, por el mes de su Requested Delivery Date
  // (solo datos calculados hoy: los guardados de un día anterior traen los pedidos de ese día)
  const todayFacts = useMemo(() => facts.filter(f => f.cutoff === new Date().toISOString().substring(0, 10)), [facts]);
  const dRecs = useMemo(() => records(ctx, todayFacts, filters, 'full', 'noComponent', 'delta'), [ctx, todayFacts, filters]);
  const dByMonth = groupBy(dRecs, r => String(r.m));
  const dOf = (m: number) => dByMonth.get(String(m))?.cur.sIn || 0;
  const dTotal = totals(dRecs).cur.sIn;
  const dTitle = 'Pedidos de venta con Order Date de hoy (importe de sus líneas, en el mes de su Requested Delivery Date)';
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
        <Card title="Mes a mes y acumulado (año completo)" right={<ExportBtn onClick={() => exportRows('Sales Performance mensual', monthRows.map(r => ({
          Mes: MONTHS[r.m - 1], 'Sell-in Prev. Year': r.p.prev.sIn, 'Sell-in Year': r.p.cur.sIn, 'Δ hoy': dOf(r.m), Budget: r.p.cur.bdg,
          'Acm. Sell-in Prev. Year': r.acm.prev, 'Acm. Sell-in Year': r.acm.cur, 'Acm. Budget': r.acm.bdg,
        })))} />}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="border-b border-gray-200">
                <th className={`${th} text-left`}>Mo.</th><th className={th}>Sell-in Prev. Year</th><th className={th}>%</th><th className={th}>Sell-in Year</th><th className={th} title={dTitle}>Δ hoy</th><th className={th}>% vs Bdg</th><th className={th}>Budget</th>
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
                <td className={td}>{fmtNum(t.prev.sIn)}</td><td className={td}><Var v={pctVar(t.cur.sIn, t.prev.sIn)} /></td>
                <td className={td}>{fmtNum(t.cur.sIn)}</td><td className={td} title={dTitle}><Delta v={dTotal} /></td><td className={td}><Var v={pctVar(t.cur.sIn, t.cur.bdg)} /></td><td className={td}>{fmtNum(t.cur.bdg)}</td>
                <td colSpan={5} className={`${td} text-gray-400 font-normal`}>{cur}</td>
              </tr></tfoot>
            </table>
          </div>
        </Card>
        <Card title="Sell-in por mes">
          <Bars labels={months.map(m => MONTHS[m - 1])} series={[
            { label: 'Sell-in Prev. Year', data: months.map(m => byMonth.get(String(m))?.prev.sIn || 0), color: COLORS.prev },
            { label: 'Sell-in Year', data: months.map(m => byMonth.get(String(m))?.cur.sIn || 0), color: COLORS.cur },
            { label: 'Budget', data: months.map(m => byMonth.get(String(m))?.cur.bdg || 0), color: COLORS.bdg },
          ]} />
        </Card>
      </div>
      <Card title="Detalle (año completo)" right={<div className="flex items-center gap-2"><ParamSelect value={param} onChange={setParam} />
        <ExportBtn onClick={() => exportRows(`Sales Performance ${param}`, detail.map(([k, p]) => ({
          [PARAMS.find(x => x.id === param)!.label]: k, 'Sell-in Prev. Year': p.prev.sIn, 'Sell-in Year': p.cur.sIn, Budget: p.cur.bdg,
          'Units Prev. Year': p.prev.sInQty, 'Units Year': p.cur.sInQty, 'Budget Units': p.cur.bdgQty,
        })))} /></div>}>
        <div className="overflow-x-auto max-h-[600px]">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-200">
              <th className={`${th} text-left`}>{PARAMS.find(x => x.id === param)!.label}</th>
              <th className={th}>Sell-in Prev. Year</th><th className={th}>%chg</th><th className={th}>Sell-in Year</th><th className={th}>%chg vs Bdg</th><th className={th}>Budget</th>
              <th className={th}>Units Prev. Year</th><th className={th}>%chg</th><th className={th}>Units Year</th><th className={th}>%chg vs Bdg</th><th className={th}>Budget Units</th>
            </tr></thead>
            <tbody>
              {detail.map(([k, p]) => (
                <tr key={k} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-1.5 px-2 max-w-[340px] truncate" title={k}>{k}</td>
                  <td className={td}>{fmtNum(p.prev.sIn)}</td><td className={td}><Var v={pctVar(p.cur.sIn, p.prev.sIn)} /></td>
                  <td className={`${td} font-semibold`}>{fmtNum(p.cur.sIn)}</td><td className={td}><Var v={pctVar(p.cur.sIn, p.cur.bdg)} /></td><td className={td}>{fmtNum(p.cur.bdg)}</td>
                  <td className={td}>{fmtNum(p.prev.sInQty)}</td><td className={td}><Var v={pctVar(p.cur.sInQty, p.prev.sInQty)} /></td>
                  <td className={`${td} font-semibold`}>{fmtNum(p.cur.sInQty)}</td><td className={td}><Var v={pctVar(p.cur.sInQty, p.cur.bdgQty)} /></td><td className={td}>{fmtNum(p.cur.bdgQty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------- Budget (Summary, Analysis, MoTD vs. Forecast) ----------
export function Budget({ ctx, facts, filters }: P) {
  const [view, setView] = useState<'summary' | 'analysis' | 'motd'>('summary');
  const [param, setParam] = useState<ParamId>('customer');
  const [monthly, setMonthly] = useState(false);
  const full = useMemo(() => records(ctx, facts, filters, 'full'), [ctx, facts, filters]);
  const motd = useMemo(() => records(ctx, facts, filters, 'motd'), [ctx, facts, filters]);
  const cur = ctx.currency;
  const t = totals(full);
  const proj = projection(ctx, full);
  const byMonth = groupBy(full, r => String(r.m));
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const projMonth = (m: number) => projection(ctx, full.filter(r => r.m === m)).rev;

  const head = (
    <div className="grid gap-3 grid-cols-2 xl:grid-cols-5">
      <Kpi highlight title={`Sell-in ${ctx.year}`} value={fmtMoney(t.cur.sIn, cur)} sub={<p>vs. Budget <Var v={pctVar(t.cur.sIn, t.cur.bdg)} /></p>} />
      <Kpi title={`Budget FY ${ctx.year}`} value={fmtMoney(t.cur.bdg, cur)} />
      <Kpi title="Projection FY" value={fmtMoney(proj.rev, cur)} sub={<><p>vs. Budget <Var v={pctVar(proj.rev, t.cur.bdg)} /></p><p className="text-gray-500">Meses cerrados facturado + forecast del resto</p></>} />
      <div className="xl:col-span-2 bg-white rounded-xl border border-gray-200 p-4 flex flex-col justify-center">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Sell-in vs. Budget</p>
        <Gauge value={t.cur.sIn} target={proj.rev} max={t.cur.bdg} currency={cur} />
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
          <Card title="Por mes: presupuesto, proyección y sell-in">
            <LineArea labels={MONTHS} series={[
              { label: 'Budget', data: months.map(m => byMonth.get(String(m))?.cur.bdg || 0), color: COLORS.bdg, dash: true },
              { label: 'Projection', data: months.map(projMonth), color: COLORS.proj },
              { label: 'Sell-in Year', data: months.map(m => (m <= ctx.cutMonth ? byMonth.get(String(m))?.cur.sIn || 0 : null)), color: COLORS.cur, fill: true },
              { label: 'Sell-in Prev. Year', data: months.map(m => byMonth.get(String(m))?.prev.sIn || 0), color: COLORS.prev },
            ]} />
          </Card>
          <Card title="Por Business Unit">
            <Bars labels={byBu.map(([k]) => k)} series={[
              { label: 'Sell-in Prev. Year', data: byBu.map(([, p]) => p.prev.sIn), color: COLORS.prev },
              { label: 'Sell-in Year', data: byBu.map(([, p]) => p.cur.sIn), color: COLORS.cur },
              { label: 'Budget', data: byBu.map(([, p]) => p.cur.bdg), color: COLORS.bdg },
            ]} />
          </Card>
          <Card title="Sell-in por KAM"><Donut labels={byKam.map(([k]) => k)} data={byKam.map(([, p]) => Math.max(0, p.cur.sIn))} /></Card>
          <Card title="Budget por KAM"><Donut labels={byKam.map(([k]) => k)} data={byKam.map(([, p]) => Math.max(0, p.cur.bdg))} /></Card>
        </div>
        <Card title="Por Customer" right={<ExportBtn onClick={() => exportRows('Budget por Customer', byCust.map(([k, p]) => ({ Customer: k, Invoice: p.cur.inv, 'SO/RE': p.cur.so, 'Diff to Bdg': p.cur.sIn - p.cur.bdg, Budget: p.cur.bdg })))} />}>
          <div className="overflow-x-auto max-h-[500px]">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-200">
                <th className={`${th} text-left`}>Customer</th><th className={th}>Invoice</th><th className={th}>SO/RE</th><th className={th}>Diff to Bdg</th><th className={th}>Budget</th><th className={th}>% Budget</th>
              </tr></thead>
              <tbody>
                {byCust.map(([k, p]) => (
                  <tr key={k} className="border-b border-gray-100">
                    <td className="py-1.5 px-2">{k}</td><td className={td}>{fmtNum(p.cur.inv)}</td><td className={td}>{fmtNum(p.cur.so)}</td>
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
    return (
      <div className="space-y-4">
        {tabs}{head}
        <Card title="Año completo: anterior, actual, proyección y presupuesto" right={<div className="flex items-center gap-3">
          <ParamSelect value={param} onChange={setParam} label="Check data by" />
          <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={monthly} onChange={e => setMonthly(e.target.checked)} /> por mes</label>
          <ExportBtn onClick={() => exportRows(`Budget Analysis ${param}`, rows.map(([k, p]) => { const pr = projBy(k); return {
            [PARAMS.find(x => x.id === param)!.label]: k, 'Prev. Year Turnover': p.prev.sIn, 'Year Turnover': p.cur.sIn, 'Projection Turnover': pr.rev, 'Budget Turnover': p.cur.bdg,
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
                      <td className="py-1.5 px-2 max-w-[340px] truncate" title={k}>{k}</td>
                      <td className={td}>{fmtNum(p.prev.sIn)}</td><td className={`${td} font-semibold`}>{fmtNum(p.cur.sIn)}</td><td className={td}>{fmtNum(pr.rev)}</td><td className={td}>{fmtNum(p.cur.bdg)}</td>
                      <td className={td}>{fmtNum(p.prev.sInQty)}</td><td className={`${td} font-semibold`}>{fmtNum(p.cur.sInQty)}</td><td className={td}>{fmtNum(pr.qty)}</td><td className={td}>{fmtNum(p.cur.bdgQty)}</td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-200">
                  <th className={`${th} text-left`}>{PARAMS.find(x => x.id === param)!.label}</th><th className={`${th} text-left`}>Medida</th>
                  {MONTHS.map(m => <th key={m} className={th}>{m}</th>)}
                </tr></thead>
                <tbody>
                  {rows.slice(0, 100).map(([k]) => {
                    const lines: [string, (m: number) => number][] = [
                      ['Prev. Year', m => full.filter(r => r.y === 'prev' && r.m === m && key(r) === k).reduce((s, r) => s + r.inv + r.so, 0)],
                      ['Year', m => full.filter(r => r.y === 'cur' && r.m === m && key(r) === k).reduce((s, r) => s + r.inv + r.so, 0)],
                      ['Projection', m => projBy(k, m).rev],
                      ['Budget', m => full.filter(r => r.y === 'cur' && r.m === m && key(r) === k).reduce((s, r) => s + r.bdg, 0)],
                    ];
                    return (
                      <Fragment key={k}>
                        {lines.map(([label, f], i) => (
                          <tr key={label} className={`${i === 3 ? 'border-b border-gray-200' : ''}`}>
                            {i === 0 && <td rowSpan={4} className="py-1 px-2 align-top max-w-[260px] truncate font-semibold" title={k}>{k}</td>}
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
          {monthly && rows.length > 100 && <p className="text-xs text-gray-500 mt-2">Vista mensual limitada a las 100 primeras filas; el Excel lleva todas.</p>}
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
      <Card title={`Hasta el final del mes anterior (${MONTHS[Math.max(0, ctx.cutMonth - 2)]} ${ctx.year})`} right={<div className="flex items-center gap-2">
        <ParamSelect value={param} onChange={setParam} label="Check data by" />
        <ExportBtn onClick={() => exportRows(`MoTD vs Forecast ${param}`, rows.map(([k, p]) => ({
          [PARAMS.find(x => x.id === param)!.label]: k, 'Acm. Invoiced Turnover': p.cur.inv, 'Acm. Forecast Turnover': p.cur.fc, 'Var.': p.cur.inv - p.cur.fc,
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
                  <td className="py-1.5 px-2 max-w-[340px] truncate" title={k}>{k}</td>
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

// ---------- Rule 80-20 ----------
function Pareto({ title, rows, label }: { title: string; rows: [string, Pair][]; label: string }) {
  const rank = (f: (p: Pair) => number) => {
    const sorted = [...rows].sort((a, b) => f(b[1]) - f(a[1]));
    const total = sorted.reduce((s, [, p]) => s + f(p), 0);
    let acc = 0;
    return new Map(sorted.map(([k, p], i) => { acc += f(p); return [k, { rank: i + 1, share: total ? acc / total : 0 }]; }));
  };
  const rPrev = rank(p => p.prev.sIn), rCur = rank(p => p.cur.sIn), rBdg = rank(p => p.cur.bdg);
  const sorted = [...rows].sort((a, b) => b[1].cur.sIn - a[1].cur.sIn);
  const Share = ({ v }: { v: number }) => <span className={v <= 0.8 ? 'font-semibold text-gray-900' : 'text-gray-400'}>{fmtShare(v)}</span>;
  return (
    <Card title={title} right={<ExportBtn onClick={() => exportRows(`Rule 80-20 ${label}`, sorted.map(([k, p]) => ({
      [label]: k, 'Sell-in LY': p.prev.sIn, '% acum LY': rPrev.get(k)!.share, '# LY': rPrev.get(k)!.rank, 'Sell-in FY': p.cur.sIn, '% acum FY': rCur.get(k)!.share, '# FY': rCur.get(k)!.rank,
      'Budget FY': p.cur.bdg, '% acum Bdg': rBdg.get(k)!.share, '# Bdg': rBdg.get(k)!.rank,
    })))} />}>
      <div className="overflow-x-auto max-h-[520px]">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-200">
            <th className={`${th} text-left`}>{label}</th>
            <th className={th}>Sell-in LY</th><th className={th}>% acum</th><th className={th}>#</th>
            <th className={th}>Sell-in FY</th><th className={th}>% acum</th><th className={th}>#</th>
            <th className={th}>Budget FY</th><th className={th}>% acum</th><th className={th}>#</th>
          </tr></thead>
          <tbody>
            {sorted.map(([k, p]) => (
              <tr key={k} className={`border-b border-gray-100 ${rCur.get(k)!.share <= 0.8 ? 'bg-[#FDF2F7]/50' : ''}`}>
                <td className="py-1.5 px-2 max-w-[300px] truncate" title={k}>{k}</td>
                <td className={td}>{fmtNum(p.prev.sIn)}</td><td className={td}><Share v={rPrev.get(k)!.share} /></td><td className={`${td} text-gray-500`}>{rPrev.get(k)!.rank}</td>
                <td className={`${td} font-semibold`}>{fmtNum(p.cur.sIn)}</td><td className={td}><Share v={rCur.get(k)!.share} /></td><td className={`${td} text-gray-500`}>{rCur.get(k)!.rank}</td>
                <td className={td}>{fmtNum(p.cur.bdg)}</td><td className={td}><Share v={rBdg.get(k)!.share} /></td><td className={`${td} text-gray-500`}>{rBdg.get(k)!.rank}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function Rule8020({ ctx, facts, filters }: P) {
  const [param, setParam] = useState<ParamId>('root');
  const recs = useMemo(() => records(ctx, facts, filters, 'full'), [ctx, facts, filters]);
  const by = (p: ParamId) => Array.from(groupBy(recs, keyFn(ctx, p)).entries());
  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">Año completo (o los meses elegidos). Resaltado: lo que suma el 80 % del sell-in del año. % acum = porcentaje acumulado de mayor a menor; # = posición.</p>
      <div className="grid gap-4 2xl:grid-cols-2">
        <Pareto title="Product Line" label="Product Line" rows={by('line')} />
        <Pareto title="Customer" label="Customer" rows={by('customer')} />
      </div>
      <Card title="Detalle" right={<ParamSelect value={param} onChange={setParam} />}><div /></Card>
      <Pareto title={PARAMS.find(x => x.id === param)!.label} label={PARAMS.find(x => x.id === param)!.label} rows={by(param)} />
    </div>
  );
}

// ---------- Top 50 Items (sell-in en unidades, por trimestre) ----------
export function Top50({ ctx, facts, filters }: P) {
  const recs = useMemo(() => records(ctx, facts, filters, 'full', 'noMain'), [ctx, facts, filters]);
  const key = keyFn(ctx, filters.units === 'root' ? 'root' : 'raw');
  const q = (m: number) => Math.ceil(m / 3);
  const byQ = new Map<string, number[][]>();   // artículo → [trimestre][cur, prev]
  for (const r of recs) {
    const k = key(r);
    const arr = byQ.get(k) || [0, 1, 2, 3, 4].map(() => [0, 0]);
    const qty = r.invQty + r.soQty;
    arr[q(r.m)][r.y === 'cur' ? 0 : 1] += qty;
    arr[0][r.y === 'cur' ? 0 : 1] += qty;
    byQ.set(k, arr);
  }
  const top = Array.from(byQ.entries()).sort((a, b) => b[1][0][0] - a[1][0][0]).slice(0, 50);
  return (
    <Card title={`Top 50 por unidades de sell-in · ${ctx.year} (${filters.units === 'root' ? 'Article To Root' : 'Raw Article'})`}
      right={<ExportBtn onClick={() => exportRows('Top 50 sell-in', top.map(([k, a], i) => ({ '#': i + 1, Artículo: k, ...Object.fromEntries([1, 2, 3, 4].flatMap(qq => [[`Q${qq}`, a[qq][0]], [`Q${qq} YoY`, a[qq][0] - a[qq][1]]])), Total: a[0][0], 'Total YoY': a[0][0] - a[0][1] })))} />}>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead><tr className="border-b border-gray-200">
            <th className={th}>#</th><th className={`${th} text-left`}>Artículo</th>
            {[1, 2, 3, 4].map(qq => <Fragment key={qq}><th className={th}>Q{qq}</th><th className={th}>YoY</th></Fragment>)}
            <th className={th}>Total</th><th className={th}>YoY</th>
          </tr></thead>
          <tbody>
            {top.map(([k, a], i) => (
              <tr key={k} className="border-b border-gray-100">
                <td className={`${td} text-gray-500`}>{i + 1}</td>
                <td className="py-1.5 px-2 max-w-[320px] truncate" title={k}>{k}</td>
                {[1, 2, 3, 4].map(qq => <Fragment key={qq}><td className={td}>{fmtNum(a[qq][0])}</td><td className={`${td} ${tone(a[qq][0] - a[qq][1])}`}>{fmtNum(a[qq][0] - a[qq][1])}</td></Fragment>)}
                <td className={`${td} font-semibold`}>{fmtNum(a[0][0])}</td><td className={`${td} ${tone(a[0][0] - a[0][1])}`}>{fmtNum(a[0][0] - a[0][1])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-2">Sell-in = facturado + pedidos abiertos, en unidades, sin las líneas Main Item (como el Power BI). YoY = diferencia de unidades con el mismo trimestre del año anterior.</p>
    </Card>
  );
}
