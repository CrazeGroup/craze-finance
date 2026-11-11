'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, RefreshCw, Search, Wrench } from 'lucide-react';
import DocPdfLink from '@/components/DocPdfLink';
import type { ProvisionSettings, Correction, MagEntry, Magazine, MagazineAnalysis as Analysis, MagLocation, Unassigned, Validation } from '@/lib/magazineAnalysis';

type MagazineAnalysis = Analysis & { validated?: Record<string, Validation>; provisions?: ProvisionSettings };

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

// ---- Provisión de devoluciones ----
// Forecasted Returns (001.002) = % provisionado de la venta − devoluciones reales (nunca negativo; 0 con la provisión
// cerrada). Las devoluciones de Grosso - Ost / West vuelven al almacén: recuperan el gadget a su coste unitario
// (004.001 / uds compradas). Las previstas, en la proporción de Ost+West en las ventas, o en las devoluciones reales
// cuando ya llegan a la mitad de lo provisionado.
const TASK_FORECAST = '001.002';
const GADGET_TASK = '004.001';
const GADGET_REAL = '004.001-R', GADGET_FC = '004.001-P';
const RECOVER_LOCATIONS = ['Grosso - Ost', 'Grosso - West'];
const EXTRA_TASK_NAMES: Record<string, string> = {
  [GADGET_REAL]: 'Gadget recuperado · devoluciones reales Grosso Ost/West',
  [GADGET_FC]: 'Gadget recuperado · devoluciones previstas',
};
type ProvInfo = {
  pct: number | null; own: boolean; closed: boolean; closedAt: string; provQty: number; provAmount: number; retQty: number; retAmount: number;
  fcQty: number; fcAmount: number; unitGadget: number; share: number; byReturns: boolean; recQty: number; fcRecQty: number;
};
export function withProvision(m: Magazine, settings: ProvisionSettings | undefined): { m: Magazine; p: ProvInfo } {
  const own = settings?.mags?.[m.item];
  const pct = own?.pct ?? settings?.defaultPct ?? null;
  const closed = !!own?.closed;
  const sold = m.tasks[TASK_SALES] || { qty: 0, value: 0 }, ret = m.tasks[TASK_RETURNS] || { qty: 0, value: 0 };
  const retQty = -ret.qty, retAmount = -ret.value;
  const provQty = pct != null ? (sold.qty * pct) / 100 : 0, provAmount = pct != null ? (sold.value * pct) / 100 : 0;
  const fcQty = closed || pct == null ? 0 : Math.max(0, provQty - retQty);
  const fcAmount = closed || pct == null ? 0 : Math.max(0, provAmount - retAmount);
  const gadget = m.tasks[GADGET_TASK];
  const bought = gadget && gadget.qty > 1 ? gadget.qty : m.printRun;
  const unitGadget = gadget && bought ? -gadget.value / bought : 0;
  const inLoc = (l: MagLocation) => RECOVER_LOCATIONS.includes(l.location);
  const recQty = m.locations.filter(inLoc).reduce((a, l) => a + l.retQty, 0);
  const soldOW = m.locations.filter(inLoc).reduce((a, l) => a + l.soldQty, 0);
  // Mezcla de las devoluciones solo cuando ya son representativas (≥ la mitad de lo provisionado); antes, la de las
  // ventas (las primeras devoluciones son casi todas de Grosso y sesgarían la proporción)
  const byReturns = pct != null && retQty > 0 && retQty >= provQty / 2;
  const share = byReturns ? recQty / retQty : sold.qty > 0 ? soldOW / sold.qty : 0;
  const fcRecQty = fcQty * share;
  const tasks = { ...m.tasks };
  if (fcAmount > 0.005 || fcQty > 0.5) tasks[TASK_FORECAST] = { qty: -Math.round(fcQty), value: -Math.round(fcAmount * 100) / 100 };
  if (unitGadget && recQty > 0) tasks[GADGET_REAL] = { qty: recQty, value: Math.round(recQty * unitGadget * 100) / 100 };
  if (unitGadget && fcRecQty > 0.5) tasks[GADGET_FC] = { qty: Math.round(fcRecQty), value: Math.round(fcRecQty * unitGadget * 100) / 100 };
  return {
    m: { ...m, tasks },
    p: { pct, own: own?.pct != null, closed, closedAt: own?.closedAt || '', provQty, provAmount, retQty, retAmount, fcQty, fcAmount, unitGadget, share, byReturns, recQty, fcRecQty },
  };
}

type Summary = {
  forecastQty: number; forecast: number;
  soldQty: number; sold: number; retQty: number; returned: number; netSales: number; ads: number; otherRevenue: number;
  revenue: number; distribution: number; marketing: number; magazine: number; otherCost: number; costs: number; profit: number;
};
const groupOf = (task: string) => task.substring(0, 3);
function summarize(m: Pick<Magazine, 'tasks'>): Summary {
  const t = (k: string) => m.tasks[k] || { qty: 0, value: 0 };
  let otherRevenue = 0, distribution = 0, marketing = 0, magazine = 0, otherCost = 0;
  for (const [k, v] of Object.entries(m.tasks)) {
    if (k === TASK_SALES || k === TASK_RETURNS || k === TASK_ADS || k === TASK_FORECAST) continue;
    const g = groupOf(k);
    if (g === '001') otherRevenue += v.value;
    else if (g === '002') distribution -= v.value;
    else if (g === '003') marketing -= v.value;
    else if (g === '004') magazine -= v.value;
    else otherCost -= v.value;
  }
  const sold = t(TASK_SALES).value, returned = -t(TASK_RETURNS).value, ads = t(TASK_ADS).value, forecast = -t(TASK_FORECAST).value;
  const netSales = sold - returned - forecast;
  const revenue = netSales + ads + otherRevenue;
  const costs = distribution + marketing + magazine + otherCost;
  return {
    forecastQty: -t(TASK_FORECAST).qty, forecast,
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
  // Correcciones ya vistas (OK): en este navegador; vuelven arriba solo si aparecen nuevas
  const fixSig = (c: Correction) => `${c.kind}|${c.doc}|${c.no}|${c.magazine}|${c.task}|${c.amount}`;
  const [fixesOk, setFixesOk] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { setFixesOk(new Set(JSON.parse(localStorage.getItem('crz-magprof-fixes-ok') || '[]'))); } catch { /* sin almacenamiento */ }
  }, []);
  const newFixes = (data?.corrections || []).filter(c => !fixesOk.has(fixSig(c))).length;
  const ackFixes = () => {
    const all = new Set((data?.corrections || []).map(fixSig));
    setFixesOk(all); setShowFixes(false);
    try { localStorage.setItem('crz-magprof-fixes-ok', JSON.stringify(Array.from(all))); } catch { /* sin almacenamiento */ }
  };
  // Asignación a mano de una línea sin revista (revista + tarea)
  const [draft, setDraft] = useState<Record<string, { magazine: string; task: string }>>({});
  const magOptions = useMemo(() => (data?.magazines || []).map(m => ({ item: m.item, label: `${m.title} ${m.issue.substring(2)}/${m.issue.substring(0, 2)}` })), [data]);
  const taskOptions = useMemo(() => Object.entries(data?.taskNames || {})
    .filter(([k]) => /^\d{3}\.\d{3}$/.test(k) && !k.endsWith('.999') && ![TASK_SALES, TASK_RETURNS, '001.002'].includes(k)).sort(), [data]);
  const assign = async (key: string, value: { magazine: string; task: string } | null, u?: Unassigned) => {
    setSaving(true);
    try {
      const res = await fetch('/api/magazines/analysis/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value ? { key, ...value, doc: u?.doc, description: u ? `${u.partner} · ${u.description}` : '' } : { key, remove: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      alert(`No se ha podido guardar: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };
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

  const saveProvision = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/magazines/analysis/provision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(d => (d ? { ...d, provisions: json.provisions } : d));
    } catch (e: any) {
      alert(`No se ha podido guardar: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };
  // Excluir del margen (provisiones de D-FORCE que facturan y abonan): la línea se queda tachada en el detalle
  const exclude = async (m: Magazine, e: MagEntry, excluded: boolean) => {
    if (!e.key) return;
    setSaving(true);
    try {
      const res = await fetch('/api/magazines/analysis/exclude', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excluded, lines: [{ key: e.key, doc: e.doc, description: `${m.item} · ${e.partner} · ${e.description} · ${e.value}` }] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (err: any) {
      alert(`No se ha podido guardar: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };
  const parsePct = (v: string) => { const x = v.trim().replace(',', '.'); return x === '' ? null : Math.min(100, Math.max(0, parseFloat(x))); };

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
    ).map(raw => { const { m, p } = withProvision(raw, data?.provisions); return { m, p, s: summarize(m) }; });
  }, [data, title, year, q, onlyActive]);
  const total = useMemo(() => summarize(addTasks(rows.map(r => r.m))), [rows]);
  const totalLocations = useMemo(() => addLocations(rows.map(r => r.m)), [rows]);

  const exportExcel = () => {
    if (!data) return;
    const head = ['Revista', 'Descripción', 'Proyecto', 'On Sale', 'Tirada', 'Uds vendidas', 'Venta', 'Uds devueltas', 'Devoluciones', '% devol. uds', 'Uds devol. previstas', 'Devol. previstas',
      'Venta neta', 'Magazine Ads', 'Otros ingresos', 'Distribución', 'Marketing', 'Costes revista', 'Otros costes', 'Beneficio', 'Margen %'];
    const summaryRow = (m: { item: string; description: string; project: string; onSaleDate: string; printRun: number } | null, x: Summary) => [
      m?.item || 'TOTAL', m?.description || '', m?.project || '', m?.onSaleDate ? new Date(m.onSaleDate) : '', m?.printRun || '',
      x.soldQty, x.sold, x.retQty, x.returned, x.soldQty ? x.retQty / x.soldQty : '', x.forecastQty, x.forecast, x.netSales, x.ads, x.otherRevenue,
      x.distribution, x.marketing, x.magazine, x.otherCost, x.profit, x.revenue ? x.profit / x.revenue : '',
    ];
    const ws1 = XLSX.utils.aoa_to_sheet([head, ...rows.map(r => summaryRow(r.m, r.s)), summaryRow(null, total)], { cellDates: true });
    const locHead = ['Revista', 'Proyecto', 'Localización', 'Uds vendidas', 'Venta', 'Uds devueltas', 'Devoluciones', '% devol. uds', 'Uds netas', 'Venta neta'];
    const locRow = (item: string, project: string, l: MagLocation) => [item, project, l.location, l.soldQty, l.soldAmount, l.retQty, l.retAmount,
      l.soldQty ? l.retQty / l.soldQty : '', l.soldQty - l.retQty, l.soldAmount - l.retAmount];
    const ws2 = XLSX.utils.aoa_to_sheet([locHead, ...rows.flatMap(r => r.m.locations.map(l => locRow(r.m.item, r.m.project, l))),
      ...totalLocations.map(l => locRow('TOTAL', '', l))]);
    const lineHead = ['Revista', 'Proyecto', 'Tarea', 'Descripción tarea', 'Tipo doc.', 'Nº documento', 'Fecha', 'Cliente / proveedor', 'Nº', 'Descripción', 'Localización', 'Cantidad', 'Importe (resultado)', 'Excluida del margen'];
    const ws3 = XLSX.utils.aoa_to_sheet([lineHead, ...rows.flatMap(r => r.m.entries.map(e => [r.m.item, r.m.project, e.task, data.taskNames[e.task] || '',
      DOC_TYPE[e.kind].label, e.doc, e.date ? new Date(e.date) : '', e.partner, e.no, e.description, e.location, e.qty, e.value, e.excluded || '']))], { cellDates: true });
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
  const th2 = 'px-1.5 py-2 font-semibold whitespace-nowrap align-bottom';

  const unassignedBlock = data && (pending.length > 0 || validatedRows.length > 0) && (
            <section className="bg-amber-50 border border-amber-200 rounded-xl">
              <button onClick={() => setShowIssues(v => !v)} className="w-full px-4 py-2.5 flex items-center gap-2 text-sm text-amber-900 text-left">
                <AlertTriangle size={16} />
                <span className="font-semibold">{pending.length ? `${pending.length} líneas sin revista` : 'Ninguna línea sin revista pendiente'}</span>
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
                  {(pending.length > 0 || showValidated) && <table className="w-full text-xs bg-white rounded-lg border border-amber-200">
                    <thead className="text-gray-500 bg-gray-50"><tr>
                      {['Motivo', 'Documento', 'Fecha', 'Cliente / proveedor', 'Nº', 'Descripción', 'Project No.', 'Task No.', 'Cantidad', 'Importe', 'Asignar a revista', ''].map((h, i) =>
                        <th key={i} className={`${th} ${['Cantidad', 'Importe'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
                    </tr></thead>
                    <tbody className="divide-y divide-gray-100">
                      {[...pending, ...(showValidated ? validatedRows : [])].map(u => {
                        const v = data.validated?.[u.key];
                        return (
                          <tr key={u.key} className={v ? 'text-gray-400' : ''}>
                            <td className="px-3 py-1.5">{u.reason}{u.pdf && <p className="text-amber-700">{u.pdf}</p>}</td>
                            <td className={td}><span className="text-gray-400 mr-1">{DOC_TYPE[u.kind].label}</span>{u.doc} <DocPdfLink documentNo={u.doc} kind={DOC_TYPE[u.kind].pdf} company={COMPANY} /></td>
                            <td className={td}>{dmy(u.date)}</td><td className={td}>{u.partner}</td><td className={td}>{u.no}</td>
                            <td className="px-3 py-1.5">{u.description}</td><td className={td}>{u.project}</td><td className={td}>{u.task}</td>
                            <td className={`${td} text-right`}>{units(u.qty)}</td><td className={`${td} text-right`}>{money(u.amount)}</td>
                            <td className={td}>
                              {!v && (() => {
                                const d = draft[u.key] || { magazine: '', task: u.suggestedTask || '' };
                                const set = (x: Partial<typeof d>) => setDraft(o => ({ ...o, [u.key]: { ...d, ...x } }));
                                return (
                                  <span className="inline-flex items-center gap-1">
                                    <select value={d.magazine} onChange={e => set({ magazine: e.target.value })} className="border border-gray-300 rounded px-1 py-0.5 text-xs max-w-[9rem]">
                                      <option value="">Revista…</option>
                                      {magOptions.map(o => <option key={o.item} value={o.item}>{o.label} · {o.item}</option>)}
                                    </select>
                                    <select value={d.task} onChange={e => set({ task: e.target.value })} className="border border-gray-300 rounded px-1 py-0.5 text-xs max-w-[9rem]">
                                      <option value="">Tarea…</option>
                                      {taskOptions.map(([k, name]) => <option key={k} value={k}>{k} {name}</option>)}
                                    </select>
                                    <button onClick={() => assign(u.key, d, u)} disabled={saving || !d.magazine || !d.task}
                                      className="px-2 py-0.5 rounded bg-gray-900 text-white disabled:opacity-40">Asignar</button>
                                  </span>
                                );
                              })()}
                            </td>
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
                  </table>}
                </div>
              )}
            </section>
          );

  const fixesBlock = data && data.corrections.length > 0 && (
            <section className="bg-sky-50 border border-sky-200 rounded-xl">
              <div className="w-full px-4 py-2.5 flex items-center gap-2 text-sm text-sky-900">
                <button onClick={() => setShowFixes(v => !v)} className="flex items-center gap-2 text-left min-w-0 flex-1">
                  <Wrench size={16} className="shrink-0" />
                  <span>
                    <span className="font-semibold">{data.corrections.length} líneas corregidas en la app</span>
                    {newFixes > 0 && fixesOk.size > 0 && <span className="ml-1 px-1.5 rounded bg-sky-600 text-white text-xs">{newFixes} nuevas</span>}
                    <span className="text-sky-800">
                      {' '}· {data.corrections.filter(c => c.bcProject).length} con el proyecto de otra revista, {data.corrections.filter(c => !c.bcProject).length} sin proyecto.
                      Ya cuentan en la revista correcta; conviene corregir el Project No. en BC para que el Project Card coincida
                    </span>
                  </span>
                  {showFixes ? <ChevronDown size={16} className="ml-auto shrink-0" /> : <ChevronRight size={16} className="ml-auto shrink-0" />}
                </button>
                {newFixes > 0 && (
                  <button onClick={ackFixes} title="Visto: mover al final de la página hasta que haya correcciones nuevas"
                    className="shrink-0 px-3 py-1 rounded-md bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700">OK</button>
                )}
              </div>
              {showFixes && (
                <div className="px-4 pb-4 overflow-x-auto">
                  <p className="text-xs text-sky-900 mb-1">Ventas y devoluciones de D-FORCE: manda el artículo (su descripción dice la misma revista). Magazine Ads: manda la revista del External Document No. o, si no la dice, la fecha On Sale de la revista.</p>
                  <table className="w-full text-xs bg-white rounded-lg border border-sky-200">
                    <thead className="text-gray-500 bg-gray-50"><tr>
                      {['Motivo', 'Documento', 'Fecha', 'Nº', 'Descripción', 'Localización', 'Project No. en BC', 'Revista correcta', 'Tarea', 'Cantidad', 'Importe', ''].map((h, i) =>
                        <th key={i} className={`${th} ${['Cantidad', 'Importe'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
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
                            <td className={`${td} text-right`}>
                              {c.manual && c.key && <button onClick={() => assign(c.key!, null)} disabled={saving} className="underline text-gray-500 hover:text-gray-800">Quitar</button>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
  );

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
        <label className="flex items-center gap-1.5 text-sm text-gray-700" title="Forecasted Returns: % de la venta que se espera devuelto (para todas las revistas sin % propio)">
          Provisión devoluciones
          <input key={`def-${data?.provisions?.defaultPct ?? ''}`} defaultValue={data?.provisions?.defaultPct ?? ''} placeholder="—" disabled={!data || saving}
            onBlur={e => { const v = parsePct(e.target.value); if (v !== (data?.provisions?.defaultPct ?? null) && (v === null || !isNaN(v))) void saveProvision({ defaultPct: v }); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-16 text-right" /> %
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
              { label: 'Venta neta', value: money(total.netSales), sub: `${units(total.soldQty - total.retQty - total.forecastQty)} uds netas${total.forecast ? ' (con previstas)' : ''}` },
              { label: 'Devoluciones', value: money(total.returned + total.forecast), sub: `${money(total.returned)} reales + ${money(total.forecast)} previstas · ${pct(total.soldQty ? (total.retQty + total.forecastQty) / total.soldQty : null)} uds` },
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

          {pending.length > 0 && unassignedBlock}

          {newFixes > 0 && fixesBlock}

          <section className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-gray-50 text-xs text-gray-500 border-b border-gray-200">
                <tr>
                  <th className={`${th2} text-left`}>Revista</th>
                  <th className={`${th2} text-left`}>Proyecto<br /><span className="font-normal">On Sale · Tirada</span></th>
                  <th className={`${th2} text-right`}>Venta<br /><span className="font-normal">uds</span></th>
                  <th className={`${th2} text-right`}>Devoluciones<br /><span className="font-normal">uds · %</span></th>
                  <th className={`${th2} text-right`}>Devol. previstas<br /><span className="font-normal">provisión</span></th>
                  <th className={`${th2} text-right bg-gray-100`}>Venta neta<br /><span className="font-normal">uds netas</span></th>
                  <th className={`${th2} text-right`}>Magazine Ads</th>
                  <th className={`${th2} text-right`}>Distribución</th>
                  <th className={`${th2} text-right`}>Marketing</th>
                  <th className={`${th2} text-right`}>Costes revista</th>
                  <th className={`${th2} text-right bg-gray-100`}>Beneficio<br /><span className="font-normal">margen</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(({ m, s, p }) => (
                  <Fragment key={m.item}>
                    <tr className="hover:bg-gray-50 cursor-pointer align-top" onClick={() => setOpen(o => ({ ...o, [m.item]: !o[m.item] }))}>
                      <td className="px-2 py-1.5">
                        <div className="flex items-start gap-1">
                          {open[m.item] ? <ChevronDown size={14} className="text-gray-400 shrink-0 mt-0.5" /> : <ChevronRight size={14} className="text-gray-400 shrink-0 mt-0.5" />}
                          <div className="min-w-0">
                            <p className="font-medium text-gray-900 whitespace-nowrap">{m.title} {m.issue.substring(2)}/{m.issue.substring(0, 2)} <span className="text-gray-400 font-normal">{m.item}</span></p>
                            <p className="text-xs text-gray-500 truncate max-w-[14rem]" title={m.description}>{m.description.replace(/^MAGAZINE\s*-\s*/i, '').replace(/^\S+\s+\d{2}\/\d{2}\s*/, '')}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-gray-700">
                        {m.project}{m.projects.length > 1 && <span className="text-xs text-amber-600" title={`También: ${m.projects.filter(p => p !== m.project).join(', ')}`}> +{m.projects.length - 1}</span>}
                        <p className="text-xs text-gray-400">{[dmy(m.onSaleDate), m.printRun ? `${qf.format(m.printRun)} uds` : ''].filter(Boolean).join(' · ')}</p>
                      </td>
                      <Two main={money(s.sold)} sub={units(s.soldQty)} />
                      <Two main={money(s.returned)} sub={`${units(s.retQty)} · ${pct(s.soldQty ? s.retQty / s.soldQty : null)}`} />
                      <Two main={p.closed ? 'cerrada' : money(s.forecast)} className={p.closed ? 'text-gray-500' : ''}
                        sub={p.pct == null ? 'sin %' : `${units(s.forecastQty)} · ${qf.format(p.pct)} %${p.own ? '' : ' (gral.)'}`} />
                      <Two main={money(s.netSales)} sub={units(s.soldQty - s.retQty - s.forecastQty)} className={`font-medium bg-gray-50 ${neg(s.netSales)}`} />
                      <Two main={money(s.ads + s.otherRevenue)} />
                      <Two main={money(s.distribution)} />
                      <Two main={money(s.marketing)} />
                      <Two main={money(s.magazine + s.otherCost)} />
                      <Two main={money(s.profit)} sub={pct(s.revenue ? s.profit / s.revenue : null)} className={`font-semibold bg-gray-50 ${s.profit < 0 ? 'text-red-600' : 'text-emerald-700'}`} />
                    </tr>
                    {open[m.item] && (
                      <tr>
                        <td colSpan={11} className="bg-gray-50/60 px-3 md:px-6 py-4">
                          <div className="grid grid-cols-1 min-[1900px]:grid-cols-[3fr_2fr] gap-4 items-start">
                            <div className="space-y-4 min-[1900px]:col-span-2">
                              <ProvisionPanel m={m} p={p} saving={saving} parsePct={parsePct} save={saveProvision} defaultPct={data.provisions?.defaultPct ?? null} />
                            </div>
                            <TaskTable m={m} taskNames={{ ...data.taskNames, ...EXTRA_TASK_NAMES }} saving={saving} exclude={(e, x) => exclude(m, e, x)} openTask={openTask} toggle={k => setOpenTask(o => ({ ...o, [k]: !o[k] }))} />
                            <LocationTable title="Ventas y devoluciones por localización (Description 2)" locations={m.locations} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {!rows.length && <tr><td colSpan={11} className="px-3 py-6 text-center text-gray-500">Ninguna revista con estos filtros.</td></tr>}
              </tbody>
              {rows.length > 0 && (
                <tfoot className="border-t-2 border-gray-300 font-semibold bg-gray-50">
                  <tr className="align-top">
                    <td className="px-2 py-2">TOTAL <span className="font-normal text-gray-500">({rows.length} revistas)</span></td>
                    <td />
                    <Two main={money(total.sold)} sub={units(total.soldQty)} />
                    <Two main={money(total.returned)} sub={`${units(total.retQty)} · ${pct(total.soldQty ? total.retQty / total.soldQty : null)}`} />
                    <Two main={money(total.forecast)} sub={units(total.forecastQty)} />
                    <Two main={money(total.netSales)} sub={units(total.soldQty - total.retQty - total.forecastQty)} className="bg-gray-100" />
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

          {newFixes === 0 && fixesBlock}

          {pending.length === 0 && unassignedBlock}
        </>
      )}
    </div>
  );
}

// Celda numérica con una segunda línea pequeña (unidades, %)
function Two({ main, sub, className = '' }: { main: string; sub?: string; className?: string }) {
  return (
    <td className={`px-1.5 py-1.5 text-right whitespace-nowrap tabular-nums ${className}`}>
      {main}{sub != null && <p className="text-xs font-normal text-gray-500">{sub}</p>}
    </td>
  );
}

// Provisión de devoluciones de una revista: % propio (o el general), lo provisionado frente a lo devuelto y cierre
function ProvisionPanel({ m, p, saving, parsePct, save, defaultPct }: {
  m: Magazine; p: ProvInfo; saving: boolean; parsePct: (v: string) => number | null; save: (b: Record<string, unknown>) => Promise<void>; defaultPct: number | null;
}) {
  const diffAmount = p.provAmount - p.retAmount, diffQty = p.provQty - p.retQty;
  const fmtDate = (d: string) => (d ? d.substring(0, 10).split('-').reverse().join('/') : '');
  return (
    <section className="bg-white rounded-xl border border-gray-200 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className="font-semibold text-gray-800">Provisión de devoluciones</p>
        <label className="flex items-center gap-1.5 text-gray-700">
          % de la venta
          <input key={`${m.item}-${p.own ? p.pct : ''}`} defaultValue={p.own && p.pct != null ? String(p.pct) : ''} placeholder={defaultPct != null ? String(defaultPct) : '—'}
            disabled={saving || p.closed}
            onBlur={e => { const v = parsePct(e.target.value); if ((v ?? null) !== (p.own ? p.pct : null) && (v === null || !isNaN(v))) void save({ item: m.item, pct: v }); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="border border-gray-300 rounded px-2 py-1 w-16 text-right disabled:bg-gray-50" /> %
          <span className="text-xs text-gray-400">{p.own ? 'propio' : defaultPct != null ? `general (${qf.format(defaultPct)} %)` : 'sin % general'}</span>
        </label>
        <span className="text-gray-600">Provisionado: <b className="tabular-nums">{money(p.provAmount)}</b> <span className="text-xs text-gray-400">{units(p.provQty)} uds</span></span>
        <span className="text-gray-600">Devuelto real: <b className="tabular-nums">{money(p.retAmount)}</b> <span className="text-xs text-gray-400">{units(p.retQty)} uds</span></span>
        {p.closed ? (
          <span className={diffAmount >= 0 ? 'text-amber-700' : 'text-red-600'}>
            Cerrada el {fmtDate(p.closedAt)}: {diffAmount >= 0 ? 'provisionado de más' : 'provisionado de menos'} <b className="tabular-nums">{money(Math.abs(diffAmount))}</b> ({units(Math.abs(diffQty))} uds)
          </span>
        ) : (
          <span className="text-gray-600">Previsto pendiente: <b className="tabular-nums">{money(p.fcAmount)}</b> <span className="text-xs text-gray-400">{units(p.fcQty)} uds</span></span>
        )}
        <button onClick={() => save({ item: m.item, closed: !p.closed })} disabled={saving || (!p.closed && p.pct == null)}
          className={`ml-auto px-3 py-1 rounded-md text-xs font-semibold disabled:opacity-40 ${p.closed ? 'border border-gray-300 hover:bg-gray-50' : 'bg-gray-900 text-white hover:bg-black'}`}>
          {p.closed ? 'Reabrir provisión' : 'Cerrar provisión'}
        </button>
      </div>
      <p className="text-xs text-gray-500 mt-1.5">
        Gadget a {nf.format(p.unitGadget)} €/ud: devoluciones reales en Grosso Ost/West {units(p.recQty)} uds; de las previstas se recupera el {pct(p.share)} ({units(p.fcRecQty)} uds),
        la proporción de Ost+West en {p.byReturns ? 'las devoluciones reales' : 'las ventas (hasta que las devoluciones reales lleguen a la mitad de lo provisionado)'}. El resto de devoluciones no vuelve al almacén.
      </p>
    </section>
  );
}

// Tareas del proyecto, como en el Project Card: Begin-Total, líneas Posting y End-Total por grupo
function TaskTable({ m, taskNames, openTask, toggle, saving, exclude }: {
  m: Magazine; taskNames: Record<string, string>; saving: boolean; exclude: (e: MagEntry, excluded: boolean) => void; openTask: Record<string, boolean>; toggle: (k: string) => void;
}) {
  const th = 'px-3 py-2 font-semibold whitespace-nowrap';
  const td = 'px-3 py-1.5 whitespace-nowrap tabular-nums';
  // Tareas con movimientos más las del proyecto (para ver la estructura completa)
  const keys = Array.from(new Set([...Object.keys(taskNames).filter(k => /^\d{3}\.\d{3}$/.test(k) && !k.endsWith('.999')), ...Object.keys(m.tasks)])).sort();
  const groups = Array.from(new Set([...GROUPS, ...keys.map(groupOf)])).sort();
  const profit = Object.values(m.tasks).reduce((a, t) => a + t.value, 0);
  const soldQty = m.tasks[TASK_SALES]?.qty || 0;
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
      <p className="px-3 py-2 text-xs font-semibold text-gray-600 border-b border-gray-100">Project Card · {m.project || m.item}{m.projects.length > 1 && <span className="font-normal text-amber-700"> (también {m.projects.filter(p => p !== m.project).join(', ')})</span>}</p>
      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500 bg-gray-50">
          <tr>
            <th className={`${th} text-left`}>Task No.</th><th className={`${th} text-left`}>Descripción</th>
            <th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Ingreso / Coste</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {groups.map(g => {
            const inGroup = keys.filter(k => groupOf(k) === g);
            const sum = inGroup.reduce((a, k) => a + (m.tasks[k]?.value || 0), 0);
            const qty = inGroup.reduce((a, k) => a + (m.tasks[k]?.qty || 0), 0);
            return (
              <Fragment key={g}>
                <tr className="bg-gray-50/80 font-semibold text-gray-800"><td className={td}>{g}</td><td className="px-3 py-1.5" colSpan={3}>{taskNames[g] || GROUP_LABEL[g] || g}</td></tr>
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
                            {k === TASK_RETURNS && t && soldQty > 0 && <span className="text-xs text-gray-500">· {pct(-t.qty / soldQty)} de la venta</span>}
                          </span>
                        </td>
                        <td className={`${td} text-right`}>{t ? units(t.qty) : '—'}</td>
                        <td className={`${td} text-right ${neg(t?.value || 0)}`}>{t ? money(t.value) : '—'}</td>
                      </tr>
                      {openTask[ok] && (
                        <tr><td colSpan={4} className="px-3 py-2 bg-gray-50">
                          <table className="w-full text-xs">
                            <thead className="text-gray-500"><tr>
                              {['Documento', 'Fecha', 'Cliente / proveedor', 'Nº', 'Descripción', 'Localización', 'Cantidad', 'Importe', ''].map(h =>
                                <th key={h} className={`px-2 py-1 font-semibold ${['Cantidad', 'Importe'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
                            </tr></thead>
                            <tbody className="divide-y divide-gray-100">
                              {entries.map((e, i) => (
                                <tr key={i} className={e.excluded ? 'text-gray-400 [&>td:not(:last-child)]:line-through' : ''}>
                                  <td className="px-2 py-1 whitespace-nowrap"><span className="text-gray-400 mr-1">{DOC_TYPE[e.kind].label}</span>{e.doc} <DocPdfLink documentNo={e.doc} kind={DOC_TYPE[e.kind].pdf} company={COMPANY} /></td>
                                  <td className="px-2 py-1 whitespace-nowrap">{dmy(e.date)}</td>
                                  <td className="px-2 py-1">{e.partner}</td><td className="px-2 py-1 whitespace-nowrap">{e.no}</td>
                                  <td className="px-2 py-1">{e.description}{e.fixed && <p className="text-sky-700 flex items-center gap-1"><Wrench size={11} /> {e.fixed}</p>}{e.excluded && <p className="text-amber-700">{e.excluded}</p>}</td><td className="px-2 py-1 whitespace-nowrap">{e.location}</td>
                                  <td className="px-2 py-1 text-right tabular-nums">{units(e.qty)}</td>
                                  <td className={`px-2 py-1 text-right tabular-nums ${e.excluded ? '' : neg(e.value)}`}>{money(e.value)}</td>
                                  <td className="px-2 py-1 text-right whitespace-nowrap">
                                    {e.key && <button onClick={() => exclude(e, !e.excluded)} disabled={saving} title={e.excluded ? 'Volver a contar en el margen' : 'No contar en el margen (p. ej. una provisión que se factura y abona)'}
                                      className="underline text-gray-500 hover:text-gray-800 disabled:opacity-40">{e.excluded ? 'Incluir' : 'Excluir'}</button>}
                                  </td>
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
                  <td className={`${td} text-right ${neg(sum)}`}>{money(sum)}</td>
                </tr>
              </Fragment>
            );
          })}
          <tr className="border-t-2 border-gray-300 font-bold">
            <td className={td} /><td className="px-3 py-2">BENEFICIO</td><td />
            <td className={`${td} text-right ${profit < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{money(profit)}</td>
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
