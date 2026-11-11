'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, RefreshCw, Search, Wrench } from 'lucide-react';
import DocPdfLink from '@/components/DocPdfLink';
import type { MagEntry, Magazine, MagazineAnalysis as Analysis, MagLocation, Unassigned, Validation } from '@/lib/magazineAnalysis';

type MagazineAnalysis = Analysis & { validated?: Record<string, Validation> };

const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const pct = (v: number | null) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`);
const money = (v: number) => (Math.abs(v) < 0.005 ? '—' : nf.format(v));
const units = (v: number) => (Math.abs(v) < 0.005 ? '—' : qf.format(v));
const dmy = (d: string) => (d ? d.split('-').reverse().join('/') : '');
const neg = (v: number) => (v < -0.005 ? 'text-red-600' : '');

// Grupos de tareas del Project Card de las revistas
const GROUPS = ['001', '002', '003', '004'] as const;
const GROUP_LABEL: Record<string, string> = { '001': 'SALES', '002': 'DISTRIBUTION COSTS', '003': 'MARKETING COSTS', '004': 'MAGAZINE COSTS' };
const TASK_SALES = '001.001', TASK_RETURNS = '001.003', TASK_ADS = '001.004';
const DOC_TYPE: Record<MagEntry['kind'], { label: string; pdf: 'salesInv' | 'salesCrMemo' | 'purchInv' | 'purchCrMemo' }> = {
  salesInv: { label: 'Factura venta', pdf: 'salesInv' }, salesCrMemo: { label: 'Abono venta', pdf: 'salesCrMemo' },
  purchInv: { label: 'Factura compra', pdf: 'purchInv' }, purchCrMemo: { label: 'Abono compra', pdf: 'purchCrMemo' },
};
const COMPANY = 'Craze Entertainment';

type Summary = {
  soldQty: number; sold: number; retQty: number; returned: number; netSales: number; ads: number; otherRevenue: number;
  revenue: number; distribution: number; marketing: number; magazine: number; otherCost: number; costs: number; profit: number;
};
const groupOf = (task: string) => task.substring(0, 3);
function summarize(m: Pick<Magazine, 'tasks'>): Summary {
  const t = (k: string) => m.tasks[k] || { qty: 0, value: 0 };
  let otherRevenue = 0, distribution = 0, marketing = 0, magazine = 0, otherCost = 0;
  for (const [k, v] of Object.entries(m.tasks)) {
    if (k === TASK_SALES || k === TASK_RETURNS || k === TASK_ADS) continue;
    const g = groupOf(k);
    if (g === '001') otherRevenue += v.value;
    else if (g === '002') distribution -= v.value;
    else if (g === '003') marketing -= v.value;
    else if (g === '004') magazine -= v.value;
    else otherCost -= v.value;
  }
  const sold = t(TASK_SALES).value, returned = -t(TASK_RETURNS).value, ads = t(TASK_ADS).value;
  const netSales = sold - returned;
  const revenue = netSales + ads + otherRevenue;
  const costs = distribution + marketing + magazine + otherCost;
  return {
    soldQty: t(TASK_SALES).qty, sold, retQty: -t(TASK_RETURNS).qty, returned, netSales, ads, otherRevenue, revenue,
    distribution, marketing, magazine, otherCost, costs, profit: revenue - costs,
  };
}
function addTasks(list: Pick<Magazine, 'tasks'>[]) {
  const tasks: Magazine['tasks'] = {};
  list.forEach(m => Object.entries(m.tasks).forEach(([k, v]) => { const t = (tasks[k] ||= { qty: 0, value: 0 }); t.qty += v.qty; t.value += v.value; }));
  return { tasks };
}
function addLocations(list: Magazine[]) {
  const map = new Map<string, MagLocation>();
  list.forEach(m => m.locations.forEach(l => {
    const t = map.get(l.location) || { location: l.location, soldQty: 0, soldAmount: 0, retQty: 0, retAmount: 0 };
    t.soldQty += l.soldQty; t.soldAmount += l.soldAmount; t.retQty += l.retQty; t.retAmount += l.retAmount;
    map.set(l.location, t);
  }));
  return Array.from(map.values()).sort((a, b) => b.soldQty - a.soldQty);
}

// Magazine Profitability: beneficio de cada revista (ventas y devoluciones de D-FORCE por localización, Magazine Ads y
// costes por proyecto y tarea)
export default function MagazineProfitabilityView() {
  const [data, setData] = useState<MagazineAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [year, setYear] = useState('');
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [openTask, setOpenTask] = useState<Record<string, boolean>>({});
  const [showIssues, setShowIssues] = useState(false);
  const [showFixes, setShowFixes] = useState(false);
  const [showValidated, setShowValidated] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useMemo(() => (data?.unassigned || []).filter(u => !data?.validated?.[u.key]), [data]);
  const validatedRows = useMemo(() => (data?.unassigned || []).filter(u => data?.validated?.[u.key]), [data]);
  // Validar = la línea no es de ninguna revista: no se vuelve a avisar (se guarda en la app, no en BC)
  const validate = async (lines: Unassigned[], validated: boolean) => {
    setSaving(true);
    try {
      const res = await fetch('/api/magazines/analysis/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ validated, lines: lines.map(l => ({ key: l.key, doc: l.doc, description: `${l.partner} · ${l.description}` })) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(d => (d ? { ...d, validated: json.validated } : d));
    } catch (e: any) {
      alert(`No se ha podido guardar: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const load = async (force = false) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/magazines/analysis${force ? '?force=1' : ''}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const titles = useMemo(() => Array.from(new Set((data?.magazines || []).map(m => m.title))).sort(), [data]);
  const years = useMemo(() => Array.from(new Set((data?.magazines || []).map(m => `20${m.issue.substring(0, 2)}`))).sort().reverse(), [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.magazines || []).filter(m =>
      (!title || m.title === title) && (!year || `20${m.issue.substring(0, 2)}` === year) &&
      (!onlyActive || m.entries.length > 0) &&
      (!needle || `${m.item} ${m.project} ${m.description}`.toLowerCase().includes(needle)),
    ).map(m => ({ m, s: summarize(m) }));
  }, [data, title, year, q, onlyActive]);
  const total = useMemo(() => summarize(addTasks(rows.map(r => r.m))), [rows]);
  const totalLocations = useMemo(() => addLocations(rows.map(r => r.m)), [rows]);

  const exportExcel = () => {
    if (!data) return;
    const head = ['Revista', 'Descripción', 'Proyecto', 'On Sale', 'Tirada', 'Uds vendidas', 'Venta', 'Uds devueltas', 'Devoluciones', '% devol. uds',
      'Venta neta', 'Magazine Ads', 'Otros ingresos', 'Distribución', 'Marketing', 'Costes revista', 'Otros costes', 'Beneficio', 'Margen %'];
    const summaryRow = (m: { item: string; description: string; project: string; onSaleDate: string; printRun: number } | null, x: Summary) => [
      m?.item || 'TOTAL', m?.description || '', m?.project || '', m?.onSaleDate ? new Date(m.onSaleDate) : '', m?.printRun || '',
      x.soldQty, x.sold, x.retQty, x.returned, x.soldQty ? x.retQty / x.soldQty : '', x.netSales, x.ads, x.otherRevenue,
      x.distribution, x.marketing, x.magazine, x.otherCost, x.profit, x.revenue ? x.profit / x.revenue : '',
    ];
    const ws1 = XLSX.utils.aoa_to_sheet([head, ...rows.map(r => summaryRow(r.m, r.s)), summaryRow(null, total)], { cellDates: true });
    const locHead = ['Revista', 'Proyecto', 'Localización', 'Uds vendidas', 'Venta', 'Uds devueltas', 'Devoluciones', '% devol. uds', 'Uds netas', 'Venta neta'];
    const locRow = (item: string, project: string, l: MagLocation) => [item, project, l.location, l.soldQty, l.soldAmount, l.retQty, l.retAmount,
      l.soldQty ? l.retQty / l.soldQty : '', l.soldQty - l.retQty, l.soldAmount - l.retAmount];
    const ws2 = XLSX.utils.aoa_to_sheet([locHead, ...rows.flatMap(r => r.m.locations.map(l => locRow(r.m.item, r.m.project, l))),
      ...totalLocations.map(l => locRow('TOTAL', '', l))]);
    const lineHead = ['Revista', 'Proyecto', 'Tarea', 'Descripción tarea', 'Tipo doc.', 'Nº documento', 'Fecha', 'Cliente / proveedor', 'Nº', 'Descripción', 'Localización', 'Cantidad', 'Importe (resultado)'];
    const ws3 = XLSX.utils.aoa_to_sheet([lineHead, ...rows.flatMap(r => r.m.entries.map(e => [r.m.item, r.m.project, e.task, data.taskNames[e.task] || '',
      DOC_TYPE[e.kind].label, e.doc, e.date ? new Date(e.date) : '', e.partner, e.no, e.description, e.location, e.qty, e.value]))], { cellDates: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Revistas');
    XLSX.utils.book_append_sheet(wb, ws2, 'Localizaciones');
    XLSX.utils.book_append_sheet(wb, ws3, 'Líneas');
    if (pending.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Motivo', 'Tipo doc.', 'Nº documento', 'Fecha', 'Cliente / proveedor', 'Nº', 'Descripción', 'Project No.', 'Project Task No.', 'Cantidad', 'Importe'],
        ...pending.map(u => [u.reason, DOC_TYPE[u.kind].label, u.doc, u.date ? new Date(u.date) : '', u.partner, u.no, u.description, u.project, u.task, u.qty, u.amount])], { cellDates: true }), 'Sin asignar');
    }
    if (data.corrections.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Motivo', 'Tipo doc.', 'Nº documento', 'Fecha', 'Cliente / proveedor', 'Nº', 'Descripción', 'Localización', 'Project No. en BC', 'Task No. en BC', 'Revista correcta', 'Tarea', 'Cantidad', 'Importe'],
        ...data.corrections.map(c => [c.reason, DOC_TYPE[c.kind].label, c.doc, c.date ? new Date(c.date) : '', c.partner, c.no, c.description, c.location, c.bcProject, c.bcTask, c.magazine, c.task, c.qty, c.amount])], { cellDates: true }), 'Corregidas en la app');
    }
    XLSX.writeFile(wb, `Magazine_Profitability_${new Date().toISOString().substring(0, 10)}.xlsx`);
  };

  const th = 'px-3 py-2 font-semibold whitespace-nowrap';
  const td = 'px-3 py-1.5 whitespace-nowrap tabular-nums';
  const th2 = 'px-2 py-2 font-semibold whitespace-nowrap align-bottom';

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="mr-auto">
          <p className="text-xs text-gray-500">
            Beneficio por revista: ventas y devoluciones a D-FORCE (artículos MAGAZINE -), Magazine Ads y costes por Project No. / Task No.
            {data && <> · Datos de BC de {new Date(data.generatedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</>}
          </p>
        </div>
        <div className="flex bg-gray-100 rounded-lg p-1 text-sm">
          {['', ...titles].map(t => (
            <button key={t || 'all'} onClick={() => setTitle(t)}
              className={`px-3 py-1 rounded-md font-medium ${title === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>{t || 'Todas'}</button>
          ))}
        </div>
        <select value={year} onChange={e => setYear(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
          <option value="">Todos los años</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <label className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar revista…" className="border border-gray-300 rounded-lg pl-7 pr-2 py-1.5 text-sm w-48" />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-600">
          <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} /> Solo con movimientos
        </label>
        <button onClick={exportExcel} disabled={!data} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-50">
          <Download size={14} /> Excel
        </button>
        <button onClick={() => load(true)} disabled={loading} title="Volver a leer BC"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-900 text-white text-sm hover:bg-black disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> {loading ? 'Leyendo BC…' : 'Actualizar'}
        </button>
      </section>

      {error && <p className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-center gap-2"><AlertCircle size={16} /> {error}</p>}
      {!data && loading && <p className="bg-white border border-gray-200 rounded-xl p-6 text-sm text-gray-500">Leyendo ventas, abonos y compras de {COMPANY} en BC…</p>}

      {data && (
        <>
          <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {[
              { label: 'Venta neta', value: money(total.netSales), sub: `${units(total.soldQty - total.retQty)} uds netas` },
              { label: 'Devoluciones', value: money(total.returned), sub: `${pct(total.soldQty ? total.retQty / total.soldQty : null)} de las uds vendidas` },
              { label: 'Magazine Ads', value: money(total.ads), sub: total.otherRevenue ? `+ ${money(total.otherRevenue)} otros ingresos` : 'Facturado a CRAZE GmbH' },
              { label: 'Distribución', value: money(total.distribution), sub: 'D-FORCE: envíos, KVM, comisiones' },
              { label: 'Costes revista + marketing', value: money(total.magazine + total.marketing + total.otherCost), sub: 'Gadget, foilbag, diseño, imprenta…' },
              { label: 'Beneficio', value: money(total.profit), sub: `Margen ${pct(total.revenue ? total.profit / total.revenue : null)}`, strong: true },
            ].map(k => (
              <div key={k.label} className="bg-white rounded-xl border border-gray-200 px-4 py-3">
                <p className="text-xs text-gray-500">{k.label}</p>
                <p className={`text-lg font-semibold tabular-nums ${k.strong ? (total.profit < 0 ? 'text-red-600' : 'text-emerald-700') : 'text-gray-900'}`}>{k.value}</p>
                <p className="text-xs text-gray-400">{k.sub}</p>
              </div>
            ))}
          </section>

          {(pending.length > 0 || validatedRows.length > 0) && (
            <section className="bg-amber-50 border border-amber-200 rounded-xl">
              <button onClick={() => setShowIssues(v => !v)} className="w-full px-4 py-2.5 flex items-center gap-2 text-sm text-amber-900 text-left">
                <AlertTriangle size={16} />
                <span className="font-semibold">{pending.length} líneas sin revista</span>
                <span className="text-amber-800">
                  · sin Project No. en BC ni revista en el External Document No. o el PDF; no cuentan en ninguna revista
                  {validatedRows.length > 0 && <> · {validatedRows.length} validadas</>}
                </span>
                {showIssues ? <ChevronDown size={16} className="ml-auto shrink-0" /> : <ChevronRight size={16} className="ml-auto shrink-0" />}
              </button>
              {showIssues && (
                <div className="px-4 pb-4 overflow-x-auto">
                  <div className="flex flex-wrap items-center gap-3 mb-1">
                    <p className="text-xs text-amber-900 mr-auto">Rellena Project No. y Project Task No. en BC, o valida las que no son de ninguna revista para que no se avisen más. Almacenaje y handling sin proyecto no se listan. Importe: en ventas, + = ingreso; en compras, + = coste.</p>
                    {pending.length > 0 && (
                      <button onClick={() => validate(pending, true)} disabled={saving}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-amber-300 bg-white text-xs text-amber-900 hover:bg-amber-100 disabled:opacity-50">
                        <CheckCircle2 size={13} /> Validar todas ({pending.length})
                      </button>
                    )}
                    {validatedRows.length > 0 && (
                      <label className="flex items-center gap-1 text-xs text-amber-900">
                        <input type="checkbox" checked={showValidated} onChange={e => setShowValidated(e.target.checked)} /> Ver validadas ({validatedRows.length})
                      </label>
                    )}
                  </div>
                  <table className="w-full text-xs bg-white rounded-lg border border-amber-200">
                    <thead className="text-gray-500 bg-gray-50"><tr>
                      {['Motivo', 'Documento', 'Fecha', 'Cliente / proveedor', 'Nº', 'Descripción', 'Project No.', 'Task No.', 'Cantidad', 'Importe', ''].map((h, i) =>
                        <th key={i} className={`${th} ${['Cantidad', 'Importe'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
                    </tr></thead>
                    <tbody className="divide-y divide-gray-100">
                      {[...pending, ...(showValidated ? validatedRows : [])].map(u => {
                        const v = data.validated?.[u.key];
                        return (
                          <tr key={u.key} className={v ? 'text-gray-400' : ''}>
                            <td className="px-3 py-1.5">{u.reason}{u.pdf && <p className="text-amber-700">PDF: {u.pdf}</p>}</td>
                            <td className={td}><span className="text-gray-400 mr-1">{DOC_TYPE[u.kind].label}</span>{u.doc} <DocPdfLink documentNo={u.doc} kind={DOC_TYPE[u.kind].pdf} company={COMPANY} /></td>
                            <td className={td}>{dmy(u.date)}</td><td className={td}>{u.partner}</td><td className={td}>{u.no}</td>
                            <td className="px-3 py-1.5">{u.description}</td><td className={td}>{u.project}</td><td className={td}>{u.task}</td>
                            <td className={`${td} text-right`}>{units(u.qty)}</td><td className={`${td} text-right`}>{money(u.amount)}</td>
                            <td className={`${td} text-right`}>
                              {v ? (
                                <span className="inline-flex items-center gap-2">
                                  <span title={`${v.by || ''} ${new Date(v.at).toLocaleString('es-ES')}`} className="text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 size={12} /> Validada</span>
                                  <button onClick={() => validate([u], false)} disabled={saving} className="underline hover:text-gray-700">Quitar</button>
                                </span>
                              ) : (
                                <button onClick={() => validate([u], true)} disabled={saving} title="No es de ninguna revista: no volver a avisar"
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                                  <CheckCircle2 size={12} /> Validar
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {data.corrections.length > 0 && (
            <section className="bg-sky-50 border border-sky-200 rounded-xl">
              <button onClick={() => setShowFixes(v => !v)} className="w-full px-4 py-2.5 flex items-center gap-2 text-sm text-sky-900 text-left">
                <Wrench size={16} />
                <span className="font-semibold">{data.corrections.length} líneas corregidas en la app</span>
                <span className="text-sky-800">
                  · {data.corrections.filter(c => c.bcProject).length} con el proyecto de otra revista, {data.corrections.filter(c => !c.bcProject).length} sin proyecto.
                  Ya cuentan en la revista correcta; conviene corregir el Project No. en BC para que el Project Card coincida
                </span>
                {showFixes ? <ChevronDown size={16} className="ml-auto shrink-0" /> : <ChevronRight size={16} className="ml-auto shrink-0" />}
              </button>
              {showFixes && (
                <div className="px-4 pb-4 overflow-x-auto">
                  <p className="text-xs text-sky-900 mb-1">Ventas y devoluciones de D-FORCE: manda el artículo (su descripción dice la misma revista). Magazine Ads: manda la revista del External Document No. o, si no la dice, la fecha On Sale de la revista.</p>
                  <table className="w-full text-xs bg-white rounded-lg border border-sky-200">
                    <thead className="text-gray-500 bg-gray-50"><tr>
                      {['Motivo', 'Documento', 'Fecha', 'Nº', 'Descripción', 'Localización', 'Project No. en BC', 'Revista correcta', 'Tarea', 'Cantidad', 'Importe'].map(h =>
                        <th key={h} className={`${th} ${['Cantidad', 'Importe'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
                    </tr></thead>
                    <tbody className="divide-y divide-gray-100">
                      {data.corrections.map((c, i) => {
                        const right = data.magazines.find(m => m.item === c.magazine);
                        return (
                          <tr key={i}>
                            <td className="px-3 py-1.5">{c.reason}</td>
                            <td className={td}><span className="text-gray-400 mr-1">{DOC_TYPE[c.kind].label}</span>{c.doc} <DocPdfLink documentNo={c.doc} kind={DOC_TYPE[c.kind].pdf} company={COMPANY} /></td>
                            <td className={td}>{dmy(c.date)}</td><td className={td}>{c.no}</td>
                            <td className="px-3 py-1.5">{c.description}</td><td className={td}>{c.location}</td>
                            <td className={`${td} text-red-600 line-through`}>{c.bcProject || '(vacío)'}</td>
                            <td className={`${td} text-emerald-700 font-medium`}>{right?.project || c.magazine} <span className="text-gray-400 font-normal">{c.magazine}</span></td>
                            <td className={td}>{c.task}</td>
                            <td className={`${td} text-right`}>{units(c.qty)}</td><td className={`${td} text-right`}>{money(c.amount)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <section className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-gray-50 text-xs text-gray-500 border-b border-gray-200">
                <tr>
                  <th className={`${th2} text-left`}>Revista</th>
                  <th className={`${th2} text-left`}>Proyecto<br /><span className="font-normal">On Sale · Tirada</span></th>
                  <th className={`${th2} text-right`}>Venta<br /><span className="font-normal">uds</span></th>
                  <th className={`${th2} text-right`}>Devoluciones<br /><span className="font-normal">uds · %</span></th>
                  <th className={`${th2} text-right bg-gray-100`}>Venta neta<br /><span className="font-normal">uds netas</span></th>
                  <th className={`${th2} text-right`}>Magazine Ads</th>
                  <th className={`${th2} text-right`}>Distribución</th>
                  <th className={`${th2} text-right`}>Marketing</th>
                  <th className={`${th2} text-right`}>Costes revista</th>
                  <th className={`${th2} text-right bg-gray-100`}>Beneficio<br /><span className="font-normal">margen</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(({ m, s }) => (
                  <Fragment key={m.item}>
                    <tr className="hover:bg-gray-50 cursor-pointer align-top" onClick={() => setOpen(o => ({ ...o, [m.item]: !o[m.item] }))}>
                      <td className="px-2 py-1.5">
                        <div className="flex items-start gap-1">
                          {open[m.item] ? <ChevronDown size={14} className="text-gray-400 shrink-0 mt-0.5" /> : <ChevronRight size={14} className="text-gray-400 shrink-0 mt-0.5" />}
                          <div className="min-w-0">
                            <p className="font-medium text-gray-900 whitespace-nowrap">{m.title} {m.issue.substring(2)}/{m.issue.substring(0, 2)} <span className="text-gray-400 font-normal">{m.item}</span></p>
                            <p className="text-xs text-gray-500 truncate max-w-[18rem]" title={m.description}>{m.description.replace(/^MAGAZINE\s*-\s*/i, '').replace(/^\S+\s+\d{2}\/\d{2}\s*/, '')}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-gray-700">
                        {m.project}{m.projects.length > 1 && <span className="text-xs text-amber-600" title={`También: ${m.projects.filter(p => p !== m.project).join(', ')}`}> +{m.projects.length - 1}</span>}
                        <p className="text-xs text-gray-400">{[dmy(m.onSaleDate), m.printRun ? `${qf.format(m.printRun)} uds` : ''].filter(Boolean).join(' · ')}</p>
                      </td>
                      <Two main={money(s.sold)} sub={units(s.soldQty)} />
                      <Two main={money(s.returned)} sub={`${units(s.retQty)} · ${pct(s.soldQty ? s.retQty / s.soldQty : null)}`} />
                      <Two main={money(s.netSales)} sub={units(s.soldQty - s.retQty)} className={`font-medium bg-gray-50 ${neg(s.netSales)}`} />
                      <Two main={money(s.ads + s.otherRevenue)} />
                      <Two main={money(s.distribution)} />
                      <Two main={money(s.marketing)} />
                      <Two main={money(s.magazine + s.otherCost)} />
                      <Two main={money(s.profit)} sub={pct(s.revenue ? s.profit / s.revenue : null)} className={`font-semibold bg-gray-50 ${s.profit < 0 ? 'text-red-600' : 'text-emerald-700'}`} />
                    </tr>
                    {open[m.item] && (
                      <tr>
                        <td colSpan={10} className="bg-gray-50/60 px-3 md:px-6 py-4">
                          <div className="grid grid-cols-1 min-[1900px]:grid-cols-[3fr_2fr] gap-4 items-start">
                            <TaskTable m={m} taskNames={data.taskNames} openTask={openTask} toggle={k => setOpenTask(o => ({ ...o, [k]: !o[k] }))} />
                            <LocationTable title="Ventas y devoluciones por localización (Description 2)" locations={m.locations} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {!rows.length && <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-500">Ninguna revista con estos filtros.</td></tr>}
              </tbody>
              {rows.length > 0 && (
                <tfoot className="border-t-2 border-gray-300 font-semibold bg-gray-50">
                  <tr className="align-top">
                    <td className="px-2 py-2">TOTAL <span className="font-normal text-gray-500">({rows.length} revistas)</span></td>
                    <td />
                    <Two main={money(total.sold)} sub={units(total.soldQty)} />
                    <Two main={money(total.returned)} sub={`${units(total.retQty)} · ${pct(total.soldQty ? total.retQty / total.soldQty : null)}`} />
                    <Two main={money(total.netSales)} sub={units(total.soldQty - total.retQty)} className="bg-gray-100" />
                    <Two main={money(total.ads + total.otherRevenue)} />
                    <Two main={money(total.distribution)} />
                    <Two main={money(total.marketing)} />
                    <Two main={money(total.magazine + total.otherCost)} />
                    <Two main={money(total.profit)} sub={pct(total.revenue ? total.profit / total.revenue : null)} className={`bg-gray-100 ${total.profit < 0 ? 'text-red-600' : 'text-emerald-700'}`} />
                  </tr>
                </tfoot>
              )}
            </table>
          </section>

          {totalLocations.length > 0 && (
            <LocationTable title={`Ventas y devoluciones por localización · ${rows.length} revistas`} locations={totalLocations} />
          )}
        </>
      )}
    </div>
  );
}

// Celda numérica con una segunda línea pequeña (unidades, %)
function Two({ main, sub, className = '' }: { main: string; sub?: string; className?: string }) {
  return (
    <td className={`px-2 py-1.5 text-right whitespace-nowrap tabular-nums ${className}`}>
      {main}{sub != null && <p className="text-xs font-normal text-gray-500">{sub}</p>}
    </td>
  );
}

// Tareas del proyecto, como en el Project Card: Begin-Total, líneas Posting y End-Total por grupo
function TaskTable({ m, taskNames, openTask, toggle }: {
  m: Magazine; taskNames: Record<string, string>; openTask: Record<string, boolean>; toggle: (k: string) => void;
}) {
  const th = 'px-3 py-2 font-semibold whitespace-nowrap';
  const td = 'px-3 py-1.5 whitespace-nowrap tabular-nums';
  // Tareas con movimientos más las del proyecto (para ver la estructura completa)
  const keys = Array.from(new Set([...Object.keys(taskNames).filter(k => /^\d{3}\.\d{3}$/.test(k) && !k.endsWith('.999')), ...Object.keys(m.tasks)])).sort();
  const groups = Array.from(new Set([...GROUPS, ...keys.map(groupOf)])).sort();
  const isRevenue = (k: string) => groupOf(k) === '001';
  const profit = Object.values(m.tasks).reduce((a, t) => a + t.value, 0);
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
      <p className="px-3 py-2 text-xs font-semibold text-gray-600 border-b border-gray-100">Project Card · {m.project || m.item}{m.projects.length > 1 && <span className="font-normal text-amber-700"> (también {m.projects.filter(p => p !== m.project).join(', ')})</span>}</p>
      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500 bg-gray-50">
          <tr>
            <th className={`${th} text-left`}>Task No.</th><th className={`${th} text-left`}>Descripción</th>
            <th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Ingresos (Total Price)</th><th className={`${th} text-right`}>Coste (Total Cost)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {groups.map(g => {
            const inGroup = keys.filter(k => groupOf(k) === g);
            const sum = inGroup.reduce((a, k) => a + (m.tasks[k]?.value || 0), 0);
            const qty = inGroup.reduce((a, k) => a + (m.tasks[k]?.qty || 0), 0);
            return (
              <Fragment key={g}>
                <tr className="bg-gray-50/80 font-semibold text-gray-800"><td className={td}>{g}</td><td className="px-3 py-1.5" colSpan={4}>{taskNames[g] || GROUP_LABEL[g] || g}</td></tr>
                {inGroup.map(k => {
                  const t = m.tasks[k];
                  const entries = m.entries.filter(e => e.task === k);
                  const ok = `${m.item}|${k}`;
                  return (
                    <Fragment key={k}>
                      <tr className={entries.length ? 'cursor-pointer hover:bg-gray-50' : ''} onClick={() => entries.length && toggle(ok)}>
                        <td className={`${td} pl-6`}>{k}</td>
                        <td className="px-3 py-1.5">
                          <span className="inline-flex items-center gap-1">
                            {entries.length > 0 && (openTask[ok] ? <ChevronDown size={12} className="text-gray-400" /> : <ChevronRight size={12} className="text-gray-400" />)}
                            {taskNames[k] || k}{entries.length > 0 && <span className="text-xs text-gray-400">({entries.length})</span>}
                          </span>
                        </td>
                        <td className={`${td} text-right`}>{t ? units(t.qty) : '—'}</td>
                        <td className={`${td} text-right ${isRevenue(k) ? neg(t?.value || 0) : ''}`}>{isRevenue(k) && t ? money(t.value) : '—'}</td>
                        <td className={`${td} text-right`}>{!isRevenue(k) && t ? money(-t.value) : '—'}</td>
                      </tr>
                      {openTask[ok] && (
                        <tr><td colSpan={5} className="px-3 py-2 bg-gray-50">
                          <table className="w-full text-xs">
                            <thead className="text-gray-500"><tr>
                              {['Documento', 'Fecha', 'Cliente / proveedor', 'Nº', 'Descripción', 'Localización', 'Cantidad', 'Importe'].map(h =>
                                <th key={h} className={`px-2 py-1 font-semibold ${['Cantidad', 'Importe'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
                            </tr></thead>
                            <tbody className="divide-y divide-gray-100">
                              {entries.map((e, i) => (
                                <tr key={i}>
                                  <td className="px-2 py-1 whitespace-nowrap"><span className="text-gray-400 mr-1">{DOC_TYPE[e.kind].label}</span>{e.doc} <DocPdfLink documentNo={e.doc} kind={DOC_TYPE[e.kind].pdf} company={COMPANY} /></td>
                                  <td className="px-2 py-1 whitespace-nowrap">{dmy(e.date)}</td>
                                  <td className="px-2 py-1">{e.partner}</td><td className="px-2 py-1 whitespace-nowrap">{e.no}</td>
                                  <td className="px-2 py-1">{e.description}{e.fixed && <p className="text-sky-700 flex items-center gap-1"><Wrench size={11} /> {e.fixed}</p>}</td><td className="px-2 py-1 whitespace-nowrap">{e.location}</td>
                                  <td className="px-2 py-1 text-right tabular-nums">{units(e.qty)}</td>
                                  <td className={`px-2 py-1 text-right tabular-nums ${neg(isRevenue(k) ? e.value : -e.value)}`}>{money(isRevenue(k) ? e.value : -e.value)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
                <tr className="font-semibold text-gray-800">
                  <td className={td}>{g}.999</td><td className="px-3 py-1.5">END {taskNames[g] || GROUP_LABEL[g] || g}</td>
                  <td className={`${td} text-right`}>{g === '001' ? '' : units(qty)}</td>
                  <td className={`${td} text-right`}>{g === '001' ? money(sum) : ''}</td>
                  <td className={`${td} text-right`}>{g !== '001' ? money(-sum) : ''}</td>
                </tr>
              </Fragment>
            );
          })}
          <tr className="border-t-2 border-gray-300 font-bold">
            <td className={td} /><td className="px-3 py-2">BENEFICIO</td><td />
            <td className={`${td} text-right ${profit < 0 ? 'text-red-600' : 'text-emerald-700'}`} colSpan={2}>{money(profit)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function LocationTable({ title, locations }: { title: string; locations: MagLocation[] }) {
  const th = 'px-3 py-2 font-semibold whitespace-nowrap';
  const td = 'px-3 py-1.5 whitespace-nowrap tabular-nums';
  const t = locations.reduce((a, l) => ({ soldQty: a.soldQty + l.soldQty, soldAmount: a.soldAmount + l.soldAmount, retQty: a.retQty + l.retQty, retAmount: a.retAmount + l.retAmount }),
    { soldQty: 0, soldAmount: 0, retQty: 0, retAmount: 0 });
  const row = (l: Omit<MagLocation, 'location'>) => (
    <>
      <td className={`${td} text-right`}>{units(l.soldQty)}</td>
      <td className={`${td} text-right`}>{money(l.soldAmount)}</td>
      <td className={`${td} text-right`}>{units(l.retQty)}</td>
      <td className={`${td} text-right`}>{money(l.retAmount)}</td>
      <td className={`${td} text-right text-gray-600`}>{pct(l.soldQty ? l.retQty / l.soldQty : null)}</td>
      <td className={`${td} text-right ${neg(l.soldQty - l.retQty)}`}>{units(l.soldQty - l.retQty)}</td>
      <td className={`${td} text-right font-medium ${neg(l.soldAmount - l.retAmount)}`}>{money(l.soldAmount - l.retAmount)}</td>
    </>
  );
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
      <p className="px-3 py-2 text-xs font-semibold text-gray-600 border-b border-gray-100">{title}</p>
      {locations.length ? (
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 bg-gray-50">
            <tr>
              <th className={`${th} text-left`}>Localización</th>
              <th className={`${th} text-right`}>Uds vendidas</th><th className={`${th} text-right`}>Venta</th>
              <th className={`${th} text-right`}>Uds devueltas</th><th className={`${th} text-right`}>Devoluciones</th>
              <th className={`${th} text-right`}>% devol.</th><th className={`${th} text-right`}>Uds netas</th><th className={`${th} text-right`}>Venta neta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {locations.map(l => <tr key={l.location}><td className="px-3 py-1.5">{l.location}</td>{row(l)}</tr>)}
          </tbody>
          <tfoot className="border-t-2 border-gray-300 font-semibold"><tr><td className="px-3 py-2">Total</td>{row(t)}</tr></tfoot>
        </table>
      ) : <p className="px-3 py-4 text-sm text-gray-500">Sin ventas ni devoluciones de D-FORCE.</p>}
    </section>
  );
}
