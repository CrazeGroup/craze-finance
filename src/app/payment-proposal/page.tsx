'use client';

import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { BellRing, ChevronDown, ChevronRight, Download, Mail, RefreshCw } from 'lucide-react';
import ApproverReminderDialog from './ApproverReminderDialog';
import DocPdfLink, { purchasePdfKind } from '@/components/DocPdfLink';
import { useCompany } from '@/contexts/CompanyContext';
import { useT } from '@/contexts/LanguageContext';

type Entry = {
  entryNo: number; vendorNo: string; vendorName: string; docType: string; docNo: string; extDocNo: string;
  description: string; postingDate: string; dueDate: string;
  remaining: number; remainingLCY: number | null; currency: string;
  approvalPct: number; approvedUsers: string; pendingUsers: string;
  reminder?: boolean; lastReminderDate?: string; reminderComment?: string;
};
type ReminderEntry = Omit<Entry, 'approvedUsers' | 'pendingUsers'> & { paymentMethod: string; noPayment: boolean; onHold: string; inProposal: boolean };
type Proposal = {
  company: string; from: string; to: string; lcy: string; entries: Entry[]; reminders?: ReminderEntry[];
  fields: { currency: boolean; remainingLCY: boolean };
  usersSource: string; usersTried: string[]; unmatched: number; apiKeys: string[];
};

const APPROVED_PCT = 100;
const RANGE_KEY = 'craze_payment_proposal_range';
const iso = (d: Date) => d.toISOString().substring(0, 10);
const dateEs = (d: string) => (d ? d.split('-').reverse().join('/') : '');
const money = (v: number | null | undefined, locale: string) => (v == null ? '—' : v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const sum = <T,>(list: T[], f: (e: T) => number | null) => list.reduce((s, e) => s + (f(e) || 0), 0);

// Proveedor → movimientos, ordenado por nombre
function byVendor(list: Entry[]) {
  const map = new Map<string, Entry[]>();
  list.forEach(e => map.set(e.vendorName, [...(map.get(e.vendorName) || []), e]));
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

export default function PaymentProposalPage() {
  const { selectedCompany } = useCompany();
  const { t, tx, locale } = useT();
  // El rango de Due Date se guarda en el navegador: al cambiar de empresa la página se recarga y se mantiene
  const [range, setRange] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
      if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved.from) && /^\d{4}-\d{2}-\d{2}$/.test(saved.to) && saved.from <= saved.to) return saved as { from: string; to: string };
    } catch { /* sin almacenamiento */ }
    return { from: `${new Date().getFullYear()}-01-01`, to: iso(new Date()) };
  });
  useEffect(() => {
    try { localStorage.setItem(RANGE_KEY, JSON.stringify(range)); } catch { /* sin almacenamiento */ }
  }, [range]);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (selectedCompany === 'ALL' || !range.from || !range.to || range.from > range.to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/payment-proposal?from=${range.from}&to=${range.to}`)
      .then(async res => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(json.error || t('Error reading the vendor ledger entries')); setData(null); }
        else setData(json);
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCompany, range, reload]);

  const entries = data?.entries || [];
  const lcy = data?.lcy || 'EUR';
  // Divisas en columnas: la local primero
  const currencies = useMemo(() => Array.from(new Set(entries.map(e => e.currency))).sort((a, b) => (a === lcy ? -1 : b === lcy ? 1 : a.localeCompare(b))), [entries, lcy]);
  const reminders = data?.reminders || [];
  // Recordatorio a aprobadores: null = cerrado; si no, lo que viene marcado al abrir
  const [remind, setRemind] = useState<{ users?: string[]; entryNos?: number[] } | null>(null);
  const approved = entries.filter(e => e.approvalPct >= APPROVED_PCT);
  const pending = entries.filter(e => e.approvalPct < APPROVED_PCT);

  const exportExcel = () => {
    const head = [t('Vendor'), t('Vendor No.'), 'Document Type', t('Document No.'), t('External document no.'), t('Description'), t('Posting date'), t('Due date'), '% Payment Approval', 'Approved Users', 'Pending Users', t('Currency'), 'Remaining Amount', `Remaining Amt. (${lcy})`];
    const line = (e: Entry) => [e.vendorName, e.vendorNo, e.docType, e.docNo, e.extDocNo, e.description, e.postingDate, e.dueDate, e.approvalPct, e.approvedUsers, e.pendingUsers, e.currency, e.remaining, e.remainingLCY];
    const sheet = (title: string, list: Entry[]) => {
      const ws = XLSX.utils.aoa_to_sheet([[title], head, ...list.map(line)]);
      ws['!cols'] = [{ wch: 36 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 28 }, { wch: 11 }, { wch: 11 }, { wch: 8 }, { wch: 28 }, { wch: 28 }, { wch: 7 }, { wch: 14 }, { wch: 14 }];
      return ws;
    };
    const wb = XLSX.utils.book_new();
    const sub = `${selectedCompany} · ${t('due {from} – {to}', { from: dateEs(range.from), to: dateEs(range.to) })}`;
    XLSX.utils.book_append_sheet(wb, sheet(`Approved for Payment · ${sub}`, approved), 'Approved for Payment');
    XLSX.utils.book_append_sheet(wb, sheet(`Pending Approval · ${sub}`, [...pending].sort((a, b) => a.pendingUsers.localeCompare(b.pendingUsers) || a.vendorName.localeCompare(b.vendorName))), 'Pending Approval');
    if (reminders.length) {
      const ws = XLSX.utils.aoa_to_sheet([[`${t('Vendor invoices with Reminder')} · ${selectedCompany}`],
        [t('Vendor'), t('Vendor No.'), 'Document Type', t('Document No.'), t('External document no.'), t('Due date'), t('Last reminder'), t('Reminder comment'), 'Payment Method', '% Payment Approval', t('In the proposal'), t('Currency'), 'Remaining Amount', `Remaining Amt. (${lcy})`],
        ...reminders.map(e => [e.vendorName, e.vendorNo, e.docType, e.docNo, e.extDocNo, e.dueDate, e.lastReminderDate, e.reminderComment, e.paymentMethod, e.approvalPct, e.inProposal ? t('Yes') : t('No'), e.currency, e.remaining, e.remainingLCY])]);
      ws['!cols'] = [{ wch: 36 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 11 }, { wch: 11 }, { wch: 36 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 7 }, { wch: 14 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Reminders');
    }
    XLSX.writeFile(wb, `Payment_Proposal_${selectedCompany}_${range.from}_${range.to}.xlsx`.replace(/\s+/g, '_'));
  };

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg">Payment Proposal</p>
            <p className="text-xs text-gray-500">{selectedCompany} · {t('open invoices and credit memos · No Payment = No · payment method TRANSFER · no CRAZE vendors')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Due Date</span>
            <input type="date" value={range.from} max={range.to} onChange={e => e.target.value && setRange(r => ({ ...r, from: e.target.value }))}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" />
            <span className="text-gray-400 text-sm">–</span>
            <input type="date" value={range.to} min={range.from} onChange={e => e.target.value && setRange(r => ({ ...r, to: e.target.value }))}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" />
            <button onClick={() => setReload(n => n + 1)} disabled={loading} title={t('Read again from Business Central')}
              className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={exportExcel} disabled={loading || !entries.length}
              className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
              <Download size={16} /> {t('Export Excel')}
            </button>
          </div>
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-6 space-y-6">
        {selectedCompany === 'ALL' ? (
          <p className="text-sm text-gray-600">{t('Select a specific company in the side menu.')}</p>
        ) : error ? (
          <p className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700">{tx(error)}</p>
        ) : !data ? (
          <p className="text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> {t('Reading vendor ledger entries from Business Central…')}</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Kpi label={`Approved for Payment (${lcy})`} value={money(sum(approved, e => e.remainingLCY), locale)} sub={t('{docs} documents · {vendors} vendors', { docs: approved.length, vendors: byVendor(approved).length })} />
              <Kpi label={`Pending Approval (${lcy})`} value={money(sum(pending, e => e.remainingLCY), locale)} sub={t('{docs} documents · {vendors} vendors', { docs: pending.length, vendors: byVendor(pending).length })} />
              <Kpi label={t('Total proposal ({lcy})', { lcy })} value={money(sum(entries, e => e.remainingLCY), locale)} sub={t('Due {from} – {to}', { from: dateEs(range.from), to: dateEs(range.to) })} />
            </div>

            <ProposalTable title="Approved for Payment" subtitle={`% Payment Approval ≥ ${APPROVED_PCT}`} entries={approved} currencies={currencies} lcy={lcy} />
            {data.usersSource === 'none' && data.entries.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
                {t('The Pending Users could not be read from Business Central, so Pending Approval cannot be grouped by user.')}
                {data.usersTried.length > 0 && <ul className="mt-1 ml-4 list-disc font-mono text-xs break-words">{data.usersTried.map((s, i) => <li key={i}>{tx(s)}</li>)}</ul>}
                <details className="mt-1 text-xs"><summary className="cursor-pointer">{t('Fields returned by the API')}</summary><p className="font-mono break-words mt-1">{data.apiKeys.join(', ')}</p></details>
              </div>
            )}
            <ProposalTable title="Pending Approval" subtitle={`% Payment Approval < ${APPROVED_PCT} · ${t('grouped by Pending Users')}`} entries={pending} currencies={currencies} lcy={lcy} groupByPending onRemind={setRemind} />
            {remind && <ApproverReminderDialog docs={pending} preset={remind} lcy={lcy} onClose={() => setRemind(null)} />}

            <details className="text-xs text-gray-500" open={!data.usersSource.startsWith('odata:') || data.unmatched > 0}>
              <summary className="cursor-pointer">
                {t('Source of Approval / Pending Users:')} {data.usersSource === 'api' ? t('BC API') : data.usersSource.startsWith('odata:') ? t('BC page {page}', { page: data.usersSource.substring(6) }) : data.usersSource === 'derived' ? t('calculated (approvers − approved)') : t('not available')}
                {data.unmatched > 0 && ` · ${t('{n} documents not found on that page', { n: data.unmatched })}`}
              </summary>
              {data.usersTried.length > 0 && <ul className="mt-1 ml-4 list-disc font-mono break-words">{data.usersTried.map((s, i) => <li key={i}>{tx(s)}</li>)}</ul>}
            </details>
            <p className="text-xs text-gray-500">
              {t('Source: live Business Central Vendor Ledger Entries. Amounts = Remaining Amount in the document currency; the {lcy} column uses Remaining Amt. (LCY).', { lcy })}
              {data.usersSource.startsWith('odata:') && ` ${t('Approval / Pending Users from BC page {page}.', { page: data.usersSource.substring(6) })}`}
              {data.usersSource === 'derived' && ` ${t('Pending Users calculated as Approval Users minus Approved Users.')}`}
              {!data.fields.remainingLCY && data.entries.some(e => e.remainingLCY == null) && ` ${t('Foreign-currency documents have no {lcy} amount in the API: they are not added to that column.', { lcy })}`}
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 tabular-nums mt-1">{value}</p>
      {sub && <p className="text-xs mt-1 text-gray-500">{sub}</p>}
    </div>
  );
}

function ProposalTable({ title, subtitle, entries, currencies, lcy, groupByPending, onRemind }: {
  title: string; subtitle: string; entries: Entry[]; currencies: string[]; lcy: string; groupByPending?: boolean;
  onRemind?: (preset: { users?: string[]; entryNos?: number[] }) => void;
}) {
  const { t, locale } = useT();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const cols = currencies.length + 2;
  const amountCells = (list: Entry[], bold = false) => (
    <>
      {currencies.map(c => {
        const inCur = list.filter(e => e.currency === c);
        return <td key={c} className={`px-3 py-2 text-right tabular-nums ${bold ? 'font-bold' : ''}`}>{inCur.length ? money(sum(inCur, e => e.remaining), locale) : ''}</td>;
      })}
      <td className={`px-3 py-2 text-right tabular-nums ${bold ? 'font-bold' : 'font-semibold'}`}>{money(sum(list, e => e.remainingLCY), locale)}</td>
    </>
  );
  const groups: [string, Entry[]][] = groupByPending
    ? Array.from(entries.reduce((m, e) => m.set(e.pendingUsers, [...(m.get(e.pendingUsers) || []), e]), new Map<string, Entry[]>()).entries()).sort((a, b) => a[0].localeCompare(b[0]))
    : [['', entries]];

  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-sm font-bold text-gray-900">{title}</h2>
        <span className="text-xs text-gray-500">{subtitle} · {t('click a vendor to see its invoices')}</span>
        {onRemind && entries.length > 0 && (
          <button onClick={() => onRemind({})} className="ml-auto flex items-center gap-1.5 bg-gray-900 text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-black">
            <Mail size={13} /> {t('Remind approvers')}
          </button>
        )}
      </div>
      <div className="table-scroll">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="text-left px-3 py-2">{groupByPending ? t('Pending Users / Vendor') : t('Vendor')}</th>
              {currencies.map(c => <th key={c} className="text-right px-3 py-2">{c}</th>)}
              <th className="text-right px-3 py-2">Total ({lcy})</th>
            </tr>
          </thead>
          <tbody>
            {!entries.length && <tr><td colSpan={cols} className="px-3 py-6 text-center text-gray-500">{t('There are no documents.')}</td></tr>}
            {groups.map(([pendingUsers, list]) => (
              <React.Fragment key={pendingUsers || '-'}>
                {groupByPending && (
                  <tr className="border-t border-gray-200 bg-indigo-50/60 text-gray-900">
                    <td className="px-3 py-2 font-bold">
                      <span className="inline-flex items-center gap-2">{pendingUsers || t('(no pending users)')}
                        {onRemind && pendingUsers && (
                          <button onClick={() => onRemind({ users: pendingUsers.split('|').filter(Boolean), entryNos: list.map(e => e.entryNo) })} title={t('Send a reminder to these approvers')}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700 border border-indigo-200 bg-white rounded px-1.5 py-0.5 hover:bg-indigo-100">
                            <Mail size={11} /> {t('Remind')}
                          </button>
                        )}
                      </span>
                    </td>
                    {amountCells(list, true)}
                  </tr>
                )}
                {byVendor(list).map(([vendor, docs]) => {
                  const key = `${pendingUsers}|${vendor}`;
                  const isOpen = open.has(key);
                  return (
                    <React.Fragment key={key}>
                      <tr onClick={() => toggle(key)} className="border-t border-gray-100 cursor-pointer hover:bg-gray-50 text-gray-900">
                        <td className={`py-2 pr-3 ${groupByPending ? 'pl-7' : 'pl-3'}`}>
                          <span className="inline-flex items-center gap-1.5">
                            {isOpen ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                            {vendor}
                            <span className="text-xs text-gray-400">({docs.length})</span>
                            {docs.some(d => d.reminder) && <span title={t('Has invoices with Reminder')} className="text-red-600"><BellRing size={13} /></span>}
                          </span>
                        </td>
                        {amountCells(docs)}
                      </tr>
                      {isOpen && (
                        <tr className="bg-gray-50/70">
                          <td colSpan={cols} className={`py-2 pr-3 ${groupByPending ? 'pl-12' : 'pl-8'}`}>
                            <table className="w-full text-xs">
                              <thead className="text-gray-500">
                                <tr>
                                  <th className="text-left py-1 pr-3">{t('Type')}</th>
                                  <th className="text-left py-1 pr-3">{t('Document No.')}</th>
                                  <th className="text-left py-1 pr-3">{t('Ext. doc. no.')}</th>
                                  <th className="text-left py-1 pr-3">{t('Description')}</th>
                                  <th className="text-left py-1 pr-3">{t('Posting')}</th>
                                  <th className="text-left py-1 pr-3">{t('Due date')}</th>
                                  <th className="text-right py-1 pr-3">{t('% Appr.')}</th>
                                  <th className="text-left py-1 pr-3">{t('Approved by')}</th>
                                  {groupByPending && <th className="text-left py-1 pr-3">{t('Pending from')}</th>}
                                  <th className="text-right py-1 pr-3">{t('Amount')}</th>
                                  <th className="text-right py-1">{lcy}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {docs.map(d => (
                                  <tr key={d.entryNo} className="border-t border-gray-200 text-gray-800">
                                    <td className="py-1 pr-3 whitespace-nowrap">{d.docType === 'Credit Memo' ? t('Credit memo') : t('Invoice')}</td>
                                    <td className="py-1 pr-3 font-mono whitespace-nowrap">
                                      {d.reminder && <span title={t('The vendor has sent a payment reminder{date}{comment}', { date: d.lastReminderDate ? ` (${dateEs(d.lastReminderDate)})` : '', comment: d.reminderComment ? `: ${d.reminderComment}` : '' })} className="inline-flex mr-1 text-red-600 align-middle"><BellRing size={12} /></span>}
                                      {d.docNo}<DocPdfLink documentNo={d.docNo} kind={purchasePdfKind(d.docType)} /></td>
                                    <td className="py-1 pr-3">{d.extDocNo}</td>
                                    <td className="py-1 pr-3">{d.description}</td>
                                    <td className="py-1 pr-3 whitespace-nowrap">{dateEs(d.postingDate)}</td>
                                    <td className="py-1 pr-3 whitespace-nowrap">{dateEs(d.dueDate)}</td>
                                    <td className="py-1 pr-3 text-right tabular-nums">{d.approvalPct}</td>
                                    <td className="py-1 pr-3">{d.approvedUsers || '—'}</td>
                                    {groupByPending && <td className="py-1 pr-3 whitespace-nowrap">{d.pendingUsers || '—'}
                                      {onRemind && d.pendingUsers && (
                                        <button onClick={() => onRemind({ users: d.pendingUsers.split('|').filter(Boolean), entryNos: [d.entryNo] })} title={t('Remind the approvers of this document')}
                                          className="ml-1.5 align-middle text-indigo-600 hover:text-indigo-900"><Mail size={12} /></button>
                                      )}</td>}
                                    <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{money(d.remaining, locale)} {d.currency}</td>
                                    <td className="py-1 text-right tabular-nums">{money(d.remainingLCY, locale)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
          {entries.length > 0 && (
            <tfoot className="bg-gray-50 text-gray-900">
              <tr className="border-t-2 border-gray-300">
                <td className="px-3 py-2 font-bold">{t('Grand total')}</td>
                {amountCells(entries, true)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

