'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileDown, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';

// Desglose de una cuenta del BWA (Power BI): tipo de movimiento (compras / ventas / asientos) → agrupación elegida
// (mes, proveedor o cliente, origen) → documentos → movimientos contables y líneas del documento (artículo).
type Entry = {
  company: string; entryNo: number; date: string; account: string; documentType: string; documentNo: string;
  sourceCode: string; sourceType: string; sourceNo: string; sourceName: string; description: string;
  externalDocNo: string; balAccount: string; amount: number; elimination: boolean;
};
type Line = { lineNo: number; type: string; no: string; description: string; quantity: number; unitCost: number; amount: number; genProdPostingGroup: string; deferralCode: string };
type Doc = {
  key: string; company: string; documentNo: string; documentType: string; date: string; partner: string; partnerNo: string;
  externalDocNo: string; description: string; sourceCode: string; amount: number; entries: Entry[]; category: Category;
};
type Category = 'purchase' | 'sales' | 'journal';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'purchase', label: 'Facturas y abonos de compra' },
  { id: 'sales', label: 'Facturas y abonos de venta' },
  { id: 'journal', label: 'Asientos y otros movimientos' },
];
const GROUPINGS = [
  { id: 'month', label: 'Mes' },
  { id: 'partner', label: 'Proveedor / cliente' },
  { id: 'source', label: 'Origen (Source Code)' },
  { id: 'none', label: 'Sin agrupar' },
] as const;
type Grouping = typeof GROUPINGS[number]['id'];
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const isDocType = (t: string) => /^(Invoice|Credit Memo)$/i.test(t);
function categoryOf(e: Entry): Category {
  if (isDocType(e.documentType) && e.sourceType === 'Vendor') return 'purchase';
  if (isDocType(e.documentType) && e.sourceType === 'Customer') return 'sales';
  return 'journal';
}
const lineKind = (d: Doc) => d.category === 'purchase'
  ? (/credit/i.test(d.documentType) ? 'purchCrMemo' : 'purchInv')
  : d.category === 'sales' ? (/credit/i.test(d.documentType) ? 'salesCrMemo' : 'salesInv') : null;

type SortKey = 'company' | 'documentNo' | 'documentType' | 'date' | 'partner' | 'externalDocNo' | 'description' | 'sourceCode' | 'amount';
const th = 'py-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap text-left';
const td = 'py-1.5 px-2 whitespace-nowrap';

export type DrillSpec = { account: string; accountName: string; scope: string; from: string; to: string; label: string };

export default function BwaAccountDrill({ fmt, spec, onClose }: { fmt: Fmt; spec: DrillSpec; onClose: () => void }) {
  const { num, date } = fmt;
  const [state, setState] = useState<{ entries: Entry[]; warnings: string[]; cancelled?: number; loading: boolean; error: string | null }>({ entries: [], warnings: [], loading: true, error: null });
  const [grouping, setGrouping] = useState<Grouping>('month');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [lines, setLines] = useState<Record<string, { loading: boolean; error?: string; lines?: Line[] }>>({});
  // Orden de la tabla de documentos (clic en la cabecera); por defecto, importe de mayor a menor en valor absoluto
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ entries: [], warnings: [], loading: true, error: null });
    setOpen({});
    const p = new URLSearchParams({ account: spec.account, scope: spec.scope, from: spec.from, to: spec.to });
    fetch(`/api/controlling/bwa-pbi/detail?${p}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (cancelled) return;
        setState(res.ok && !data.error ? { entries: data.entries, warnings: data.warnings || [], cancelled: data.cancelledPairs || 0, loading: false, error: null } : { entries: [], warnings: [], loading: false, error: data.error || `HTTP ${res.status}` });
      })
      .catch(err => !cancelled && setState({ entries: [], warnings: [], loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [spec.account, spec.scope, spec.from, spec.to]);

  // Documentos: movimientos agrupados por sociedad + nº de documento + mes de registro (un asiento registrado en
  // varios meses, p. ej. un diario con una línea por mes, sale en cada mes con sus movimientos de ese mes)
  const docs = useMemo(() => {
    const map = new Map<string, Doc>();
    for (const e of state.entries) {
      const key = `${e.company}|${e.documentNo || `#${e.entryNo}`}|${e.date.substring(0, 7)}`;
      const d = map.get(key) || {
        key, company: e.company, documentNo: e.documentNo, documentType: e.documentType, date: e.date,
        partner: e.sourceName || e.sourceNo, partnerNo: e.sourceNo, externalDocNo: e.externalDocNo, description: e.description,
        sourceCode: e.sourceCode, amount: 0, entries: [], category: categoryOf(e),
      };
      d.amount += e.amount;
      d.entries.push(e);
      map.set(key, d);
    }
    return Array.from(map.values()).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }, [state.entries]);

  const multiCompany = new Set(docs.map(d => d.company)).size > 1;
  const total = docs.reduce((s, d) => s + d.amount, 0);
  const groupKey = (d: Doc) => grouping === 'month' ? d.date.substring(0, 7)
    : grouping === 'partner' ? (d.partner ? `${d.partnerNo}|${d.partner}` : '|(sin proveedor/cliente)')
    : grouping === 'source' ? (d.sourceCode || '(sin origen)') : 'all';
  const groupLabel = (k: string) => grouping === 'month' ? `${MONTHS[Number(k.substring(5, 7)) - 1]} ${k.substring(0, 4)}`
    : grouping === 'partner' ? k.split('|').slice(1).join('|') + (k.split('|')[0] ? ` · ${k.split('|')[0]}` : '') : k;

  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const loadLines = (d: Doc) => {
    const kind = lineKind(d);
    if (!kind || lines[d.key]) return;
    setLines(l => ({ ...l, [d.key]: { loading: true } }));
    fetch(`/api/controlling/bwa-pbi/lines?${new URLSearchParams({ company: d.company, doc: d.documentNo, kind })}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setLines(l => ({ ...l, [d.key]: res.ok && !data.error ? { loading: false, lines: data.lines } : { loading: false, error: data.error || `HTTP ${res.status}` } }));
      })
      .catch(err => setLines(l => ({ ...l, [d.key]: { loading: false, error: err.message } })));
  };

  const exportExcel = () => {
    const rows = state.entries.map(e => ({
      Sociedad: e.company, Fecha: e.date, Tipo: CATEGORIES.find(c => c.id === categoryOf(e))!.label, 'Document Type': e.documentType,
      'Document No.': e.documentNo, 'Cuenta': e.account, 'Cuenta BWA': spec.account, Origen: e.sourceCode, 'Source No.': e.sourceNo,
      'Proveedor / cliente': e.sourceName, 'Nº doc. externo': e.externalDocNo, Descripción: e.description, Contrapartida: e.balAccount,
      'Importe (EUR, signo BWA)': e.amount, Eliminación: e.elimination ? 'Sí' : 'No', 'Entry No.': e.entryNo,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Movimientos');
    XLSX.writeFile(wb, `BWA_${spec.account}_${spec.scope}_${spec.from}_${spec.to}.xlsx`.replace(/\s+/g, '_'));
  };

  const sorted = (list: Doc[]) => {
    if (!sort) return list;
    const { key, dir } = sort;
    return [...list].sort((x, y) => (key === 'amount' ? x.amount - y.amount : String(x[key] || '').localeCompare(String(y[key] || ''), 'es', { numeric: true })) * dir);
  };
  const clickSort = (key: SortKey) => setSort(cur => (cur?.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: key === 'amount' || key === 'date' ? -1 : 1 }));
  const Th = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => (
    <th className={`${th} ${right ? 'text-right' : ''} cursor-pointer select-none hover:text-gray-900`} onClick={() => clickSort(k)} title="Ordenar">
      <span className={`inline-flex items-center gap-0.5 ${right ? 'justify-end' : ''}`}>
        {label}{sort?.key === k && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </span>
    </th>
  );

  const DocTable = ({ list: unsorted }: { list: Doc[] }) => {
    const list = sorted(unsorted);
    return (
    <table className="w-full text-[12px] bg-white border border-gray-200 rounded-lg">
      <thead><tr className="border-b border-gray-200">
        <th className={th} />
        {multiCompany && <Th k="company" label="Sociedad" />}
        <Th k="documentNo" label="Document No." /><Th k="documentType" label="Tipo" /><Th k="date" label="Fecha" /><Th k="partner" label="Proveedor / cliente" />
        <Th k="externalDocNo" label="Nº doc. externo" /><Th k="description" label="Descripción" /><Th k="sourceCode" label="Origen" /><Th k="amount" label="Importe" right />
      </tr></thead>
      <tbody>
        {list.map(d => (
          <Fragment key={d.key}>
            <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => { toggle(`doc:${d.key}`); loadLines(d); }}>
              <td className={`${td} w-6`}>{open[`doc:${d.key}`] ? <ChevronDown size={13} className="text-gray-400" /> : <ChevronRight size={13} className="text-gray-400" />}</td>
              {multiCompany && <td className={`${td} text-gray-600`}>{d.company}</td>}
              <td className={`${td} font-semibold text-gray-900`}>{d.documentNo || '—'}</td>
              <td className={`${td} text-gray-600`}>{d.documentType || '—'}</td>
              <td className={`${td} text-gray-600`}>{date(d.date)}</td>
              <td className={`${td} text-gray-900`}>{d.partner}{d.partner && d.partnerNo && d.partner !== d.partnerNo && <span className="text-gray-400"> {d.partnerNo}</span>}</td>
              <td className={`${td} text-gray-600`}>{d.externalDocNo}</td>
              <td className={`${td} text-gray-600 max-w-[280px] truncate`} title={d.description}>{d.description}</td>
              <td className={`${td} text-gray-500`}>{d.sourceCode}</td>
              <td className={`${td} text-right tabular-nums font-semibold`}>{num(d.amount, 2)}</td>
            </tr>
            {open[`doc:${d.key}`] && (
              <tr><td colSpan={multiCompany ? 10 : 9} className="bg-gray-50 px-6 py-3 space-y-3">
                {lineKind(d) && (
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1">Líneas del documento</p>
                    {lines[d.key]?.loading ? <p className="text-xs text-gray-500">Leyendo líneas de BC…</p>
                      : lines[d.key]?.error ? <p className="text-xs text-red-700">{lines[d.key]?.error}</p>
                      : (
                        <table className="w-full text-[12px]">
                          <thead><tr className="border-b border-gray-200">
                            <th className={th}>Tipo</th><th className={th}>Nº (artículo / cuenta)</th><th className={th}>Descripción</th>
                            <th className={th}>Gen. Prod. Posting Group</th><th className={th}>Deferral</th>
                            <th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Coste / precio unit.</th><th className={`${th} text-right`}>Importe sin IVA</th>
                          </tr></thead>
                          <tbody>
                            {(lines[d.key]?.lines || []).map(l => (
                              <tr key={l.lineNo} className="border-b border-gray-100">
                                <td className={`${td} text-gray-600`}>{l.type}</td>
                                <td className={`${td} font-semibold ${/item/i.test(l.type) ? 'text-[#C8186C]' : 'text-gray-900'}`}>{l.no}</td>
                                <td className={`${td} text-gray-700`}>{l.description}</td>
                                <td className={`${td} text-gray-500`}>{l.genProdPostingGroup}</td>
                                <td className={`${td} text-gray-500`}>{l.deferralCode}</td>
                                <td className={`${td} text-right tabular-nums`}>{num(l.quantity, 2)}</td>
                                <td className={`${td} text-right tabular-nums`}>{num(l.unitCost, 2)}</td>
                                <td className={`${td} text-right tabular-nums`}>{num(l.amount, 2)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    <p className="text-[11px] text-gray-400 mt-1">Importes de las líneas en la divisa del documento y con su signo; el importe del BWA está en EUR con el signo invertido.</p>
                  </div>
                )}
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1">Movimientos en la cuenta</p>
                  <table className="w-full text-[12px]">
                    <thead><tr className="border-b border-gray-200">
                      <th className={th}>Fecha</th><th className={th}>Cuenta</th><th className={th}>Origen</th><th className={th}>Descripción</th>
                      <th className={th}>Contrapartida</th><th className={th}>Entry No.</th><th className={`${th} text-right`}>Importe</th>
                    </tr></thead>
                    <tbody>
                      {d.entries.map(e => (
                        <tr key={`${e.company}-${e.entryNo}`} className="border-b border-gray-100">
                          <td className={td}>{date(e.date)}</td><td className={td}>{e.account}</td><td className={td}>{e.sourceCode}</td>
                          <td className={td}>{e.description}</td><td className={td}>{e.balAccount || '–'}</td>
                          <td className={`${td} text-gray-400`}>{e.entryNo}{e.elimination ? ' · eliminación' : ''}</td>
                          <td className={`${td} text-right tabular-nums`}>{num(e.amount, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </td></tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
    );
  };

  return (
    <div className="bg-[#F8F9FB] border-l-4 border-[#C8186C] p-4 space-y-3 whitespace-normal">
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-bold text-gray-900">{spec.account} {spec.accountName}</p>
        <p className="text-xs text-gray-500">{spec.scope} · {spec.label} ({date(spec.from)} – {date(spec.to)})</p>
        {!state.loading && !state.error && <p className="text-sm font-bold tabular-nums">{num(total, 2)} €</p>}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Agrupar por</span>
          <select value={grouping} onChange={e => setGrouping(e.target.value as Grouping)} className="border border-gray-300 rounded-lg px-2 py-1 text-sm font-semibold bg-white">
            {GROUPINGS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
          <button onClick={exportExcel} disabled={state.loading || !state.entries.length} title="Exportar movimientos a Excel"
            className="p-1.5 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40"><FileDown size={15} /></button>
          <button onClick={onClose} title="Cerrar desglose" className="p-1.5 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900"><X size={15} /></button>
        </div>
      </div>
      {!!state.cancelled && <p className="text-xs text-gray-500">{state.cancelled} {state.cancelled === 1 ? 'factura anulada por su abono no se muestra' : 'facturas anuladas por su abono no se muestran'} (cada pareja suma 0; el total no cambia).</p>}
      {state.warnings.map(w => <p key={w} className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">{w}</p>)}
      {state.error ? <p className="text-sm text-red-700">{state.error}</p>
        : state.loading ? <p className="text-sm text-gray-500">Leyendo los movimientos de {spec.account} en Business Central…</p>
        : !docs.length ? <p className="text-sm text-gray-500">Sin movimientos en este periodo.</p>
        : CATEGORIES.map(cat => {
          const list = docs.filter(d => d.category === cat.id);
          if (!list.length) return null;
          const catKey = `cat:${cat.id}`;
          const groups = new Map<string, Doc[]>();
          for (const d of list) groups.set(groupKey(d), [...(groups.get(groupKey(d)) || []), d]);
          const sortedGroups = Array.from(groups.entries()).sort((a, b) => grouping === 'month' ? a[0].localeCompare(b[0])
            : Math.abs(b[1].reduce((s, d) => s + d.amount, 0)) - Math.abs(a[1].reduce((s, d) => s + d.amount, 0)));
          return (
            <div key={cat.id} className="bg-white border border-gray-200 rounded-lg">
              <button onClick={() => toggle(catKey)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
                {open[catKey] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="font-semibold text-gray-900">{cat.label}</span>
                <span className="ml-auto text-xs text-gray-500">{list.length} documentos</span>
                <span className="w-36 text-right font-bold tabular-nums">{num(list.reduce((s, d) => s + d.amount, 0), 2)}</span>
              </button>
              {open[catKey] && (
                <div className="px-3 pb-3 space-y-2">
                  {grouping === 'none' ? <DocTable list={list} /> : sortedGroups.map(([k, g]) => {
                    const gKey = `${catKey}:${k}`;
                    return (
                      <div key={k} className="border border-gray-100 rounded-lg">
                        <button onClick={() => toggle(gKey)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm">
                          {open[gKey] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          <span className="text-gray-800">{groupLabel(k)}</span>
                          <span className="ml-auto text-xs text-gray-500">{g.length} doc.</span>
                          <span className="w-36 text-right font-semibold tabular-nums">{num(g.reduce((s, d) => s + d.amount, 0), 2)}</span>
                        </button>
                        {open[gKey] && <div className="px-2 pb-2"><DocTable list={g} /></div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
