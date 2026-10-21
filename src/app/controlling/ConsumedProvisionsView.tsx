'use client';

import { Fragment, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileDown, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { Card, ErrorBox, Grid, Kpi, Loading, Section, Table } from '../reporting/ui';

// Controlling · Consumed Provisions: provisión generada en la LM frente a lo consumido por facturas/abonos de compra
// en las cuentas PROV-*.
type Movement = { date: string; account: string; amount: number; source: string; description: string; balAccount: string };
type Doc = { documentNo: string; type: string; vendorNo: string; vendorName: string; externalDocNo: string; firstDate: string; initialAccounts: string[]; reclassified: boolean; movements: Movement[]; amount: number };
type Concept = { key: string; label: string; account: string; provision: number; lm: number; consumed: number | null; pending: number | null; docs: Doc[] };
type GroupDoc = { concept: string; documentNo: string; type: string; date: string; vendorNo: string; vendorName: string; externalDocNo: string; amount: number };
type LmGroup = {
  code: string; name: string; conditions: number; markant: number; kam: number; royalties: number; marketing: number; amazon: number; total: number;
  consumed: Record<string, number>; consumedTotal: number; cancelledPairs: number; docs: GroupDoc[];
};
type Data = { concepts: Concept[]; byMonth: any[]; lmByGroup: LmGroup[]; lmLines: number; excludedJournal: number; glEntries: number };

const iso = (d: Date) => d.toISOString().substring(0, 10);
const LM_COLS: ['conditions' | 'markant' | 'kam' | 'royalties' | 'marketing' | 'amazon', string][] = [
  ['conditions', 'Conditions (sin Markant)'], ['markant', 'Markant (Accounting Partner)'], ['kam', 'KAM'], ['royalties', 'Royalties'], ['marketing', 'Marketing (sin Amazon)'], ['amazon', 'Amazon Promotion'],
];
// Pendiente (provisionado − consumido), en rojo si se ha consumido más de lo provisionado
const Pending = ({ v }: { v: number }) => (
  <span className={v < -0.5 ? 'text-[#C0392B]' : ''}>{Math.round(v).toLocaleString('es-ES')}</span>
);

// Columnas ordenables de los documentos de una provisión
type SortKey = 'documentNo' | 'type' | 'firstDate' | 'vendor' | 'externalDocNo' | 'initialAccounts' | 'reclassified' | 'amount';
const DOC_COLS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: 'documentNo', label: 'Document No.' }, { key: 'type', label: 'Tipo' }, { key: 'firstDate', label: 'Fecha' },
  { key: 'vendor', label: 'Proveedor' }, { key: 'externalDocNo', label: 'Nº doc. proveedor' }, { key: 'initialAccounts', label: 'Registrado en' },
  { key: 'reclassified', label: 'Reclasificado' }, { key: 'amount', label: 'Importe', right: true },
];
const sortValue = (d: Doc, k: SortKey): string | number =>
  k === 'amount' ? d.amount : k === 'vendor' ? (d.vendorName || d.vendorNo).toLowerCase()
  : k === 'initialAccounts' ? d.initialAccounts.join(', ') : k === 'reclassified' ? Number(d.reclassified) : String(d[k] || '').toLowerCase();
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 font-mono whitespace-nowrap';
const td = 'py-1.5 px-2 whitespace-nowrap';

export default function ConsumedProvisionsView({ fmt, company }: { fmt: Fmt; company: string }) {
  const { num, pct, date, monthName } = fmt;
  // Por defecto: del 1 de enero al último día del mes anterior (en enero, el año anterior completo)
  const [to, setTo] = useState(() => { const d = new Date(); return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0))); });
  const [from, setFrom] = useState(() => `${to.substring(0, 4)}-01-01`);
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sort, setSort] = useState<Record<string, { key: SortKey; dir: 1 | -1 }>>({});
  const sortBy = (gk: string, key: SortKey) => setSort(s => {
    const cur = s[gk];
    return { ...s, [gk]: { key, dir: cur?.key === key ? (cur.dir === 1 ? -1 : 1) : key === 'amount' ? -1 : 1 } };
  });
  const sorted = (gk: string, docs: Doc[]) => {
    const st = sort[gk];
    if (!st) return docs;
    return [...docs].sort((a, b) => {
      const va = sortValue(a, st.key), vb = sortValue(b, st.key);
      return (va < vb ? -1 : va > vb ? 1 : 0) * st.dir;
    });
  };
  // Excel: resumen, por mes, documentos (con su grupo) y movimientos
  const exportExcel = () => {
    if (!d) return;
    const group = (x: Doc) => (x.type === 'Invoice' ? 'Factura' : x.type === 'Credit Memo' ? 'Abono' : 'Asiento');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.concepts.map(c => ({
      Concepto: c.label, 'Cuenta consumo': c.account, 'Provisionado (G/L)': c.provision, 'Calculado LM': c.lm,
      Consumido: c.consumed, Pendiente: c.pending, '% consumido': c.consumed !== null && c.provision ? c.consumed / c.provision : null, Documentos: c.docs.length,
    }))), 'Resumen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.lmByGroup.map(g => ({
      'Customer Group': g.code, 'Customer Group Name': g.name,
      ...Object.fromEntries(LM_COLS.flatMap(([k, label]) => [[`${label} calc.`, g[k]], ...(k !== 'kam' ? [[`${label} cons.`, g.consumed[k] || 0]] : []), [`${label} pend.`, g[k] - (g.consumed[k] || 0)]])),
      'Total calc.': g.total, 'Total cons.': g.consumedTotal, Pendiente: g.total - g.consumedTotal,
    }))), 'LM por Customer Group');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.lmByGroup.flatMap(g => g.docs.map(x => ({
      'Customer Group': g.code, 'Customer Group Name': g.name, Concepto: LM_COLS.find(([k]) => k === x.concept)?.[1] || x.concept,
      'Document No.': x.documentNo, Tipo: x.type === 'Invoice' ? 'Factura' : x.type === 'Credit Memo' ? 'Abono' : x.type, Fecha: x.date, 'Vendor No.': x.vendorNo, Proveedor: x.vendorName,
      'Nº doc. proveedor': x.externalDocNo, Importe: x.amount,
    })))), 'Facturas por Customer Group');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.byMonth.map(m => Object.fromEntries([['Mes', m.month], ...d.concepts.flatMap(c => {
      const v = m[c.key];
      const name = c.label.replace('Provision ', '');
      return [[`${name} prov.`, v.provision], ...(c.account ? [[`${name} cons.`, v.consumed], [`${name} pend.`, v.provision - v.consumed]] : [])];
    })]))), 'Por mes');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.concepts.flatMap(c => c.docs.map(x => ({
      Concepto: c.label, Grupo: group(x), 'Document No.': x.documentNo, Tipo: x.type, Fecha: x.firstDate, 'Vendor No.': x.vendorNo, Proveedor: x.vendorName,
      'Nº doc. proveedor': x.externalDocNo, 'Registrado en': x.initialAccounts.join(', '), Reclasificado: x.reclassified ? 'Sí' : 'No', [`Importe`]: x.amount, 'Cuenta consumo': c.account,
    })))), 'Documentos');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.concepts.flatMap(c => c.docs.flatMap(x => x.movements.map(m => ({
      Concepto: c.label, 'Document No.': x.documentNo, Fecha: m.date, Cuenta: m.account, Origen: m.source, Descripción: m.description, Contrapartida: m.balAccount, Importe: m.amount,
    }))))), 'Movimientos');
    XLSX.writeFile(wb, `Consumed_Provisions_${company}_${from}_${to}.xlsx`.replace(/\s+/g, '_'));
  };

  const sum = (docs: Doc[]) => docs.reduce((t, x) => t + x.amount, 0);
  // Subniveles de una provisión: facturas y abonos de compra (con un nivel para cada uno) y asientos
  type Group = { id: string; label: string; docs: Doc[]; children?: Group[] };
  const groupsOf = (c: Concept): Group[] => {
    const inv = c.docs.filter(x => x.type === 'Invoice'), cm = c.docs.filter(x => x.type === 'Credit Memo');
    const other = c.docs.filter(x => x.type !== 'Invoice' && x.type !== 'Credit Memo');
    return [
      { id: 'purchase', label: 'Facturas y abonos de compra', docs: [...inv, ...cm], children: [
        { id: 'invoices', label: 'Facturas', docs: inv }, { id: 'creditMemos', label: 'Abonos', docs: cm },
      ] },
      { id: 'entries', label: 'Asientos (diario, traspasos y refacturación)', docs: other },
    ].filter(g => g.docs.length);
  };

  // Tabla de documentos (ordenable) de un grupo: gk = concepto|grupo
  const docsTable = (gk: string, docs: Doc[], account: string) => (
    <table className="w-full text-[12px] bg-white rounded-lg border border-gray-200">
      <thead>
        <tr className="border-b border-gray-200 text-left">
          <th className={th} />
          {DOC_COLS.map(col => (
            <th key={col.key} className={`${th} ${col.right ? 'text-right' : ''} cursor-pointer select-none hover:text-gray-900`} onClick={() => sortBy(gk, col.key)}>
              <span className={`inline-flex items-center gap-1 ${col.right ? 'flex-row-reverse' : ''}`}>
                {col.key === 'amount' ? `Importe en ${account}` : col.label}
                {sort[gk]?.key === col.key && (sort[gk].dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted(gk, docs).map(doc => {
          const k = `${gk}|${doc.documentNo}`;
          return (
            <Fragment key={k}>
              <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(k)}>
                <td className={td}>{open[k] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                <td className={`${td} font-mono`}>{doc.documentNo}</td>
                <td className={td}>{doc.type}</td>
                <td className={`${td} font-mono`}>{date(doc.firstDate)}</td>
                <td className="py-1.5 px-2 min-w-[180px]">{doc.vendorName || doc.vendorNo || '–'} <span className="text-gray-400 font-mono">{doc.vendorName ? doc.vendorNo : ''}</span></td>
                <td className={td}>{doc.externalDocNo || '–'}</td>
                <td className={`${td} font-mono`}>{doc.initialAccounts.join(', ') || '–'}</td>
                <td className={td}>{doc.reclassified ? <span className="text-[#C8186C] font-semibold">Sí</span> : 'No'}</td>
                <td className={`${td} text-right font-mono font-semibold`}>{num(doc.amount, 2)}</td>
              </tr>
              {open[k] && (
                <tr>
                  <td />
                  <td colSpan={8} className="py-2 pr-2">
                    <Table cols={[{ label: 'Fecha', mono: true }, { label: 'Cuenta', mono: true }, { label: 'Origen', mono: true }, { label: 'Descripción', wide: true }, { label: 'Contrapartida', mono: true }, { label: 'Importe', align: 'right', mono: true }]}
                      rows={doc.movements.map(m => [date(m.date), m.account, m.source, m.description, m.balAccount || '–', num(m.amount, 2)])} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );


  useEffect(() => {
    if (!from || !to || from > to) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetch(`/api/controlling/consumed-provisions?from=${from}&to=${to}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (cancelled) return;
        setState(res.ok && !data.error ? { data, loading: false, error: null } : { data: null, loading: false, error: data.error || `HTTP ${res.status}` });
      })
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [from, to, reload, company]);

  const d = state.data;
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const amt = (v: number | null) => (v === null ? '–' : num(v, 2));
  const totals = d ? {
    provision: d.concepts.reduce((s, c) => s + c.provision, 0),
    lm: d.concepts.reduce((s, c) => s + c.lm, 0),
    consumed: d.concepts.reduce((s, c) => s + (c.consumed || 0), 0),
  } : null;

  return (
    <Section title="Consumed Provisions" source="Provisionado: asientos PROV* en cuentas de resultados (4769 02, 6020 10, 6600 30, 6600 31, 6837 00) · Calculado LM: Documents LM Components (referencia) · Consumido: facturas y abonos de compra en PROV-KONDITIONS / PROV-MARKETING / PROV-ROYALTIES / PROV-AMZPROM (G/L Entries, por Document No.)">
      <div className="flex flex-wrap items-end gap-4">
        {([['Desde', from, setFrom], ['Hasta', to, setTo]] as const).map(([label, value, set]) => (
          <label key={label} className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {label}
            <input type="date" value={value} onChange={e => set(e.target.value)}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal" />
          </label>
        ))}
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
        : state.loading || !d || !totals ? <Loading text="Leyendo la LM y los movimientos contables de Business Central…" />
        : (
          <>
            <Grid cols={3}>
              <Kpi label="Provisionado (G/L)" value={num(totals.provision)} sub={`Calculado por la LM: ${num(totals.lm)}`} />
              <Kpi label="Consumido (facturas y abonos)" value={num(totals.consumed)} sub={totals.provision ? `${pct((totals.consumed / totals.provision) * 100)} de lo generado` : undefined} />
              <Kpi highlight tone="main" label="Pendiente" value={num(totals.provision - totals.consumed)} sub="Provisionado − consumido" />
            </Grid>

            <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left">
                    <th className={th} /><th className={th}>Concepto</th><th className={th}>Cuenta consumo</th>
                    <th className={`${th} text-right`}>Provisionado (G/L)</th><th className={`${th} text-right`}>Calculado LM</th><th className={`${th} text-right`}>Consumido</th>
                    <th className={`${th} text-right`}>Pendiente</th><th className={`${th} text-right`}>% consumido</th><th className={`${th} text-right`}>Documentos</th>
                  </tr>
                </thead>
                <tbody>
                  {d.concepts.map(c => (
                    <Fragment key={c.key}>
                      <tr className={`border-b border-gray-100 ${c.docs.length ? 'hover:bg-gray-50 cursor-pointer' : ''}`} onClick={() => c.docs.length && toggle(c.key)}>
                        <td className={td}>{c.docs.length ? (open[c.key] ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</td>
                        <td className={`${td} font-semibold text-gray-900`}>{c.label}</td>
                        <td className={`${td} font-mono`}>{c.account || '–'}</td>
                        <td className={`${td} text-right font-mono`}>{amt(c.provision)}</td>
                        <td className={`${td} text-right font-mono text-gray-500`}>{amt(c.lm)}</td>
                        <td className={`${td} text-right font-mono`}>{amt(c.consumed)}</td>
                        <td className={`${td} text-right font-mono font-semibold ${c.pending !== null && c.pending < 0 ? 'text-[#C0392B]' : ''}`}>{amt(c.pending)}</td>
                        <td className={`${td} text-right font-mono`}>{c.consumed !== null && c.provision ? pct((c.consumed / c.provision) * 100) : '–'}</td>
                        <td className={`${td} text-right font-mono`}>{c.account ? c.docs.length : '–'}</td>
                      </tr>
                      {open[c.key] && (
                        <tr className="bg-gray-50/70">
                          <td />
                          <td colSpan={8} className="py-2 pr-2">
                            <table className="w-full text-[12px] bg-white rounded-lg border border-gray-200">
                              <tbody>
                                {groupsOf(c).map(g => (
                                  <Fragment key={g.id}>
                                    <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(`${c.key}|${g.id}`)}>
                                      <td className={`${td} w-6`}>{open[`${c.key}|${g.id}`] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                                      <td className={`${td} font-semibold text-gray-900`}>{g.label}</td>
                                      <td className={`${td} text-right text-gray-500`}>{g.docs.length} documentos</td>
                                      <td className={`${td} text-right font-mono font-semibold`}>{num(sum(g.docs), 2)}</td>
                                    </tr>
                                    {open[`${c.key}|${g.id}`] && (
                                      <tr>
                                        <td />
                                        <td colSpan={3} className="py-2 pr-2">
                                          {g.children ? (
                                            <table className="w-full text-[12px] border border-gray-200 rounded-lg">
                                              <tbody>
                                                {g.children.map(sub => (
                                                  <Fragment key={sub.id}>
                                                    <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(`${c.key}|${sub.id}`)}>
                                                      <td className={`${td} w-6`}>{open[`${c.key}|${sub.id}`] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                                                      <td className={`${td} font-semibold text-gray-900`}>{sub.label}</td>
                                                      <td className={`${td} text-right text-gray-500`}>{sub.docs.length} documentos</td>
                                                      <td className={`${td} text-right font-mono font-semibold`}>{num(sum(sub.docs), 2)}</td>
                                                    </tr>
                                                    {open[`${c.key}|${sub.id}`] && (
                                                      <tr><td /><td colSpan={3} className="py-2 pr-2">{docsTable(`${c.key}|${sub.id}`, sub.docs, c.account)}</td></tr>
                                                    )}
                                                  </Fragment>
                                                ))}
                                              </tbody>
                                            </table>
                                          ) : docsTable(`${c.key}|${g.id}`, g.docs, c.account)}
                                        </td>
                                      </tr>
                                    )}
                                  </Fragment>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  <tr className="border-t border-gray-300 font-semibold">
                    <td /><td className={td}>Total</td><td />
                    <td className={`${td} text-right font-mono`}>{num(totals.provision, 2)}</td>
                    <td className={`${td} text-right font-mono text-gray-500`}>{num(totals.lm, 2)}</td>
                    <td className={`${td} text-right font-mono`}>{num(totals.consumed, 2)}</td>
                    <td className={`${td} text-right font-mono`}>{num(totals.provision - totals.consumed, 2)}</td>
                    <td className={`${td} text-right font-mono`}>{totals.provision ? pct((totals.consumed / totals.provision) * 100) : '–'}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            <Card title="Calculado por la LM y consumido por Customer Group" sub="Calculado: Documents LM Components (60000, sin Main Item); Markant = Provision Accounting Partner (parte de Conditions). Consumido: facturas y abonos de compra de proveedores que son clientes del grupo (por CIF o nombre) en las cuentas PROV-*; las facturas de Markant se reparten en proporción al Markant calculado de cada grupo. Pincha un grupo para ver sus documentos.">
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-left">
                      <th className={th} /><th className={th}>Customer Group</th><th className={th}>Customer Group Name</th>
                      {LM_COLS.map(([k, label]) => (
                        <Fragment key={k}>
                          <th className={`${th} text-right`}>{label} calc.</th>
                          {k !== 'kam' && <th className={`${th} text-right`}>cons.</th>}
                          <th className={`${th} text-right`}>pend.</th>
                        </Fragment>
                      ))}
                      <th className={`${th} text-right`}>Total calc.</th><th className={`${th} text-right`}>Total cons.</th><th className={`${th} text-right`}>Pendiente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lmByGroup.map(g => {
                      const gk = `group|${g.code}`;
                      return (
                        <Fragment key={g.code}>
                          <tr className={`border-b border-gray-100 ${g.docs.length ? 'hover:bg-gray-50 cursor-pointer' : ''}`} onClick={() => g.docs.length && toggle(gk)}>
                            <td className={td}>{g.docs.length ? (open[gk] ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}</td>
                            <td className={`${td} font-mono`}>{g.code}</td>
                            <td className="py-1.5 px-2 min-w-[160px] font-medium text-gray-900">{g.name || '–'}</td>
                            {LM_COLS.map(([k]) => (
                              <Fragment key={k}>
                                <td className={`${td} text-right font-mono`}>{num(g[k], 2)}</td>
                                {k !== 'kam' && <td className={`${td} text-right font-mono text-gray-600`}>{g.consumed[k] ? num(g.consumed[k], 2) : '–'}</td>}
                                <td className={`${td} text-right font-mono`}><Pending v={g[k] - (g.consumed[k] || 0)} /></td>
                              </Fragment>
                            ))}
                            <td className={`${td} text-right font-mono font-semibold`}>{num(g.total, 2)}</td>
                            <td className={`${td} text-right font-mono font-semibold`}>{num(g.consumedTotal, 2)}</td>
                            <td className={`${td} text-right font-mono font-semibold`}><Pending v={g.total - g.consumedTotal} /></td>
                          </tr>
                          {open[gk] && (
                            <tr className="bg-gray-50/70">
                              <td />
                              <td colSpan={2 + LM_COLS.length * 3 - 1 + 3} className="py-2 pr-2">
                                {/* Un subnivel por concepto (Conditions, Markant, Marketing…), que se abre para ver sus documentos */}
                                <table className="w-full text-[12px] bg-white rounded-lg border border-gray-200">
                                  <tbody>
                                    {LM_COLS.map(([k, label]) => {
                                      const docs = g.docs.filter(x => x.concept === k);
                                      if (!docs.length) return null;
                                      const ck = `${gk}|${k}`;
                                      return (
                                        <Fragment key={k}>
                                          <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(ck)}>
                                            <td className={`${td} w-6`}>{open[ck] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                                            <td className={`${td} font-semibold text-gray-900`}>{label}</td>
                                            <td className={`${td} text-right text-gray-500`}>{docs.length} documentos</td>
                                            <td className={`${td} text-right font-mono font-semibold`}>{num(docs.reduce((t, x) => t + x.amount, 0), 2)}</td>
                                          </tr>
                                          {open[ck] && (
                                            <tr>
                                              <td />
                                              <td colSpan={3} className="py-2 pr-2">
                                                <Table cols={[{ label: 'Document No.', mono: true }, { label: 'Tipo' }, { label: 'Fecha', mono: true }, { label: 'Proveedor', wide: true }, { label: 'Nº doc. proveedor' }, { label: 'Importe', align: 'right', mono: true }]}
                                                  rows={docs.map(x => [x.documentNo, x.type === 'Invoice' ? 'Factura' : x.type === 'Credit Memo' ? 'Abono' : x.type, date(x.date), `${x.vendorName || ''} ${x.vendorNo}`.trim(), x.externalDocNo || '–', num(x.amount, 2)])}
                                                  total={['Total', '', '', '', '', num(docs.reduce((t, x) => t + x.amount, 0), 2)]} />
                                              </td>
                                            </tr>
                                          )}
                                        </Fragment>
                                      );
                                    })}
                                    <tr className="border-t border-gray-300 font-semibold">
                                      <td /><td className={td}>Total</td><td className={`${td} text-right text-gray-500`}>{g.docs.length} documentos</td>
                                      <td className={`${td} text-right font-mono`}>{num(g.consumedTotal, 2)}</td>
                                    </tr>
                                  </tbody>
                                </table>
                                {g.cancelledPairs > 0 && <p className="text-xs text-gray-500 mt-2">No se muestran {g.cancelledPairs} facturas anuladas por su abono (abono aplicado a la factura en BC, o mismo proveedor, fecha, concepto e importe); cada pareja suma 0.</p>}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    <tr className="border-t border-gray-300 font-semibold">
                      <td /><td className={td}>Total</td><td />
                      {LM_COLS.map(([k]) => (
                        <Fragment key={k}>
                          <td className={`${td} text-right font-mono`}>{num(d.lmByGroup.reduce((t, g) => t + g[k], 0), 2)}</td>
                          {k !== 'kam' && <td className={`${td} text-right font-mono`}>{num(d.lmByGroup.reduce((t, g) => t + (g.consumed[k] || 0), 0), 2)}</td>}
                          <td className={`${td} text-right font-mono`}><Pending v={d.lmByGroup.reduce((t, g) => t + g[k] - (g.consumed[k] || 0), 0)} /></td>
                        </Fragment>
                      ))}
                      <td className={`${td} text-right font-mono`}>{num(d.lmByGroup.reduce((t, g) => t + g.total, 0), 2)}</td>
                      <td className={`${td} text-right font-mono`}>{num(d.lmByGroup.reduce((t, g) => t + g.consumedTotal, 0), 2)}</td>
                      <td className={`${td} text-right font-mono`}><Pending v={d.lmByGroup.reduce((t, g) => t + g.total - g.consumedTotal, 0)} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-500 mt-2">Solo cuentan las facturas y abonos de proveedores que se han podido emparejar con un Customer Group; los asientos (Skonto, traspasos…) y los proveedores sin cliente equivalente no salen aquí.</p>
            </Card>

            <Card title="Por mes" sub="Provisionado (G/L), consumido en las cuentas PROV-* y pendiente (provisionado − consumido) por fecha de registro">
              <div className="overflow-x-auto">
                <Table
                  cols={[{ label: 'Mes' }, ...d.concepts.flatMap(c => [
                    { label: `${c.label.replace('Provision ', '')} prov.`, align: 'right' as const, mono: true },
                    ...(c.account ? [{ label: 'cons.', align: 'right' as const, mono: true }, { label: 'pend.', align: 'right' as const, mono: true }] : []),
                  ])]}
                  rows={d.byMonth.map(m => [monthName(m.month), ...d.concepts.flatMap(c => {
                    const v = m[c.key];
                    return [num(v.provision), ...(c.account ? [num(v.consumed), <Pending key="p" v={v.provision - v.consumed} />] : [])];
                  })])}
                  total={['Total', ...d.concepts.flatMap(c => {
                    const p = d.byMonth.reduce((s, m) => s + m[c.key].provision, 0);
                    const k = d.byMonth.reduce((s, m) => s + (m[c.key].consumed || 0), 0);
                    return [num(p), ...(c.account ? [num(k), <Pending key="p" v={p - k} />] : [])];
                  })]}
                />
              </div>
            </Card>
            <p className="text-xs text-gray-500">
              Provision KAM es la columna «Provision HHRR» de la LM; no tiene cuenta PROV de consumo. El consumido incluye las facturas y abonos de compra, los asientos de diario en las cuentas PROV-* (p. ej. Skonto Reclassification) y los traspasos de los asientos PROV-… que rebajan la cuenta de provisión contra otras cuentas de balance (p. ej. PROV-00049 desde la 3071 06).
            </p>
          </>
        )}
    </Section>
  );
}
