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
type Cmp = { no: string; description: string; a: number; b: number };
type Row = {
  source: string; target: string; invoiceNo: string; postingDate: string; invoiceDate: string; customer: string; currency: string; amount: number; externalDocNo: string;
  purchase: null | { no: string; vendorInvoiceNo: string; postingDate: string; invoiceDate: string; vendor: string; currency: string; amount: number };
  lines: Cmp[];
  final: null | { no: string; customer: string; postingDate: string; currency: string; amount: number; found: boolean; lines: Cmp[] };
  issues: string[];
};
type Orphan = { target: string; no: string; vendorInvoiceNo: string; postingDate: string; invoiceDate: string; vendor: string; currency: string; amount: number; source?: string };
type Data = { rows: Row[]; orphanPurchases: Orphan[]; warnings: string[] };

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

  useEffect(() => {
    if (!from || !to || from > to) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    const one = async (co: string): Promise<Data> => {
      const res = await fetch(`/api/controlling/intercompany?company=${encodeURIComponent(co)}&from=${from}&to=${to}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok || data.error) throw new Error(`${co}: ${data.error || `HTTP ${res.status}`}`);
      return { ...data, orphanPurchases: data.orphanPurchases.map((o: Orphan) => ({ ...o, source: co })) };
    };
    // Consolidado: las facturas emitidas por todas las empresas
    const load = company === CONSOLIDATED
      ? Promise.allSettled(REPORT_COMPANIES.map(one)).then(settled => {
        const parts = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
        const failed = settled.flatMap(r => (r.status === 'rejected' ? [`No incluida: ${r.reason?.message || r.reason}`] : []));
        if (!parts.length) throw new Error(failed.join(' · '));
        return { rows: parts.flatMap(p => p.rows), orphanPurchases: parts.flatMap(p => p.orphanPurchases), warnings: [...failed, ...parts.flatMap(p => p.warnings)] };
      })
      : one(company);
    load.then(data => !cancelled && setState({ data, loading: false, error: null }))
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [company, from, to, reload]);

  const d = state.data;
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (d?.rows || []).filter(r => (!onlyIssues || r.issues.length)
      && (!q || [r.invoiceNo, r.externalDocNo, r.purchase?.no, r.purchase?.vendorInvoiceNo, r.final?.no, r.final?.customer, r.customer].some(v => v && v.toLowerCase().includes(q))))
      .sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.invoiceNo.localeCompare(b.invoiceNo));
  }, [d, onlyIssues, search]);
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const money = (v: number, cur: string) => `${num(v, 2)} ${cur}`;

  const groupKeys = (r: Row): string[] => grouping === 'month' ? [r.postingDate.substring(0, 7)]
    : grouping === 'pair' ? [`${r.source} → ${r.target}`]
    : grouping === 'issue' ? (r.issues.length ? Array.from(new Set(r.issues.map(issueType))) : ['Correcta']) : ['all'];
  const groupLabel = (k: string) => (grouping === 'month' ? `${MONTHS[Number(k.substring(5, 7)) - 1]} ${k.substring(0, 4)}` : k);

  const exportExcel = () => {
    const out = rows.map(r => ({
      'Empresa origen': r.source, 'Empresa destino': r.target, 'Factura venta': r.invoiceNo, 'Posting Date': r.postingDate, 'Fecha factura': r.invoiceDate,
      'Divisa': r.currency, 'Importe sin IVA': r.amount, 'External Document No.': r.externalDocNo,
      'Factura compra': r.purchase?.no || '', 'Vendor Invoice No.': r.purchase?.vendorInvoiceNo || '', 'Fecha compra': r.purchase?.invoiceDate || '',
      'Divisa compra': r.purchase?.currency || '', 'Importe compra': r.purchase?.amount ?? '',
      'Venta final': r.final?.found ? r.final.no : '', 'Cliente final': r.final?.customer || '', 'Incidencias': r.issues.join(' · ') || 'Correcta',
    }));
    const orphans = (d?.orphanPurchases || []).map(o => ({ 'Empresa (compra)': o.target, 'Proveedor': o.vendor, 'Factura compra': o.no, 'Vendor Invoice No.': o.vendorInvoiceNo, 'Fecha': o.invoiceDate, 'Divisa': o.currency, 'Importe': o.amount }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), 'Facturas intercompañía');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orphans), 'Compras sin venta');
    XLSX.writeFile(wb, `Intercompany_${company}_${from}_${to}.xlsx`.replace(/\s+/g, '_'));
  };

  const LinesTable = ({ r }: { r: Row }) => {
    const items = Array.from(new Set([...r.lines.map(l => l.no), ...(r.final?.lines || []).map(l => l.no)])).sort();
    return (
      <table className="w-full text-[12px] bg-white border border-gray-200 rounded-lg">
        <thead><tr className="border-b border-gray-200 bg-gray-50">
          <th className={th}>Artículo</th><th className={th}>Descripción</th>
          <th className={`${th} text-right`}>Venta {r.source}</th><th className={`${th} text-right`}>Compra {r.target}</th>
          {r.final && <th className={`${th} text-right`}>Venta final {r.target}</th>}
        </tr></thead>
        <tbody>
          {items.map(no => {
            const l = r.lines.find(x => x.no === no), f = r.final?.lines.find(x => x.no === no);
            const sale = l?.a ?? f?.a ?? 0, purch = l?.b ?? 0, fin = f?.b ?? 0;
            const bad = Math.abs(sale - purch) > 0.0001 || (r.final && r.final.found && Math.abs(sale - fin) > 0.0001);
            return (
              <tr key={no} className={`border-b border-gray-100 ${bad ? 'bg-red-50' : ''}`}>
                <td className={`${td} font-mono font-semibold`}>{no}</td><td className={td}>{l?.description || f?.description}</td>
                <td className={`${td} text-right font-mono`}>{num(sale)}</td>
                <td className={`${td} text-right font-mono ${Math.abs(sale - purch) > 0.0001 ? 'text-[#C0392B] font-semibold' : ''}`}>{r.purchase ? num(purch) : '–'}</td>
                {r.final && <td className={`${td} text-right font-mono ${r.final.found && Math.abs(sale - fin) > 0.0001 ? 'text-[#C0392B] font-semibold' : ''}`}>{r.final.found ? num(fin) : '–'}</td>}
              </tr>
            );
          })}
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
          const k = `${r.source}|${r.invoiceNo}`;
          return (
            <Fragment key={k}>
              <tr className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${r.issues.length ? '' : ''}`} onClick={() => toggle(k)}>
                <td className={td}>{r.issues.length ? <AlertTriangle size={14} className="text-amber-600" /> : <CheckCircle2 size={14} className="text-emerald-600" />}</td>
                <td className={`${td} text-gray-600`}>{r.source} → {r.target}</td>
                <td className={`${td} font-mono font-semibold`}>{open[k] ? '▾ ' : '▸ '}{r.invoiceNo}</td>
                <td className={`${td} font-mono`}>{date(r.invoiceDate)}</td>
                <td className={`${td} text-right font-mono`}>{money(r.amount, r.currency)}</td>
                <td className={`${td} font-mono`}>{r.purchase?.no || '–'}</td>
                <td className={`${td} font-mono`}>{r.purchase?.vendorInvoiceNo || '–'}</td>
                <td className={`${td} font-mono`}>{r.purchase ? date(r.purchase.invoiceDate) : '–'}</td>
                <td className={`${td} text-right font-mono`}>{r.purchase ? money(r.purchase.amount, r.purchase.currency) : '–'}</td>
                <td className={td}>{r.final ? (r.final.found ? <span className="font-mono">{r.final.no} <span className="text-gray-500 font-sans">{r.final.customer}</span></span> : <span className="text-gray-400">{r.externalDocNo || '–'}</span>) : <span className="text-gray-300">n/a</span>}</td>
                <td className="py-1.5 px-2 text-[11px] text-[#C0392B] min-w-[240px]">{r.issues.join(' · ') || <span className="text-emerald-700">Correcta</span>}</td>
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
  }, [rows, grouping]);

  const total = d?.rows.length || 0, bad = d?.rows.filter(r => r.issues.length).length || 0;
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
              <Kpi label="Correctas" value={num(total - bad)} sub={total ? `${num(((total - bad) / total) * 100, 1)} %` : ''} />
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
                        <span className="ml-auto text-xs text-gray-500">{list.length} facturas · {list.filter(r => r.issues.length).length} con incidencias</span>
                      </button>
                      {open[`g:${k}`] && <div className="overflow-x-auto"><RowsTable list={list} /></div>}
                    </div>
                  ))}
                </div>
              )}
              {!rows.length && <p className="text-sm text-gray-500 p-4">Sin facturas intercompañía con estos filtros.</p>}
            </div>
            {d.orphanPurchases.length > 0 && (
              <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto">
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
            <p className="text-xs text-gray-500">
              Se emparejan por nº: la factura de compra debe llevar como Vendor Invoice No. el nº de la factura de venta (se ignoran espacios y un punto final, pero se marca). Divisa en blanco = divisa local de cada empresa (CRAZE, Iberia y Entertainment EUR, UK GBP, Group AG CHF).
              Fecha = fecha de factura (Document Date) de las dos. Artículos y cantidades por nº de artículo. Drop shipment (CRAZE → UK / Group AG): la venta final se busca por nº o por External Document No.; haz clic en una factura para ver la comparación de líneas. Los abonos todavía no se comparan.
            </p>
          </>
        )}
    </Section>
  );
}
