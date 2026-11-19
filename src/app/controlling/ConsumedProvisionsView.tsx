'use client';

import { Fragment, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileDown, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { Card, ErrorBox, Grid, Kpi, Loading, Section, Table } from '../reporting/ui';
import DocPdfLink from '@/components/DocPdfLink';
import { useT } from '@/contexts/LanguageContext';

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
// Solo las facturas y abonos de compra tienen PDF adjunto que abrir
const pdfKind = (type: string) => (type === 'Invoice' ? 'purchInv' : type === 'Credit Memo' ? 'purchCrMemo' : null);
const LM_COLS: ['conditions' | 'markant' | 'kam' | 'royalties' | 'marketing' | 'amazon', string][] = [
  ['conditions', 'Conditions (excl. Markant)'], ['markant', 'Markant (Accounting Partner)'], ['kam', 'KAM'], ['royalties', 'Royalties'], ['marketing', 'Marketing (excl. Amazon)'], ['amazon', 'Amazon Promotion'],
];
// Pendiente (provisionado − consumido), en rojo si se ha consumido más de lo provisionado
const Pending = ({ v }: { v: number }) => {
  const { locale } = useT();
  return <span className={v < -0.5 ? 'text-[#C0392B]' : ''}>{Math.round(v).toLocaleString(locale)}</span>;
};

// Columnas ordenables de los documentos de una provisión
type SortKey = 'documentNo' | 'type' | 'firstDate' | 'vendor' | 'externalDocNo' | 'initialAccounts' | 'reclassified' | 'amount';
const DOC_COLS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: 'documentNo', label: 'Document No.' }, { key: 'type', label: 'Type' }, { key: 'firstDate', label: 'Date' },
  { key: 'vendor', label: 'Vendor' }, { key: 'externalDocNo', label: 'Vendor doc. no.' }, { key: 'initialAccounts', label: 'Posted to' },
  { key: 'reclassified', label: 'Reclassified' }, { key: 'amount', label: 'Amount', right: true },
];
const sortValue = (d: Doc, k: SortKey): string | number =>
  k === 'amount' ? d.amount : k === 'vendor' ? (d.vendorName || d.vendorNo).toLowerCase()
  : k === 'initialAccounts' ? d.initialAccounts.join(', ') : k === 'reclassified' ? Number(d.reclassified) : String(d[k] || '').toLowerCase();
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 font-mono whitespace-nowrap';
const td = 'py-1.5 px-2 whitespace-nowrap';

export default function ConsumedProvisionsView({ fmt, company }: { fmt: Fmt; company: string }) {
  const { t, tx } = useT();
  const { num, pct, date, monthName } = fmt;
  const typeLabel = (type: string) => (type === 'Invoice' ? t('Invoice') : type === 'Credit Memo' ? t('Credit memo') : type);
  // Por defecto: del 1 de enero al último día del mes anterior (en enero, el año anterior completo)
  const [to, setTo] = useState(() => { const d = new Date(); return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0))); });
  const [from, setFrom] = useState(() => `${to.substring(0, 4)}-01-01`);
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sort, setSort] = useState<Record<string, { key: SortKey; dir: 1 | -1 }>>({});
  // Agrupación de las facturas de cada provisión (como el desglose del BWA): mes, proveedor, origen o sin agrupar
  const [grouping, setGrouping] = useState<'none' | 'month' | 'vendor' | 'source'>('none');
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
    const group = (x: Doc) => (x.type === 'Invoice' ? t('Invoice') : x.type === 'Credit Memo' ? t('Credit memo') : t('Journal entry'));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.concepts.map(c => ({
      [t('Concept')]: tx(c.label), [t('Consumption account')]: c.account, [t('Provisioned (G/L)')]: c.provision, [t('LM calculation')]: c.lm,
      [t('Consumed')]: c.consumed, [t('Pending')]: c.pending, [t('% consumed')]: c.consumed !== null && c.provision ? c.consumed / c.provision : null, [t('Documents')]: c.docs.length,
    }))), t('Summary'));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.lmByGroup.map(g => ({
      'Customer Group': g.code, 'Customer Group Name': g.name,
      ...Object.fromEntries(LM_COLS.flatMap(([k, label]) => [[`${t(label)} ${t('calc.')}`, g[k]], ...(k !== 'kam' ? [[`${t(label)} ${t('cons.')}`, g.consumed[k] || 0]] : []), [`${t(label)} ${t('pend.')}`, g[k] - (g.consumed[k] || 0)]])),
      [t('Total calc.')]: g.total, [t('Total cons.')]: g.consumedTotal, [t('Pending')]: g.total - g.consumedTotal,
    }))), t('LM by Customer Group'));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.lmByGroup.flatMap(g => g.docs.map(x => ({
      'Customer Group': g.code, 'Customer Group Name': g.name, [t('Concept')]: t(LM_COLS.find(([k]) => k === x.concept)?.[1] || x.concept),
      'Document No.': x.documentNo, [t('Type')]: typeLabel(x.type), [t('Date')]: x.date, 'Vendor No.': x.vendorNo, [t('Vendor')]: x.vendorName,
      [t('Vendor doc. no.')]: x.externalDocNo, [t('Amount')]: x.amount,
    })))), t('Invoices by Customer Group'));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.byMonth.map(m => Object.fromEntries([[t('Month'), m.month], ...d.concepts.flatMap(c => {
      const v = m[c.key];
      const name = tx(c.label).replace('Provision ', '');
      return [[`${name} ${t('prov.')}`, v.provision], ...(c.account ? [[`${name} ${t('cons.')}`, v.consumed], [`${name} ${t('pend.')}`, v.provision - v.consumed]] : [])];
    })]))), t('By month'));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.concepts.flatMap(c => c.docs.map(x => ({
      [t('Concept')]: tx(c.label), [t('Group')]: group(x), 'Document No.': x.documentNo, [t('Type')]: x.type, [t('Date')]: x.firstDate, 'Vendor No.': x.vendorNo, [t('Vendor')]: x.vendorName,
      [t('Vendor doc. no.')]: x.externalDocNo, [t('Posted to')]: x.initialAccounts.join(', '), [t('Reclassified')]: x.reclassified ? t('Yes') : t('No'), [t('Amount')]: x.amount, [t('Consumption account')]: c.account,
    })))), t('Documents'));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.concepts.flatMap(c => c.docs.flatMap(x => x.movements.map(m => ({
      [t('Concept')]: tx(c.label), 'Document No.': x.documentNo, [t('Date')]: m.date, [t('Account')]: m.account, [t('Source')]: m.source, [t('Description')]: m.description, [t('Bal. account')]: m.balAccount, [t('Amount')]: m.amount,
    }))))), t('Entries'));
    XLSX.writeFile(wb, `Consumed_Provisions_${company}_${from}_${to}.xlsx`.replace(/\s+/g, '_'));
  };

  const sum = (docs: Doc[]) => docs.reduce((t, x) => t + x.amount, 0);
  // Subniveles de una provisión: facturas y abonos de compra (con un nivel para cada uno) y asientos
  type Group = { id: string; label: string; docs: Doc[]; children?: Group[] };
  const groupsOf = (c: Concept): Group[] => {
    const inv = c.docs.filter(x => x.type === 'Invoice'), cm = c.docs.filter(x => x.type === 'Credit Memo');
    const other = c.docs.filter(x => x.type !== 'Invoice' && x.type !== 'Credit Memo');
    return [
      { id: 'purchase', label: t('Purchase invoices and credit memos'), docs: [...inv, ...cm], children: [
        { id: 'invoices', label: t('Invoices'), docs: inv }, { id: 'creditMemos', label: t('Credit memos'), docs: cm },
      ] },
      { id: 'entries', label: t('Journal entries (journal, transfers and re-invoicing)'), docs: other },
    ].filter(g => g.docs.length);
  };

  // Documentos agrupados según "Agrupar por": cada grupo se despliega con su tabla
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const groupKeyOf = (doc: Doc) => grouping === 'month' ? (doc.firstDate || '').substring(0, 7)
    : grouping === 'vendor' ? `${doc.vendorNo}|${doc.vendorName || doc.vendorNo || t('(no vendor)')}`
    : (doc.movements[0]?.source || t('(no source)'));
  const groupLabelOf = (k: string) => grouping === 'month' ? (k ? `${cap(fmt.monthOnly(k))} ${k.substring(0, 4)}` : t('(no date)'))
    : grouping === 'vendor' ? `${k.split('|').slice(1).join('|')}${k.split('|')[0] ? ` · ${k.split('|')[0]}` : ''}` : k;
  const docsTable = (gk: string, docs: Doc[], account: string) => {
    if (grouping === 'none') return docsTableFlat(gk, docs, account);
    const groups = new Map<string, Doc[]>();
    for (const x of docs) groups.set(groupKeyOf(x), [...(groups.get(groupKeyOf(x)) || []), x]);
    const list = Array.from(groups.entries()).sort((a, b) => grouping === 'month' ? a[0].localeCompare(b[0]) : Math.abs(sum(b[1])) - Math.abs(sum(a[1])));
    return (
      <div className="space-y-1">
        {list.map(([k, g]) => {
          const ok = `${gk}|grp:${grouping}:${k}`;
          return (
            <div key={k} className="border border-gray-200 rounded-lg bg-white">
              <button onClick={() => toggle(ok)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50">
                {open[ok] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="text-gray-800">{groupLabelOf(k)}</span>
                <span className="ml-auto text-xs text-gray-500">{t('{n} doc.', { n: g.length })}</span>
                <span className="w-36 text-right font-semibold font-mono">{num(sum(g), 2)}</span>
              </button>
              {open[ok] && <div className="px-2 pb-2">{docsTableFlat(ok, g, account)}</div>}
            </div>
          );
        })}
      </div>
    );
  };

  // Tabla de documentos (ordenable) de un grupo: gk = concepto|grupo
  const docsTableFlat = (gk: string, docs: Doc[], account: string) => (
    <table className="w-full text-[12px] bg-white rounded-lg border border-gray-200">
      <thead>
        <tr className="border-b border-gray-200 text-left">
          <th className={th} />
          {DOC_COLS.map(col => (
            <th key={col.key} className={`${th} ${col.right ? 'text-right' : ''} cursor-pointer select-none hover:text-gray-900`} onClick={() => sortBy(gk, col.key)}>
              <span className={`inline-flex items-center gap-1 ${col.right ? 'flex-row-reverse' : ''}`}>
                {col.key === 'amount' ? t('Amount in {account}', { account }) : t(col.label)}
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
                <td className={`${td} font-mono`}>{doc.documentNo}{pdfKind(doc.type) && <DocPdfLink company={company} documentNo={doc.documentNo} kind={pdfKind(doc.type)!} />}</td>
                <td className={td}>{typeLabel(doc.type)}</td>
                <td className={`${td} font-mono`}>{date(doc.firstDate)}</td>
                <td className="py-1.5 px-2 min-w-[180px]">{doc.vendorName || doc.vendorNo || '–'} <span className="text-gray-400 font-mono">{doc.vendorName ? doc.vendorNo : ''}</span></td>
                <td className={td}>{doc.externalDocNo || '–'}</td>
                <td className={`${td} font-mono`}>{doc.initialAccounts.join(', ') || '–'}</td>
                <td className={td}>{doc.reclassified ? <span className="text-[#C8186C] font-semibold">{t('Yes')}</span> : t('No')}</td>
                <td className={`${td} text-right font-mono font-semibold`}>{num(doc.amount, 2)}</td>
              </tr>
              {open[k] && (
                <tr>
                  <td />
                  <td colSpan={8} className="py-2 pr-2">
                    <Table cols={[{ label: t('Date'), mono: true }, { label: t('Account'), mono: true }, { label: t('Source'), mono: true }, { label: t('Description'), wide: true }, { label: t('Bal. account'), mono: true }, { label: t('Amount'), align: 'right', mono: true }]}
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
    <Section title="Consumed Provisions" source={t('Provisioned: PROV* entries on income-statement accounts (4769 02, 6020 10, 6600 30, 6600 31, 6837 00) · LM calculation: Documents LM Components (reference) · Consumed: purchase invoices and credit memos on PROV-KONDITIONS / PROV-MARKETING / PROV-ROYALTIES / PROV-AMZPROM (G/L Entries, by Document No.)')}>
      <div className="flex flex-wrap items-end gap-4">
        {([[t('From'), from, setFrom], [t('Until'), to, setTo]] as const).map(([label, value, set]) => (
          <label key={label} className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {label}
            <input type="date" value={value} onChange={e => set(e.target.value)}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal" />
          </label>
        ))}
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          {t('Group invoices by')}
          <select value={grouping} onChange={e => setGrouping(e.target.value as typeof grouping)}
            className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal">
            <option value="none">{t('No grouping')}</option>
            <option value="month">{t('Month')}</option>
            <option value="vendor">{t('Vendor')}</option>
            <option value="source">{t('Source (Source Code)')}</option>
          </select>
        </label>
        <button onClick={exportExcel} disabled={state.loading || !d}
          className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
          <FileDown size={16} /> {t('Export Excel')}
        </button>
        <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={state.loading} title={t('Reload from BC')}
          className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
          <RefreshCw size={16} className={state.loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {from > to ? <ErrorBox message={t('The From date is after the To date.')} />
        : state.error ? <ErrorBox message={tx(state.error)} />
        : state.loading || !d || !totals ? <Loading text={t('Reading the LM and the G/L entries from Business Central…')} />
        : (
          <>
            <Grid cols={3}>
              <Kpi label={t('Provisioned (G/L)')} value={num(totals.provision)} sub={t('Calculated by the LM: {v}', { v: num(totals.lm) })} />
              <Kpi label={t('Consumed (invoices and credit memos)')} value={num(totals.consumed)} sub={totals.provision ? t('{p} of the amount generated', { p: pct((totals.consumed / totals.provision) * 100) }) : undefined} />
              <Kpi highlight tone="main" label={t('Pending')} value={num(totals.provision - totals.consumed)} sub={t('Provisioned − consumed')} />
            </Grid>

            <div className="rpt-card bg-white rounded-xl border border-gray-200 table-scroll">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left">
                    <th className={th} /><th className={th}>{t('Concept')}</th><th className={th}>{t('Consumption account')}</th>
                    <th className={`${th} text-right`}>{t('Provisioned (G/L)')}</th><th className={`${th} text-right`}>{t('LM calculation')}</th><th className={`${th} text-right`}>{t('Consumed')}</th>
                    <th className={`${th} text-right`}>{t('Pending')}</th><th className={`${th} text-right`}>{t('% consumed')}</th><th className={`${th} text-right`}>{t('Documents')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.concepts.map(c => (
                    <Fragment key={c.key}>
                      <tr className={`border-b border-gray-100 ${c.docs.length ? 'hover:bg-gray-50 cursor-pointer' : ''}`} onClick={() => c.docs.length && toggle(c.key)}>
                        <td className={td}>{c.docs.length ? (open[c.key] ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</td>
                        <td className={`${td} font-semibold text-gray-900`}>{tx(c.label)}</td>
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
                                      <td className={`${td} text-right text-gray-500`}>{t('{n} documents', { n: g.docs.length })}</td>
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
                                                      <td className={`${td} text-right text-gray-500`}>{t('{n} documents', { n: sub.docs.length })}</td>
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
                    <td /><td className={td}>{t('Total')}</td><td />
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

            <Card title={t('LM calculation and consumption by Customer Group')} sub={t('Calculated: Documents LM Components (60000, without Main Item); Markant = Provision Accounting Partner (part of Conditions). Consumed: purchase invoices and credit memos of vendors that are customers of the group (by VAT no. or name) on the PROV-* accounts; Markant invoices are spread in proportion to the calculated Markant of each group. Click a group to see its documents.')}>
              <div className="table-scroll">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-left">
                      <th className={th} /><th className={th}>Customer Group</th><th className={th}>Customer Group Name</th>
                      {LM_COLS.map(([k, label]) => (
                        <Fragment key={k}>
                          <th className={`${th} text-right`}>{t(label)} {t('calc.')}</th>
                          {k !== 'kam' && <th className={`${th} text-right`}>{t('cons.')}</th>}
                          <th className={`${th} text-right`}>{t('pend.')}</th>
                        </Fragment>
                      ))}
                      <th className={`${th} text-right`}>{t('Total calc.')}</th><th className={`${th} text-right`}>{t('Total cons.')}</th><th className={`${th} text-right`}>{t('Pending')}</th>
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
                                            <td className={`${td} font-semibold text-gray-900`}>{t(label)}</td>
                                            <td className={`${td} text-right text-gray-500`}>{t('{n} documents', { n: docs.length })}</td>
                                            <td className={`${td} text-right font-mono font-semibold`}>{num(docs.reduce((t, x) => t + x.amount, 0), 2)}</td>
                                          </tr>
                                          {open[ck] && (
                                            <tr>
                                              <td />
                                              <td colSpan={3} className="py-2 pr-2">
                                                <Table cols={[{ label: 'Document No.', mono: true }, { label: t('Type') }, { label: t('Date'), mono: true }, { label: t('Vendor'), wide: true }, { label: t('Vendor doc. no.') }, { label: t('Amount'), align: 'right', mono: true }]}
                                                  rows={docs.map(x => [<>{x.documentNo}{pdfKind(x.type) && <DocPdfLink company={company} documentNo={x.documentNo} kind={pdfKind(x.type)!} />}</>, typeLabel(x.type), date(x.date), `${x.vendorName || ''} ${x.vendorNo}`.trim(), x.externalDocNo || '–', num(x.amount, 2)])}
                                                  total={[t('Total'), '', '', '', '', num(docs.reduce((t, x) => t + x.amount, 0), 2)]} />
                                              </td>
                                            </tr>
                                          )}
                                        </Fragment>
                                      );
                                    })}
                                    <tr className="border-t border-gray-300 font-semibold">
                                      <td /><td className={td}>{t('Total')}</td><td className={`${td} text-right text-gray-500`}>{t('{n} documents', { n: g.docs.length })}</td>
                                      <td className={`${td} text-right font-mono`}>{num(g.consumedTotal, 2)}</td>
                                    </tr>
                                  </tbody>
                                </table>
                                {g.cancelledPairs > 0 && <p className="text-xs text-gray-500 mt-2">{t('{n} invoices cancelled by their credit memo are not shown (credit memo applied to the invoice in BC, or same vendor, date, concept and amount); each pair adds up to 0.', { n: g.cancelledPairs })}</p>}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    <tr className="border-t border-gray-300 font-semibold">
                      <td /><td className={td}>{t('Total')}</td><td />
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
              <p className="text-xs text-gray-500 mt-2">{t('Only invoices and credit memos of vendors that could be matched with a Customer Group count; journal entries (Skonto, transfers…) and vendors without an equivalent customer are not shown here.')}</p>
            </Card>

            <Card title={t('By month')} sub={t('Provisioned (G/L), consumed on the PROV-* accounts and pending (provisioned − consumed) by posting date')}>
              <div className="overflow-x-auto">
                <Table
                  cols={[{ label: t('Month') }, ...d.concepts.flatMap(c => [
                    { label: `${tx(c.label).replace('Provision ', '')} ${t('prov.')}`, align: 'right' as const, mono: true },
                    ...(c.account ? [{ label: t('cons.'), align: 'right' as const, mono: true }, { label: t('pend.'), align: 'right' as const, mono: true }] : []),
                  ])]}
                  rows={d.byMonth.map(m => [monthName(m.month), ...d.concepts.flatMap(c => {
                    const v = m[c.key];
                    return [num(v.provision), ...(c.account ? [num(v.consumed), <Pending key="p" v={v.provision - v.consumed} />] : [])];
                  })])}
                  total={[t('Total'), ...d.concepts.flatMap(c => {
                    const p = d.byMonth.reduce((s, m) => s + m[c.key].provision, 0);
                    const k = d.byMonth.reduce((s, m) => s + (m[c.key].consumed || 0), 0);
                    return [num(p), ...(c.account ? [num(k), <Pending key="p" v={p - k} />] : [])];
                  })]}
                />
              </div>
            </Card>
            <p className="text-xs text-gray-500">
              {t('Provision KAM is the «Provision HHRR» column of the LM; it has no PROV consumption account. Consumed includes purchase invoices and credit memos, journal entries on the PROV-* accounts (e.g. Skonto Reclassification) and the transfers in PROV-… entries that reduce the provision account against other balance-sheet accounts (e.g. PROV-00049 from 3071 06).')}
            </p>
          </>
        )}
    </Section>
  );
}
