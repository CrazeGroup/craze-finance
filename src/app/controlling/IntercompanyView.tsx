'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileDown, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';
import CompanySelect, { CONSOLIDATED, REPORT_COMPANIES, useReportCompany } from './CompanySelect';

// Controlling · Intercompany: facturas de venta entre empresas del grupo frente a su factura de compra en la otra
// empresa (mismo nº, importe, divisa, fecha, artículos y cantidades) y, en las ventas de CRAZE GmbH a UK / Group AG
// (drop shipment), la factura de venta final al cliente. Datos: /api/controlling/intercompany (una petición por empresa).
type Cmp = { no: string; description: string; a: number; b: number; aAmount?: number; bAmount?: number; equivalent?: string };
type Row = {
  source: string; target: string; invoiceNo: string; postingDate: string; invoiceDate: string; customer: string; currency: string; amount: number; externalDocNo: string;
  purchase: null | { no: string; vendorInvoiceNo: string; postingDate: string; invoiceDate: string; vendor: string; currency: string; amount: number };
  lines: Cmp[];
  final: null | { no: string; customer: string; postingDate: string; currency: string; amount: number; found: boolean; lines: Cmp[] };
  issues: string[];
  // Incidencias subsanadas con abonos y facturas nuevas (las incidencias se mantienen como comentario)
  corrected?: string[];
};
type Validation = { by?: string; at: string };
const rowKey = (r: Row) => `${r.source}|${r.invoiceNo}`;
type Orphan = { target: string; no: string; vendorInvoiceNo: string; postingDate: string; invoiceDate: string; vendor: string; currency: string; amount: number; source?: string };
type Excluded = { invoiceNo: string; creditMemoNo: string; target: string; postingDate: string; externalDocNo: string; creditMemoAmount: number; source?: string };
type Data = { rows: Row[]; orphanPurchases: Orphan[]; excludedCredited?: Excluded[]; warnings: string[] };

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const GROUPINGS = [
  { id: 'none', label: 'Sin agrupar' },
  { id: 'month', label: 'Mes' },
  { id: 'pair', label: 'Empresa origen → destino' },
  { id: 'issue', label: 'Tipo de incidencia' },
] as const;
type Grouping = typeof GROUPINGS[number]['id'];
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap text-left';
const td = 'py-1.5 px-2 whitespace-nowrap';
const issueType = (i: string) => i.replace(/\s*\(.*$/, '').replace(/ en (Craze UK|CRAZE Group AG|CRAZE|Craze Iberia SL|Craze Entertainment).*$/, '').replace(/ con (Vendor Invoice No\.|nº).*$/, '');

export default function IntercompanyView({ fmt, company: globalCompany }: { fmt: Fmt; company: string }) {
  const { num, date } = fmt;
  const [company, setCompany] = useReportCompany(globalCompany);
  const [from, setFrom] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(() => new Date().toISOString().substring(0, 10));
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [grouping, setGrouping] = useState<Grouping>('none');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  // Incidencias validadas a mano (revisadas y dadas por buenas), compartidas entre usuarios
  const [validated, setValidated] = useState<Record<string, Validation>>({});
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/controlling/intercompany/validated', { cache: 'no-store' }).then(r => r.json())
      .then(d => d.validated && setValidated(d.validated)).catch(() => {});
  }, [reload]);
  const isValidated = (r: Row) => !!validated[rowKey(r)];
  // Con incidencia pendiente: tiene incidencias, no están subsanadas y nadie las ha validado
  const pending = (r: Row) => r.issues.length > 0 && !r.corrected?.length && !isValidated(r);
  const setValid = async (r: Row, on: boolean) => {
    const key = rowKey(r);
    setSaving(key);
    try {
      const res = await fetch('/api/controlling/intercompany/validated', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, validated: on }) });
      const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
      setValidated(d.validated);
    } catch (e: any) {
      alert(`No se pudo guardar la validación: ${e.message}`);
    } finally {
      setSaving(null);
    }
  };

  useEffect(() => {
    if (!from || !to || from > to) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    const one = async (co: string): Promise<Data> => {
      const res = await fetch(`/api/controlling/intercompany?company=${encodeURIComponent(co)}&from=${from}&to=${to}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok || data.error) throw new Error(`${co}: ${data.error || `HTTP ${res.status}`}`);
      return { ...data, orphanPurchases: data.orphanPurchases.map((o: Orphan) => ({ ...o, source: co })), excludedCredited: (data.excludedCredited || []).map((x: Excluded) => ({ ...x, source: co })) };
    };
    // Consolidado: las facturas emitidas por todas las empresas
    const load = company === CONSOLIDATED
      ? Promise.allSettled(REPORT_COMPANIES.map(one)).then(settled => {
        const parts = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
        const failed = settled.flatMap(r => (r.status === 'rejected' ? [`No incluida: ${r.reason?.message || r.reason}`] : []));
        if (!parts.length) throw new Error(failed.join(' · '));
        return { rows: parts.flatMap(p => p.rows), orphanPurchases: parts.flatMap(p => p.orphanPurchases), excludedCredited: parts.flatMap(p => p.excludedCredited || []), warnings: [...failed, ...parts.flatMap(p => p.warnings)] };
      })
      : one(company);
    load.then(data => !cancelled && setState({ data, loading: false, error: null }))
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [company, from, to, reload]);

  const d = state.data;
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (d?.rows || []).filter(r => (!onlyIssues || pending(r))
      && (!q || [r.invoiceNo, r.externalDocNo, r.purchase?.no, r.purchase?.vendorInvoiceNo, r.final?.no, r.final?.customer, r.customer].some(v => v && v.toLowerCase().includes(q))))
      .sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.invoiceNo.localeCompare(b.invoiceNo));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, onlyIssues, search, validated]);
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const money = (v: number, cur: string) => `${num(v, 2)} ${cur}`;

  const groupKeys = (r: Row): string[] => grouping === 'month' ? [r.postingDate.substring(0, 7)]
    : grouping === 'pair' ? [`${r.source} → ${r.target}`]
    : grouping === 'issue' ? (r.corrected?.length ? ['Corregida'] : isValidated(r) ? ['Validada'] : r.issues.length ? Array.from(new Set(r.issues.map(issueType))) : ['Correcta']) : ['all'];
  const groupLabel = (k: string) => (grouping === 'month' ? `${MONTHS[Number(k.substring(5, 7)) - 1]} ${k.substring(0, 4)}` : k);

  const exportExcel = () => {
    const out = rows.map(r => ({
      'Empresa origen': r.source, 'Empresa destino': r.target, 'Factura venta': r.invoiceNo, 'Posting Date': r.postingDate, 'Fecha factura': r.invoiceDate,
      'Divisa': r.currency, 'Importe sin IVA': r.amount, 'External Document No.': r.externalDocNo,
      'Factura compra': r.purchase?.no || '', 'Vendor Invoice No.': r.purchase?.vendorInvoiceNo || '', 'Fecha compra': r.purchase?.invoiceDate || '',
      'Divisa compra': r.purchase?.currency || '', 'Importe compra': r.purchase?.amount ?? '',
      'Venta final': r.final?.found ? r.final.no : '', 'Cliente final': r.final?.customer || '', 'Incidencias': r.issues.join(' · ') || 'Correcta', 'Corregida': r.corrected?.join(' · ') || '',
      'Validada': validated[rowKey(r)] ? `${validated[rowKey(r)].by || 'Sí'} ${validated[rowKey(r)].at.substring(0, 10)}` : '',
    }));
    const orphans = (d?.orphanPurchases || []).map(o => ({ 'Empresa (compra)': o.target, 'Proveedor': o.vendor, 'Factura compra': o.no, 'Vendor Invoice No.': o.vendorInvoiceNo, 'Fecha': o.invoiceDate, 'Divisa': o.currency, 'Importe': o.amount }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), 'Facturas intercompañía');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orphans), 'Compras sin venta');
    XLSX.writeFile(wb, `Intercompany_${company}_${from}_${to}.xlsx`.replace(/\s+/g, '_'));
  };

  // Líneas por artículo: unidades e importe sin IVA de la venta, la compra y (drop shipment) la venta final
  const LinesTable = ({ r }: { r: Row }) => {
    const items = Array.from(new Set([...r.lines.map(l => l.no), ...(r.final?.lines || []).map(l => l.no)])).sort();
    const pCur = r.purchase?.currency || r.target, fCur = r.final?.currency || '';
    const rowsData = items.map(no => {
      const l = r.lines.find(x => x.no === no), f = r.final?.lines.find(x => x.no === no);
      return {
        no, l, f, eq: l?.equivalent, description: l?.description || f?.description || '',
        sale: l?.a ?? f?.a ?? 0, saleAmt: l?.aAmount ?? f?.aAmount ?? 0, purch: l?.b ?? 0, purchAmt: l?.bAmount ?? 0, fin: f?.b ?? 0, finAmt: f?.bAmount ?? 0,
      };
    });
    const sum = (k: 'saleAmt' | 'purchAmt' | 'finAmt') => rowsData.reduce((t, x) => t + x[k], 0);
    const red = 'text-[#C0392B] font-semibold';
    const sub = 'block text-[10px] font-normal normal-case tracking-normal text-gray-400';
    return (
      <table className="w-full text-[12px] bg-white border border-gray-200 rounded-lg">
        <thead><tr className="border-b border-gray-200 bg-gray-50">
          <th className={th}>Artículo</th><th className={th}>Descripción</th>
          <th className={`${th} text-right`}>Venta {r.source}<span className={sub}>uds.</span></th><th className={`${th} text-right`}>Venta {r.source}<span className={sub}>importe {r.currency}</span></th>
          <th className={`${th} text-right`}>Compra {r.target}<span className={sub}>uds.</span></th><th className={`${th} text-right`}>Compra {r.target}<span className={sub}>importe {pCur}</span></th>
          {r.final && <><th className={`${th} text-right`}>Venta final {r.target}<span className={sub}>uds.</span></th><th className={`${th} text-right`}>Venta final {r.target}<span className={sub}>importe {fCur}</span></th></>}
        </tr></thead>
        <tbody>
          {rowsData.map(x => {
            const qtyBad = !x.eq && Math.abs(x.sale - x.purch) > 0.0001;
            const amtBad = !x.eq && !!r.purchase && Math.abs(x.saleAmt - x.purchAmt) > 0.05;
            const finBad = !!r.final?.found && Math.abs(x.sale - x.fin) > 0.0001;
            return (
              <tr key={x.no} className={`border-b border-gray-100 ${qtyBad || amtBad || finBad ? 'bg-red-50' : ''}`}>
                <td className={`${td} font-mono font-semibold`}>{x.no}</td>
                <td className={td}>{x.description}{x.eq && <span className="ml-2 text-[11px] text-emerald-700 font-semibold">✓ {x.eq}</span>}</td>
                <td className={`${td} text-right font-mono`}>{num(x.sale)}</td>
                <td className={`${td} text-right font-mono`}>{num(x.saleAmt, 2)}</td>
                <td className={`${td} text-right font-mono ${qtyBad ? red : ''}`}>{r.purchase ? num(x.purch) : '–'}</td>
                <td className={`${td} text-right font-mono ${amtBad ? red : ''}`}>{r.purchase ? num(x.purchAmt, 2) : '–'}</td>
                {r.final && <td className={`${td} text-right font-mono ${finBad ? red : ''}`}>{r.final.found ? num(x.fin) : '–'}</td>}
                {r.final && <td className={`${td} text-right font-mono`}>{r.final.found ? num(x.finAmt, 2) : '–'}</td>}
              </tr>
            );
          })}
          <tr className="bg-gray-50 font-semibold">
            <td className={td} colSpan={2}>Total</td>
            <td className={td} /><td className={`${td} text-right font-mono`}>{num(sum('saleAmt'), 2)}</td>
            <td className={td} /><td className={`${td} text-right font-mono ${r.purchase && Math.abs(sum('saleAmt') - sum('purchAmt')) > 0.05 ? red : ''}`}>{r.purchase ? num(sum('purchAmt'), 2) : '–'}</td>
            {r.final && <><td className={td} /><td className={`${td} text-right font-mono`}>{r.final.found ? num(sum('finAmt'), 2) : '–'}</td></>}
          </tr>
        </tbody>
      </table>
    );
  };

  const RowsTable = ({ list }: { list: Row[] }) => (
    <table className="w-full text-[12px]">
      <thead><tr className="border-b border-gray-200 bg-gray-50">
        <th className={th} /><th className={th}>Origen → destino</th><th className={th}>Factura venta</th><th className={th}>Fecha</th>
        <th className={`${th} text-right`}>Importe</th><th className={th}>Factura compra</th><th className={th}>Vendor Inv. No.</th><th className={th}>Fecha compra</th>
        <th className={`${th} text-right`}>Importe compra</th><th className={th}>Venta final (drop shipment)</th><th className={th}>Incidencias</th>
      </tr></thead>
      <tbody>
        {list.map(r => {
          const k = rowKey(r), v = validated[k], canValidate = r.issues.length > 0 && !r.corrected?.length;
          return (
            <Fragment key={k}>
              <tr className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${r.issues.length ? '' : ''}`} onClick={() => toggle(k)}>
                <td className={td}>{pending(r) ? <AlertTriangle size={14} className="text-amber-600" /> : <CheckCircle2 size={14} className={r.corrected?.length ? 'text-sky-600' : v && canValidate ? 'text-violet-600' : 'text-emerald-600'} />}</td>
                <td className={`${td} text-gray-600`}>{r.source} → {r.target}</td>
                <td className={`${td} font-mono font-semibold`}>{open[k] ? '▾ ' : '▸ '}{r.invoiceNo}</td>
                <td className={`${td} font-mono`}>{date(r.invoiceDate)}</td>
                <td className={`${td} text-right font-mono`}>{money(r.amount, r.currency)}</td>
                <td className={`${td} font-mono`}>{r.purchase?.no || '–'}</td>
                <td className={`${td} font-mono`}>{r.purchase?.vendorInvoiceNo || '–'}</td>
                <td className={`${td} font-mono`}>{r.purchase ? date(r.purchase.invoiceDate) : '–'}</td>
                <td className={`${td} text-right font-mono`}>{r.purchase ? money(r.purchase.amount, r.purchase.currency) : '–'}</td>
                <td className={td}>{r.final ? (r.final.found ? <span className="font-mono">{r.final.no} <span className="text-gray-500 font-sans">{r.final.customer}</span></span> : <span className="text-gray-400">{r.externalDocNo || '–'}</span>) : <span className="text-gray-300">n/a</span>}</td>
                <td className="py-1.5 px-2 text-[11px] min-w-[240px]">
                  {r.corrected?.length ? <span className="block mb-0.5 text-sky-800 font-semibold">Corregida: <span className="font-normal">{r.corrected.join(' · ')}</span></span> : null}
                  {canValidate && (
                    <label onClick={e => e.stopPropagation()} className={`flex items-center gap-1.5 mb-0.5 font-semibold cursor-pointer ${v ? 'text-violet-800' : 'text-gray-600'}`}>
                      <input type="checkbox" checked={!!v} disabled={saving === k} onChange={e => setValid(r, e.target.checked)} />
                      {v ? <span>Validada{v.by ? ` por ${v.by}` : ''} el {date(v.at.substring(0, 10))}</span> : <span>Validar incidencias</span>}
                    </label>
                  )}
                  <span className={r.corrected?.length || v ? 'text-gray-500' : 'text-[#C0392B]'}>{r.issues.join(' · ') || <span className="text-emerald-700">Correcta</span>}</span>
                </td>
              </tr>
              {open[k] && <tr><td /><td colSpan={10} className="py-2 pr-2"><LinesTable r={r} /></td></tr>}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );

  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) for (const k of groupKeys(r)) m.set(k, [...(m.get(k) || []), r]);
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, grouping, validated]);

  const total = d?.rows.length || 0, bad = d?.rows.filter(pending).length || 0, fixed = d?.rows.filter(r => r.corrected?.length).length || 0, valid = d?.rows.filter(r => r.issues.length && !r.corrected?.length && isValidated(r)).length || 0;
  return (
    <Section title="Intercompany" source="Facturas de venta registradas a empresas del grupo (API v2 salesInvoices + líneas) frente a la factura de compra en la otra empresa (purchaseInvoices + líneas) y, en drop shipment de CRAZE GmbH a UK / Group AG, la venta final al cliente">
      <div className="flex flex-wrap items-end gap-4">
        <CompanySelect value={company} onChange={setCompany} />
        {([['Desde', from, setFrom], ['Hasta', to, setTo]] as const).map(([label, value, set]) => (
          <label key={label} className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {label}
            <input type="date" value={value} onChange={e => set(e.target.value)}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal" />
          </label>
        ))}
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Agrupar por
          <select value={grouping} onChange={e => setGrouping(e.target.value as Grouping)}
            className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal">
            {GROUPINGS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 flex-1 min-w-[200px]">
          Buscar
          <span className="mt-1 flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-1.5 bg-white">
            <Search size={14} className="text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Nº de factura, External Doc. No., cliente…" className="w-full text-sm outline-none normal-case tracking-normal font-normal" />
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 pb-2">
          <input type="checkbox" checked={onlyIssues} onChange={e => setOnlyIssues(e.target.checked)} /> Solo con incidencias
        </label>
        <button onClick={exportExcel} disabled={state.loading || !d}
          className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
          <FileDown size={16} /> Exportar Excel
        </button>
        <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={state.loading} title="Volver a leer de BC"
          className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
          <RefreshCw size={16} className={state.loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {from > to ? <ErrorBox message="La fecha Desde es posterior a Hasta." />
        : state.error ? <ErrorBox message={state.error} />
        : state.loading || !d ? <Loading text="Leyendo facturas de venta y compra de las empresas del grupo en Business Central…" />
        : (
          <>
            {d.warnings.map(w => <p key={w} className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{w}</p>)}
            <Grid cols={4}>
              <Kpi label="Facturas intercompañía" value={num(total)} sub="Ventas a empresas del grupo en el periodo" />
              <Kpi label="Correctas" value={num(total - bad)} sub={total ? `${num(((total - bad) / total) * 100, 1)} %${fixed ? ` · ${num(fixed)} corregidas con abonos / facturas nuevas` : ''}${valid ? ` · ${num(valid)} validadas a mano` : ''}` : ''} />
              <Kpi highlight tone="main" label="Con incidencias" value={num(bad)} sub="Sin compra, importe, divisa, fecha o artículos distintos, o sin venta final" />
              <Kpi label="Compras sin factura de venta" value={num(d.orphanPurchases.length)} sub="Compras a una empresa del grupo cuyo Vendor Invoice No. no es una venta suya del periodo" />
            </Grid>
            <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto">
              {grouping === 'none' ? <RowsTable list={rows} /> : (
                <div className="p-2 space-y-1">
                  {groups.map(([k, list]) => (
                    <div key={k} className="border border-gray-200 rounded-lg">
                      <button onClick={() => toggle(`g:${k}`)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm bg-gray-50 hover:bg-gray-100">
                        {open[`g:${k}`] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="font-semibold text-gray-900">{groupLabel(k)}</span>
                        <span className="ml-auto text-xs text-gray-500">{list.length} facturas · {list.filter(pending).length} con incidencias{list.some(r => r.corrected?.length) ? ` · ${list.filter(r => r.corrected?.length).length} corregidas` : ''}{list.some(r => r.issues.length && !r.corrected?.length && isValidated(r)) ? ` · ${list.filter(r => r.issues.length && !r.corrected?.length && isValidated(r)).length} validadas` : ''}</span>
                      </button>
                      {open[`g:${k}`] && <div className="overflow-x-auto"><RowsTable list={list} /></div>}
                    </div>
                  ))}
                </div>
              )}
              {!rows.length && <p className="text-sm text-gray-500 p-4">Sin facturas intercompañía con estos filtros.</p>}
            </div>
            {d.orphanPurchases.length > 0 && (
              <div className="rpt-card bg-white rounded-xl border border-gray-200 table-scroll">
                <p className="px-4 pt-3 font-bold text-gray-900">Compras a empresas del grupo sin factura de venta en el periodo</p>
                <table className="w-full text-[12px] mt-2">
                  <thead><tr className="border-b border-gray-200 bg-gray-50">
                    <th className={th}>Empresa (compra)</th><th className={th}>Proveedor</th><th className={th}>Factura compra</th><th className={th}>Vendor Invoice No.</th><th className={th}>Fecha</th><th className={`${th} text-right`}>Importe</th>
                  </tr></thead>
                  <tbody>
                    {d.orphanPurchases.map(o => (
                      <tr key={`${o.target}|${o.no}`} className="border-b border-gray-100">
                        <td className={td}>{o.target}</td><td className={td}>{o.vendor}</td><td className={`${td} font-mono`}>{o.no}</td>
                        <td className={`${td} font-mono`}>{o.vendorInvoiceNo || '–'}</td><td className={`${td} font-mono`}>{date(o.invoiceDate)}</td>
                        <td className={`${td} text-right font-mono`}>{money(o.amount, o.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-4 py-2 text-xs text-gray-500">Pueden ser facturas de venta de otro periodo, abonos o un Vendor Invoice No. que no coincide con el nº de la venta.</p>
              </div>
            )}
            {(d.excludedCredited || []).length > 0 && (
              <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                <span className="font-semibold">Excluidas (factura a importe 0 abonada): </span>
                {(d.excludedCredited || []).map((x, i) => <span key={`${x.source}|${x.invoiceNo}`}>{i ? ' · ' : ''}{x.invoiceNo} ↔ abono {x.creditMemoNo} ({x.target}, ext. {x.externalDocNo || '–'})</span>)}
              </p>
            )}
            <p className="text-xs text-gray-500">
              Se emparejan por nº: la factura de compra debe llevar como Vendor Invoice No. el nº de la factura de venta (un punto final de más se da por bueno). En las compras de Craze Entertainment, el foilbag de GmbH registrado como AA-00049 se da por bueno. Divisa en blanco = divisa local de cada empresa (CRAZE, Iberia y Entertainment EUR, UK GBP, Group AG CHF).
              Fecha = fecha de factura (Document Date) de las dos. Artículos y cantidades por nº de artículo. Drop shipment (CRAZE → UK / Group AG): la venta final se busca por nº o por External Document No.; haz clic en una factura para ver la comparación de líneas. Los abonos todavía no se comparan; las facturas a importe 0 abonadas (abono con el mismo nº de factura o el mismo External Document No.) se excluyen junto con su abono.
            </p>
          </>
        )}
    </Section>
  );
}
