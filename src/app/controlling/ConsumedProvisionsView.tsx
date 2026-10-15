'use client';

import { Fragment, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import type { Fmt } from '../reporting/i18n';
import { Card, ErrorBox, Grid, Kpi, Loading, Section, Table } from '../reporting/ui';

// Controlling · Consumed Provisions: provisión generada en la LM frente a lo consumido por facturas/abonos de compra
// en las cuentas PROV-*.
type Movement = { date: string; account: string; amount: number; source: string; description: string; balAccount: string };
type Doc = { documentNo: string; type: string; vendorNo: string; vendorName: string; externalDocNo: string; firstDate: string; initialAccounts: string[]; reclassified: boolean; movements: Movement[]; amount: number };
type Concept = { key: string; label: string; account: string; provision: number; lm: number; consumed: number | null; pending: number | null; docs: Doc[] };
type Data = { concepts: Concept[]; byMonth: any[]; lmLines: number; excludedJournal: number; glEntries: number };

const iso = (d: Date) => d.toISOString().substring(0, 10);

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
  const [from, setFrom] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(() => iso(new Date()));
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sort, setSort] = useState<Record<string, { key: SortKey; dir: 1 | -1 }>>({});
  const sortBy = (concept: string, key: SortKey) => setSort(s => {
    const cur = s[concept];
    return { ...s, [concept]: { key, dir: cur?.key === key ? (cur.dir === 1 ? -1 : 1) : key === 'amount' ? -1 : 1 } };
  });
  const sorted = (c: Concept) => {
    const st = sort[c.key];
    if (!st) return c.docs;
    return [...c.docs].sort((a, b) => {
      const va = sortValue(a, st.key), vb = sortValue(b, st.key);
      return (va < vb ? -1 : va > vb ? 1 : 0) * st.dir;
    });
  };

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
                              <thead>
                                <tr className="border-b border-gray-200 text-left">
                                  <th className={th} />
                                  {DOC_COLS.map(col => (
                                    <th key={col.key} className={`${th} ${col.right ? 'text-right' : ''} cursor-pointer select-none hover:text-gray-900`} onClick={() => sortBy(c.key, col.key)}>
                                      <span className={`inline-flex items-center gap-1 ${col.right ? 'flex-row-reverse' : ''}`}>
                                        {col.key === 'amount' ? `Importe en ${c.account}` : col.label}
                                        {sort[c.key]?.key === col.key && (sort[c.key].dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                                      </span>
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {sorted(c).map(doc => {
                                  const k = `${c.key}|${doc.documentNo}`;
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

            <Card title="Por mes" sub="Provisionado (G/L) y consumido en las cuentas PROV-* por fecha de registro">
              <div className="overflow-x-auto">
                <Table
                  cols={[{ label: 'Mes' }, ...d.concepts.flatMap(c => [
                    { label: `${c.label.replace('Provision ', '')} prov.`, align: 'right' as const, mono: true },
                    ...(c.account ? [{ label: 'cons.', align: 'right' as const, mono: true }] : []),
                  ])]}
                  rows={d.byMonth.map(m => [monthName(m.month), ...d.concepts.flatMap(c => [num(m[c.key].provision), ...(c.account ? [num(m[c.key].consumed)] : [])])])}
                />
              </div>
            </Card>
            <p className="text-xs text-gray-500">
              Provision KAM es la columna «Provision HHRR» de la LM; no tiene cuenta PROV de consumo. {d.excludedJournal > 0 && `${num(d.excludedJournal)} documentos de diario en las cuentas PROV sin factura ni abono de compra detrás no cuentan como consumo.`}
            </p>
          </>
        )}
    </Section>
  );
}
