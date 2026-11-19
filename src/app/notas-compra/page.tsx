'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, MessageSquareText, CheckCheck, Undo2, Search } from 'lucide-react';
import DocPdfLink from '@/components/DocPdfLink';
import { useCompany } from '@/contexts/CompanyContext';
import { useT } from '@/contexts/LanguageContext';

type Note = {
  linkId: string; docType: 'invoice' | 'credit'; posted: boolean; documentNo: string; vendorNo: string; vendorName: string;
  created: string; userId: string; toUserId: string; text: string; read: { by: string; at: string } | null;
};

const fmtDate = (iso: string, locale: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const docLabel = (n: Note) => (n.docType === 'credit' ? (n.posted ? 'Posted credit memo' : 'Credit memo') : (n.posted ? 'Posted invoice' : 'Invoice'));

// Notas de compra: las Notes de BC en facturas/abonos de compra, en orden cronológico, con check de leída
export default function PurchaseNotesPage() {
  const { selectedCompany } = useCompany();
  const { t, tx, locale } = useT();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notPublished, setNotPublished] = useState(false);
  const [show, setShow] = useState<'unread' | 'all' | 'read'>('unread');
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const load = async (force = false) => {
    setLoading(true); setError(null); setNotPublished(false);
    try {
      const d = await fetch(`/api/purchase-notes${force ? '?force=1' : ''}`, { cache: 'no-store' }).then(r => r.json());
      if (d.error) { setError(d.error); setNotPublished(!!d.notPublished); setNotes([]); }
      else setNotes(d.notes || []);
      setSelected(new Set());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (selectedCompany !== 'ALL') load(); }, [selectedCompany]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return notes
      .filter(n => show === 'all' || (show === 'read' ? !!n.read : !n.read))
      .filter(n => !term || [n.documentNo, n.vendorNo, n.vendorName, n.text, n.userId, n.toUserId].some(v => v.toLowerCase().includes(term)))
      .sort((a, b) => (order === 'desc' ? b.created.localeCompare(a.created) : a.created.localeCompare(b.created)));
  }, [notes, show, order, q]);
  const unread = notes.filter(n => !n.read).length;
  const allSelected = visible.length > 0 && visible.every(n => selected.has(n.linkId));

  const toggle = (id: string) => setSelected(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map(n => n.linkId)));

  const mark = async (ids: string[], read: boolean) => {
    if (!ids.length) return;
    setSaving(true);
    try {
      const res = await fetch('/api/purchase-notes', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linkIds: ids, read }) });
      if (!res.ok) throw new Error((await res.json()).error || t('Error saving'));
      const at = new Date().toISOString();
      setNotes(prev => prev.map(n => (ids.includes(n.linkId) ? { ...n, read: read ? { by: t('me'), at } : null } : n)));
      setSelected(new Set());
    } catch (e: any) {
      alert(tx(e.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <main className="w-full px-4 md:px-8 pt-6 space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black text-black tracking-tight flex items-center gap-2"><MessageSquareText /> {t('Purchase notes')}</h1>
            <p className="text-gray-500 mt-1 text-sm">{t('Notes on purchase invoices and credit memos in Business Central ({company}) · {n} unread', { company: selectedCompany, n: unread })}</p>
          </div>
          <button onClick={() => load(true)} disabled={loading}
            className="inline-flex items-center gap-2 bg-black text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-gray-800 disabled:opacity-60">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> {t('Refresh from BC')}
          </button>
        </header>

        {selectedCompany === 'ALL' && <div className="bg-white border rounded-lg p-4 text-sm text-gray-600">{t('Select a company to see its notes.')}</div>}

        {error && (
          <div className={`rounded-lg border px-4 py-3 text-sm ${notPublished ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-red-50 border-red-200 text-red-800'}`}>
            {tx(error)}
            {notPublished && <p className="mt-1">{t('The API page')} <b>recordLinks</b> {t('on the Record Link table, with the note text, must be published in the BC custom API (craze/integrations v1.0).')}</p>}
          </div>
        )}

        {!error && selectedCompany !== 'ALL' && (
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
            <div className="flex flex-wrap items-center gap-3 p-3 border-b border-gray-200">
              <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                {([['unread', 'Unread'], ['all', 'All notes'], ['read', 'Read notes']] as const).map(([k, l]) => (
                  <button key={k} onClick={() => { setShow(k); setSelected(new Set()); }}
                    className={`px-3 py-1.5 ${show === k ? 'bg-black text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>{t(l)}</button>
                ))}
              </div>
              <select value={order} onChange={e => setOrder(e.target.value as any)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm">
                <option value="desc">{t('Newest first')}</option>
                <option value="asc">{t('Oldest first')}</option>
              </select>
              <div className="relative">
                <Search size={14} className="absolute left-2 top-2.5 text-gray-400" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search document, vendor, text…')}
                  className="border border-gray-200 rounded-lg pl-7 pr-2 py-1.5 text-sm w-72" />
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-sm text-gray-500">{t('{n} selected', { n: selected.size })}</span>
                <button onClick={() => mark([...selected], true)} disabled={!selected.size || saving}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 text-white disabled:opacity-40">
                  <CheckCheck size={15} /> {t('Mark as read')}
                </button>
                <button onClick={() => mark([...selected], false)} disabled={!selected.size || saving}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 disabled:opacity-40">
                  <Undo2 size={15} /> {t('Mark as unread')}
                </button>
              </div>
            </div>

            <div className="table-scroll">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="p-2 w-8"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                    <th className="p-2 text-left">{t('Date')}</th>
                    <th className="p-2 text-left">{t('Document')}</th>
                    <th className="p-2 text-left">{t('No.')}</th>
                    <th className="p-2 text-left">{t('Vendor')}</th>
                    <th className="p-2 text-left">{t('Note')}</th>
                    <th className="p-2 text-left">{t('Author')}</th>
                    <th className="p-2 text-left">{t('To')}</th>
                    <th className="p-2 text-center">{t('Read')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={9} className="p-6 text-center text-gray-400">{t('Loading notes from BC…')}</td></tr>}
                  {!loading && !visible.length && <tr><td colSpan={9} className="p-6 text-center text-gray-400">{show === 'unread' ? t('There are no unread notes.') : t('There are no notes.')}</td></tr>}
                  {!loading && visible.map(n => (
                    <tr key={n.linkId} className={`border-t border-gray-100 align-top ${n.read ? 'text-gray-400' : 'text-gray-900'} ${selected.has(n.linkId) ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                      <td className="p-2"><input type="checkbox" checked={selected.has(n.linkId)} onChange={() => toggle(n.linkId)} /></td>
                      <td className="p-2 whitespace-nowrap">{fmtDate(n.created, locale)}</td>
                      <td className="p-2 whitespace-nowrap">{t(docLabel(n))}</td>
                      <td className="p-2 whitespace-nowrap font-mono">{n.documentNo}<DocPdfLink documentNo={n.documentNo} kind={n.docType === 'credit' ? 'purchCrMemo' : 'purchInv'} /></td>
                      <td className="p-2">{n.vendorName || n.vendorNo}</td>
                      <td className={`p-2 whitespace-pre-wrap max-w-xl ${n.read ? '' : 'font-medium'}`}>{n.text || <span className="italic text-gray-400">{t('(no text)')}</span>}</td>
                      <td className="p-2 whitespace-nowrap">{n.userId}</td>
                      <td className="p-2 whitespace-nowrap">{n.toUserId}</td>
                      <td className="p-2 text-center whitespace-nowrap">
                        <input type="checkbox" checked={!!n.read} disabled={saving} onChange={() => mark([n.linkId], !n.read)}
                          title={n.read ? t('Read by {by} on {date}', { by: n.read.by, date: fmtDate(n.read.at, locale) }) : t('Mark this note as read')} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
