'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { RefreshCw, Search, Download, MessageSquare, ChevronRight, ChevronDown, ArrowUp, ArrowDown, ArrowUpDown, Trash2, AlertTriangle } from 'lucide-react';
import { useCompany, companyLabel } from '@/contexts/CompanyContext';
import { useT } from '@/contexts/LanguageContext';

type Comment = { source: 'bc' | 'app'; id?: number; date: string; text: string; author: string };
type Sro = {
  company: string; no: string; customerNo: string; customerName: string; externalDocumentNo: string;
  documentDate: string; postingDate: string; orderDate: string; status: string;
  assignedUserId: string; campaignNo: string; salespersonCode: string; typeOfReturn: string; xmlStatus: string;
  amount: number; amountInclVat: number; currency: string; comments: Comment[];
};
type GroupBy = 'none' | 'customer' | 'user' | 'campaign';
type Since = 'any' | 'today' | 'yesterday' | 'week' | 'month';
type SortKey = 'company' | 'no' | 'customer' | 'externalDocumentNo' | 'documentDate' | 'status' | 'assignedUserId' | 'campaignNo' | 'typeOfReturn' | 'xmlStatus' | 'amount' | 'comments' | 'lastComment';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Fecha local (YYYY-MM-DD) de un comentario: los de BC pueden traer solo la fecha, los de la app fecha y hora UTC
const dayOf = (c: Comment) => (c.date.length > 10 ? iso(new Date(c.date)) : c.date);
const lastDay = (r: Sro) => (r.comments.length ? r.comments.map(dayOf).sort().at(-1)! : '');
// "Desde ayer" = desde el último día laborable (el lunes, desde el viernes)
function sinceDate(since: Since): string {
  const d = new Date();
  if (since === 'today') return iso(d);
  if (since === 'yesterday') { d.setDate(d.getDate() - (d.getDay() === 1 ? 3 : d.getDay() === 0 ? 2 : 1)); return iso(d); }
  if (since === 'week') { d.setDate(d.getDate() - 7); return iso(d); }
  if (since === 'month') { d.setDate(d.getDate() - 30); return iso(d); }
  return '';
}
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } } };

// Sales Return Orders: seguimiento de todas las SRO abiertas, agrupables por cliente / Assigned User ID / Campaign No.,
// con nº de comentarios y sus fechas (para ver qué SRO tienen comentarios nuevos sin abrirlas una a una)
export default function SalesReturnsPage() {
  const { selectedCompany } = useCompany();
  const { t, tx, locale } = useT();
  const [rows, setRows] = useState<Sro[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [since, setSince] = useState<Since>('any');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'lastComment', dir: -1 });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const all = selectedCompany === 'ALL';

  useEffect(() => {
    const g = store.get('sro:groupBy'); if (g === 'customer' || g === 'user' || g === 'campaign' || g === 'none') setGroupBy(g);
    const s = store.get('sro:since'); if (s && ['any', 'today', 'yesterday', 'week', 'month'].includes(s)) setSince(s as Since);
  }, []);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const d = await fetch('/api/sales-returns', { cache: 'no-store' }).then(r => r.json());
      if (d.error) { setError(d.error); setRows([]); }
      else { setRows(d.rows || []); setWarnings(d.errors || []); setCommentsError(d.commentsError || null); }
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [selectedCompany]); // eslint-disable-line react-hooks/exhaustive-deps

  const key = (r: Sro) => `${r.company}|${r.no}`;
  const from = sinceDate(since);
  const newComments = (r: Sro) => (from ? r.comments.filter(c => dayOf(c) >= from).length : 0);
  const yesterday = sinceDate('yesterday');

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    const val = (r: Sro): string | number => {
      switch (sort.key) {
        case 'customer': return r.customerName.toLowerCase();
        case 'amount': return r.amount;
        case 'comments': return r.comments.length;
        case 'lastComment': return lastDay(r);
        default: return String((r as any)[sort.key] ?? '').toLowerCase();
      }
    };
    return rows
      .filter(r => !from || r.comments.some(c => dayOf(c) >= from))
      .filter(r => !term || [r.no, r.customerNo, r.customerName, r.externalDocumentNo, r.assignedUserId, r.campaignNo, r.xmlStatus, r.status, r.typeOfReturn, ...r.comments.map(c => c.text)]
        .some(v => v.toLowerCase().includes(term)))
      .sort((a, b) => {
        const x = val(a), y = val(b);
        if (x === y) return a.no.localeCompare(b.no);
        // vacíos siempre al final
        if (x === '') return 1; if (y === '') return -1;
        return (x < y ? -1 : 1) * sort.dir;
      });
  }, [rows, q, from, sort]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ label: '', rows: visible }];
    const label = (r: Sro) => groupBy === 'customer' ? `${r.customerName} (${r.customerNo})` : groupBy === 'user' ? r.assignedUserId : r.campaignNo;
    const m = new Map<string, Sro[]>();
    for (const r of visible) { const l = label(r); m.set(l, [...(m.get(l) || []), r]); }
    return Array.from(m.entries()).map(([label, rows]) => ({ label, rows }))
      .sort((a, b) => (!a.label ? 1 : !b.label ? -1 : a.label.localeCompare(b.label)));
  }, [visible, groupBy]);

  const money = (n: number, cur?: string) => n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur ? ` ${cur}` : '');
  const fmtDay = (d: string) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' }) : '');
  const fmtComment = (c: Comment) => c.date.length > 10
    ? new Date(c.date).toLocaleString(locale, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
    : fmtDay(c.date);
  const commentDays = (r: Sro) => Array.from(new Set(r.comments.map(dayOf))).sort().reverse();

  const withComments = rows.filter(r => r.comments.length).length;
  const recent = rows.filter(r => r.comments.some(c => dayOf(c) >= yesterday)).length;

  const toggleSort = (k: SortKey) => setSort(s => (s.key === k ? { key: k, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key: k, dir: k === 'lastComment' || k === 'comments' || k === 'amount' ? -1 : 1 }));
  const Th = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => (
    <th className={`px-3 py-2 font-bold whitespace-nowrap cursor-pointer select-none hover:text-teal-700 ${right ? 'text-right' : 'text-left'}`} onClick={() => toggleSort(k)}>
      <span className="inline-flex items-center gap-1">{t(label)}
        {sort.key === k ? (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-30" />}
      </span>
    </th>
  );

  const addComment = async (r: Sro) => {
    const text = (draft[key(r)] || '').trim();
    if (!text) return;
    const res = await fetch('/api/sales-returns/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company: r.company, no: r.no, text }) });
    const d = await res.json();
    if (!res.ok) { alert(t('Could not save the comment: {error}', { error: tx(String(d.error)) })); return; }
    setRows(prev => prev.map(x => (key(x) === key(r) ? { ...x, comments: [...x.comments, d] } : x)));
    setDraft(prev => ({ ...prev, [key(r)]: '' }));
  };
  const deleteComment = async (r: Sro, id: number) => {
    if (!confirm(t('Delete this comment?'))) return;
    const res = await fetch(`/api/cashflow/comments?id=${id}`, { method: 'DELETE' });
    if (!res.ok) { alert(t('Could not delete the comment')); return; }
    setRows(prev => prev.map(x => (key(x) === key(r) ? { ...x, comments: x.comments.filter(c => c.id !== id) } : x)));
  };

  const exportExcel = () => {
    const data = visible.map(r => ({
      ...(all ? { Company: companyLabel(r.company) } : {}),
      'No.': r.no, 'Customer No.': r.customerNo, Customer: r.customerName, 'External Document No.': r.externalDocumentNo,
      'Document Date': r.documentDate, 'Posting Date': r.postingDate, Status: r.status, 'Assigned User ID': r.assignedUserId,
      'Campaign No.': r.campaignNo, 'Type of Return': r.typeOfReturn, 'XML Status': r.xmlStatus, Amount: r.amount, Currency: r.currency,
      Comments: r.comments.length, 'Last comment': lastDay(r), 'Comment dates': commentDays(r).join(', '),
      'Comment texts': r.comments.map(c => `${dayOf(c)} ${c.author ? c.author + ': ' : ''}${c.text}`).join('\n'),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Sales Return Orders');
    XLSX.writeFile(wb, `Sales_Return_Orders_${selectedCompany}_${iso(new Date())}.xlsx`.replace(/\s+/g, '_'));
  };

  const cols = 13 + (all ? 1 : 0);
  return (
    <div className="w-full px-4 md:px-8 py-8">
      <h1 className="text-4xl font-black text-black mb-2">{t('Sales Return Orders')}</h1>
      <p className="text-gray-700 font-semibold text-sm mb-6">{t('Follow-up of every open Sales Return Order, with its comments')}</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          [t('Return orders'), rows.length.toLocaleString(locale)],
          [t('Amount (excl. VAT)'), money(rows.reduce((s, r) => s + r.amount, 0))],
          [t('With comments'), withComments.toLocaleString(locale)],
          [t('New comments since yesterday'), recent.toLocaleString(locale)],
        ].map(([l, v], i) => (
          <button key={l} onClick={() => i === 3 && setSince(s => { const n: Since = s === 'yesterday' ? 'any' : 'yesterday'; store.set('sro:since', n); return n; })}
            className={`text-left bg-white border rounded-xl p-4 shadow-sm ${i === 3 ? (since === 'yesterday' ? 'border-teal-500 ring-1 ring-teal-500' : 'border-gray-200 hover:border-teal-400') : 'border-gray-200 cursor-default'}`}>
            <div className="text-xs font-bold text-gray-500 uppercase">{l}</div>
            <div className={`text-2xl font-black ${i === 3 && recent ? 'text-sky-700' : 'text-gray-900'}`}>{v}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search…')}
            className="pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white w-64 focus:outline-none focus:border-teal-500" />
        </div>
        <label className="text-sm font-semibold text-gray-700 flex items-center gap-2">{t('Group by')}
          <select value={groupBy} onChange={e => { const v = e.target.value as GroupBy; setGroupBy(v); store.set('sro:groupBy', v); }}
            className="border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-sm">
            <option value="none">{t('No grouping')}</option>
            <option value="customer">{t('Customer')}</option>
            <option value="user">{t('Assigned User ID')}</option>
            <option value="campaign">{t('Campaign No.')}</option>
          </select>
        </label>
        <label className="text-sm font-semibold text-gray-700 flex items-center gap-2">{t('Comments added')}
          <select value={since} onChange={e => { const v = e.target.value as Since; setSince(v); store.set('sro:since', v); }}
            className="border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-sm">
            <option value="any">{t('Show all return orders')}</option>
            <option value="today">{t('Today')}</option>
            <option value="yesterday">{t('Since yesterday')}</option>
            <option value="week">{t('Last 7 days')}</option>
            <option value="month">{t('Last 30 days')}</option>
          </select>
        </label>
        <div className="flex-1" />
        <button onClick={exportExcel} disabled={!visible.length} className="flex items-center gap-1.5 px-3 py-2 text-sm font-bold rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50">
          <Download size={14} /> {t('Export Excel')}
        </button>
        <button onClick={load} disabled={loading} className="flex items-center gap-1.5 px-3 py-2 text-sm font-bold rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> {t('Reload from BC')}
        </button>
      </div>

      {error && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{tx(error)}</div>}
      {warnings.map(w => <div key={w} className="mb-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">{tx(w)}</div>)}
      {commentsError && (
        <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm flex gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>{tx(commentsError)} {t('Until then only the comments added here in the app are counted.')}</span>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-700 text-xs">
              <tr>
                <th className="w-6" />
                {all && <Th k="company" label="Company" />}
                <Th k="no" label="No." />
                <Th k="customer" label="Customer" />
                <Th k="externalDocumentNo" label="External Document No." />
                <Th k="documentDate" label="Document Date" />
                <Th k="status" label="Status" />
                <Th k="assignedUserId" label="Assigned User ID" />
                <Th k="campaignNo" label="Campaign No." />
                <Th k="typeOfReturn" label="Type of Return" />
                <Th k="xmlStatus" label="XML Status" />
                <Th k="amount" label="Amount" right />
                <Th k="comments" label="Comments" right />
                <Th k="lastComment" label="Comment dates" />
              </tr>
            </thead>
            <tbody>
              {loading && !rows.length ? (
                <tr><td colSpan={cols} className="p-6 text-center text-gray-500">{t('Loading…')}</td></tr>
              ) : !visible.length ? (
                <tr><td colSpan={cols} className="p-6 text-center text-gray-500">{t('No return orders')}</td></tr>
              ) : groups.map(g => (
                <Fragment key={g.label || '_'}>
                  {groupBy !== 'none' && (
                    <tr className="bg-teal-50 border-t border-teal-200">
                      <td colSpan={cols - 3} className="px-3 py-2 font-black text-teal-900">{g.label || t('(blank)')} <span className="font-semibold text-teal-700">· {t('{n} return orders', { n: g.rows.length })}</span></td>
                      <td className="px-3 py-2 text-right font-black text-teal-900 whitespace-nowrap">{money(g.rows.reduce((s, r) => s + r.amount, 0))}</td>
                      <td className="px-3 py-2 text-right font-bold text-teal-900">{g.rows.reduce((s, r) => s + r.comments.length, 0) || ''}</td>
                      <td />
                    </tr>
                  )}
                  {g.rows.map(r => {
                    const k = key(r);
                    const isOpen = !!open[k];
                    const days = commentDays(r);
                    const fresh = r.comments.some(c => dayOf(c) >= yesterday);
                    return (
                      <Fragment key={k}>
                        <tr className={`border-t border-gray-100 hover:bg-gray-50 cursor-pointer ${fresh ? 'bg-sky-50/60' : ''}`} onClick={() => setOpen(o => ({ ...o, [k]: !o[k] }))}>
                          <td className="pl-2 text-gray-400">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                          {all && <td className="px-3 py-2 whitespace-nowrap">{companyLabel(r.company)}</td>}
                          <td className="px-3 py-2 font-bold whitespace-nowrap">{r.no}</td>
                          <td className="px-3 py-2"><div className="font-semibold">{r.customerName}</div><div className="text-[11px] text-gray-500">{r.customerNo}</div></td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.externalDocumentNo}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.documentDate)}</td>
                          <td className="px-3 py-2"><span className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${r.status === 'Released' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-700'}`}>{r.status}</span></td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.assignedUserId}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.campaignNo}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.typeOfReturn}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.xmlStatus && <span className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${r.xmlStatus === 'Received' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}`}>{r.xmlStatus}</span>}</td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">{money(r.amount, r.currency)}</td>
                          <td className="px-3 py-2 text-right">
                            {r.comments.length > 0 && <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold ${fresh ? 'bg-sky-600 text-white' : 'bg-sky-100 text-sky-800'}`}><MessageSquare size={11} /> {r.comments.length}</span>}
                            {newComments(r) > 0 && since !== 'any' && <div className="text-[10px] text-sky-700 font-semibold">{t('{n} new', { n: newComments(r) })}</div>}
                          </td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap">
                            {days.slice(0, 3).map((d, i) => <span key={d} className={`${i ? 'text-gray-500' : 'font-bold'} ${d >= yesterday ? 'text-sky-700' : ''}`}>{i ? ', ' : ''}{fmtDay(d)}</span>)}
                            {days.length > 3 && <span className="text-gray-400"> +{days.length - 3}</span>}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-gray-50/70">
                            <td />
                            <td colSpan={cols - 1} className="px-3 py-3">
                              <div className="space-y-2 max-w-3xl">
                                {r.comments.length === 0 && <p className="text-xs text-gray-500">{t('No comments yet.')}</p>}
                                {[...r.comments].reverse().map((c, i) => (
                                  <div key={`${c.source}-${c.id ?? i}`} className="group/c bg-white border border-gray-200 rounded-lg px-3 py-2 flex justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-sm text-gray-900 whitespace-pre-wrap break-words">{c.text}</div>
                                      <div className="text-[11px] text-gray-500 mt-0.5">
                                        <span className={`mr-1 px-1 rounded font-bold ${c.source === 'bc' ? 'bg-indigo-100 text-indigo-800' : 'bg-teal-100 text-teal-800'}`}>{c.source === 'bc' ? 'BC' : 'App'}</span>
                                        {fmtComment(c)}{c.author ? ` · ${c.author}` : ''}
                                      </div>
                                    </div>
                                    {c.source === 'app' && c.id != null && (
                                      <button onClick={() => deleteComment(r, c.id!)} title={t('Delete comment')} className="opacity-0 group-hover/c:opacity-100 p-1 text-gray-400 hover:text-red-600 self-start"><Trash2 size={13} /></button>
                                    )}
                                  </div>
                                ))}
                                <div className="flex gap-2 pt-1">
                                  <input value={draft[k] || ''} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter') addComment(r); }} onClick={e => e.stopPropagation()}
                                    placeholder={t('Add a comment…')} className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:border-teal-500" />
                                  <button onClick={() => addComment(r)} disabled={!(draft[k] || '').trim()} className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-sm font-bold hover:bg-teal-700 disabled:opacity-50">{t('Add comment')}</button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
