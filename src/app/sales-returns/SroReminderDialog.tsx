'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle, Eye, Mail, Send, X } from 'lucide-react';
import { companyLabel } from '@/contexts/CompanyContext';
import { useT } from '@/contexts/LanguageContext';

// Recordatorio a un Assigned User de sus Sales Return Orders: se elige el usuario, se marcan sus SRO (agrupadas por
// empresa), se ve el correo tal cual saldría (vista previa montada en el servidor) y se envía desde invoice@.

export type ReminderSro = {
  company: string; no: string; customerName: string; externalDocumentNo: string; documentDate: string;
  assignedUserId: string; amount: number; currency: string; comments: { date: string }[];
  lastReminder?: { at: string; by: string; user: string } | null;
};
type User = { user: string; name: string; email: string };
type Preview = { to: string; name: string; from: string; subject: string; html: string };

const lcy = (company: string) => (/group ag/i.test(company) ? 'CHF' : /^craze uk$/i.test(company) ? 'GBP' : 'EUR');

export default function SroReminderDialog({ rows, presetUser, onClose, onSent }: {
  rows: ReminderSro[]; presetUser?: string; onClose: () => void;
  onSent: (user: string, sros: { company: string; no: string }[], at: string) => void;
}) {
  const { t, tx, lang, locale } = useT();
  const [info, setInfo] = useState<{ users: Record<string, User>; log: Record<string, { at: string; by: string; sros: number }> } | null>(null);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    fetch('/api/sales-returns/reminders').then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); setInfo(j); })
      .catch(e => setLoadError(e.message));
  }, []);

  const byUser = useMemo(() => {
    const m = new Map<string, ReminderSro[]>();
    for (const r of rows) if (r.assignedUserId) m.set(r.assignedUserId, [...(m.get(r.assignedUserId) || []), r]);
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);
  const [user, setUser] = useState(presetUser || '');
  const key = (r: ReminderSro) => `${r.company}|${r.no}`;
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.filter(r => presetUser && r.assignedUserId === presetUser).map(key)));
  const [note, setNote] = useState('');
  const [mailLang, setMailLang] = useState<'en' | 'es'>(lang === 'es' ? 'es' : 'en');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ email: string } | null>(null);

  const userOf = (u: string) => info?.users[u.toUpperCase()];
  const mine = useMemo(() => byUser.find(([u]) => u === user)?.[1] || [], [byUser, user]);
  const chosen = mine.filter(r => selected.has(key(r)));
  const companies = Array.from(new Set(mine.map(r => r.company)));
  const money = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (d: string) => (d ? new Date(d.length > 10 ? d : d + 'T00:00:00').toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' }) : '');

  const pickUser = (u: string) => { setUser(u); setSelected(new Set(rows.filter(r => r.assignedUserId === u).map(key))); setPreview(null); setSent(null); setError(''); };
  const toggle = (list: ReminderSro[], on: boolean) => setSelected(p => { const n = new Set(p); for (const r of list) { if (on) n.add(key(r)); else n.delete(key(r)); } return n; });

  const call = async (action: 'preview' | 'send') => {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/sales-returns/reminders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, user, note, lang: mailLang, sros: chosen.map(r => ({ company: r.company, no: r.no })) }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      return j;
    } catch (e: any) { setError(e.message); return null; } finally { setBusy(false); }
  };
  const showPreview = async () => { const j = await call('preview'); if (j) setPreview(j); };
  const send = async () => {
    if (!preview?.to) return;
    if (!confirm(t('Send this reminder about {n} return orders to {email} from invoice@?', { n: chosen.length, email: preview.to }))) return;
    const j = await call('send');
    if (j) { setSent({ email: j.email }); onSent(user, chosen.map(r => ({ company: r.company, no: r.no })), j.at); }
  };

  const u = user ? userOf(user) : undefined;
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex justify-center items-start p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-6xl shadow-2xl my-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="font-bold text-gray-900 flex items-center gap-2"><Mail size={18} /> {t('Remind assigned users')}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100"><X size={18} /></button>
        </div>

        {preview ? (
          <div className="p-5 space-y-3">
            <div className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-sm">
              <span className="text-gray-500">{t('From')}</span><span className="font-semibold">{preview.from}</span>
              <span className="text-gray-500">{t('To')}</span>
              <span className={`font-semibold ${preview.to ? '' : 'text-red-600'}`}>{preview.to ? `${preview.name} <${preview.to}>` : t('{user} has no e-mail in BC', { user })}</span>
              <span className="text-gray-500">{t('Subject')}</span><span className="font-semibold">{preview.subject}</span>
            </div>
            <iframe title="preview" srcDoc={preview.html} sandbox="" className="w-full h-[55vh] border border-gray-200 rounded-lg bg-white" />
          </div>
        ) : (
          <div className="p-5 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-5">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">{t('Assigned users')}</p>
              {loadError && <p className="text-xs text-red-700 mb-2">{tx(loadError)}</p>}
              <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
                {byUser.map(([id, list]) => {
                  const a = userOf(id);
                  const last = info?.log[id.toUpperCase()] || info?.log[id];
                  return (
                    <label key={id} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer ${user === id ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                      <input type="radio" name="sro-user" className="mt-1" checked={user === id} onChange={() => pickUser(id)} />
                      <span className="text-sm leading-tight min-w-0">
                        <span className="font-semibold text-gray-900">{a?.name || id}</span>
                        <span className="block text-[11px] text-gray-500">{t('{n} return orders', { n: list.length })}</span>
                        <span className={`block text-[11px] truncate ${info && !a?.email ? 'text-red-600' : 'text-gray-400'}`}>{info ? (a?.email || t('no e-mail in BC')) : '…'}</span>
                        {last && <span className="block text-[11px] text-amber-700">{t('Last reminder {date}', { date: new Date(last.at).toLocaleDateString(locale) })}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="min-w-0">
              {!user ? (
                <p className="text-sm text-gray-500 py-10 text-center">{t('Choose an assigned user on the left.')}</p>
              ) : (
                <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
                  {companies.map(c => {
                    const list = mine.filter(r => r.company === c);
                    const allOn = list.every(r => selected.has(key(r))), someOn = list.some(r => selected.has(key(r)));
                    return (
                      <div key={c} className="border border-gray-200 rounded-xl">
                        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200 rounded-t-xl">
                          <label className="inline-flex items-center gap-2 font-semibold text-gray-900 cursor-pointer">
                            <input type="checkbox" checked={allOn} ref={el => { if (el) el.indeterminate = someOn && !allOn; }} onChange={() => toggle(list, !allOn)} />
                            {companyLabel(c)}
                          </label>
                          <span className="text-xs text-gray-500">{t('{n} of {m} selected', { n: list.filter(r => selected.has(key(r))).length, m: list.length })}</span>
                        </div>
                        <table className="w-full text-xs">
                          <tbody>
                            {list.map(r => {
                              const on = selected.has(key(r));
                              const lastNote = r.comments.length ? r.comments.map(x => x.date).sort().at(-1)! : '';
                              return (
                                <tr key={r.no} onClick={() => toggle([r], !on)} className={`border-t border-gray-50 cursor-pointer hover:bg-gray-50 ${on ? 'text-gray-800' : 'text-gray-400'}`}>
                                  <td className="pl-3 pr-2 py-1"><input type="checkbox" checked={on} readOnly /></td>
                                  <td className="px-2 py-1 font-mono font-semibold whitespace-nowrap">{r.no}</td>
                                  <td className="px-2 py-1">{r.customerName}</td>
                                  <td className="px-2 py-1 whitespace-nowrap">{r.externalDocumentNo}</td>
                                  <td className="px-2 py-1 whitespace-nowrap">{day(r.documentDate)}</td>
                                  <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{money(r.amount)} {r.currency || lcy(r.company)}</td>
                                  <td className="px-2 py-1 whitespace-nowrap text-gray-500">{lastNote ? t('note {date}', { date: day(lastNote) }) : ''}</td>
                                  <td className="px-2 py-1 whitespace-nowrap text-amber-700">{r.lastReminder ? t('reminded {date}', { date: day(r.lastReminder.at) }) : ''}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="mt-4 grid grid-cols-1 md:grid-cols-[1fr_160px] gap-3">
                <label className="block text-xs font-semibold text-gray-500">{t('Note added to the e-mail (optional)')}
                  <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-normal text-gray-900" />
                </label>
                <label className="block text-xs font-semibold text-gray-500">{t('E-mail language')}
                  <select value={mailLang} onChange={e => setMailLang(e.target.value as 'en' | 'es')} className="mt-1 block w-full border border-gray-300 rounded-lg px-2 py-2 text-sm font-normal text-gray-900 bg-white">
                    <option value="en">English</option>
                    <option value="es">Español</option>
                  </select>
                </label>
              </div>
            </div>
          </div>
        )}

        {(error || sent) && (
          <div className="px-5 pb-3">
            {error && <p className="text-sm text-red-700 flex items-center gap-2"><X size={14} /> {tx(error)}</p>}
            {sent && <p className="text-sm text-emerald-700 flex items-center gap-2"><CheckCircle size={14} /> {t('Sent to {user} ({email})', { user: u?.name || user, email: sent.email })}</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4 border-t border-gray-200">
          <span className="mr-auto text-xs text-gray-500">{t('One e-mail to the assigned user from {mailbox}, with the selected return orders and their company.', { mailbox: 'invoice@craze-group.com' })}</span>
          {preview ? (
            <>
              <button onClick={() => { setPreview(null); setSent(null); }} className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold"><ArrowLeft size={15} /> {t('Back')}</button>
              <button onClick={send} disabled={busy || !preview.to || !!sent}
                className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-black disabled:opacity-40">
                <Send size={15} /> {busy ? t('Sending…') : sent ? t('Sent') : t('Send e-mail')}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold">{t('Close')}</button>
              <button onClick={showPreview} disabled={busy || !user || !chosen.length}
                className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-black disabled:opacity-40">
                <Eye size={15} /> {busy ? t('Loading…') : t('Preview e-mail ({n} return orders)', { n: chosen.length })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
