'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle, Mail, Send, X } from 'lucide-react';
import { useT } from '@/contexts/LanguageContext';

// Recordatorio a los aprobadores pendientes (Pending Approval): se eligen los aprobadores y, para cada uno, sus
// documentos pendientes por proveedor, con checks para quitar proveedores o facturas. Un documento con varios
// aprobadores pendientes sale con cada uno: se elige a quién se le reclama dejándolo marcado solo con ese.
// preset: aprobadores y/o documentos ya marcados al abrir (desde un grupo o una factura).

export type PendingDoc = {
  entryNo: number; vendorNo: string; vendorName: string; docType: string; docNo: string; extDocNo: string;
  postingDate: string; dueDate: string; remaining: number; remainingLCY: number | null; currency: string; approvalPct: number; pendingUsers: string;
};
type Approver = { user: string; name: string; email: string };
type Log = Record<string, { at: string; by: string; docs: number }>;

const usersOf = (d: PendingDoc) => d.pendingUsers.split('|').map(u => u.trim()).filter(Boolean);
const dateFmt = (d: string) => (d ? d.substring(0, 10).split('-').reverse().join('/') : '');

export default function ApproverReminderDialog({ docs, preset, lcy, onClose }: {
  docs: PendingDoc[]; preset: { users?: string[]; entryNos?: number[] }; lcy: string; onClose: () => void;
}) {
  const { t, tx, locale } = useT();
  const money = (v: number | null) => (v == null ? '—' : v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const [info, setInfo] = useState<{ approvers: Record<string, Approver>; log: Log } | null>(null);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    fetch('/api/payment-proposal/approvers').then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); setInfo(j); })
      .catch(e => setLoadError(e.message));
  }, []);

  // Aprobadores con lo que tienen pendiente
  const byUser = useMemo(() => {
    const m = new Map<string, PendingDoc[]>();
    for (const d of docs) for (const u of usersOf(d)) m.set(u, [...(m.get(u) || []), d]);
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [docs]);
  const onlyDocs = preset.entryNos?.length ? new Set(preset.entryNos) : null;
  const [users, setUsers] = useState<Set<string>>(() => new Set(preset.users?.length ? preset.users
    : onlyDocs ? docs.filter(d => onlyDocs.has(d.entryNo)).flatMap(usersOf) : []));
  // Documentos quitados por aprobador ('USER|entryNo')
  const [off, setOff] = useState<Set<string>>(() => {
    if (!onlyDocs) return new Set();
    const s = new Set<string>();
    for (const d of docs) if (!onlyDocs.has(d.entryNo)) for (const u of usersOf(d)) s.add(`${u}|${d.entryNo}`);
    return s;
  });
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<{ user: string; ok: boolean; email?: string; error?: string }[] | null>(null);

  const toggleUser = (u: string) => setUsers(p => { const n = new Set(p); if (n.has(u)) n.delete(u); else n.add(u); return n; });
  const isOn = (u: string, d: PendingDoc) => !off.has(`${u}|${d.entryNo}`);
  const setDocs = (u: string, list: PendingDoc[], on: boolean) => setOff(p => {
    const n = new Set(p);
    for (const d of list) { const k = `${u}|${d.entryNo}`; if (on) n.delete(k); else n.add(k); }
    return n;
  });
  const chosen = byUser.filter(([u]) => users.has(u)).map(([u, list]) => ({ user: u, docs: list.filter(d => isOn(u, d)) })).filter(r => r.docs.length);

  const send = async () => {
    const noMail = chosen.filter(r => !info?.approvers[r.user]?.email).map(r => r.user);
    if (noMail.length && !confirm(t('{list} have no e-mail in BC and will be skipped. Continue?', { list: noMail.join(', ') }))) return;
    if (!confirm(t('Send {n} reminder e-mail(s) to the approvers from invoice@?', { n: chosen.length }))) return;
    setSending(true);
    try {
      const res = await fetch('/api/payment-proposal/remind', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note, reminders: chosen.map(r => ({ user: r.user, docs: r.docs.map(d => ({ vendorName: d.vendorName, vendorNo: d.vendorNo, docType: d.docType, docNo: d.docNo, extDocNo: d.extDocNo, postingDate: d.postingDate, dueDate: d.dueDate, remaining: d.remaining, currency: d.currency, approvalPct: d.approvalPct })) })) }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setResults(j.results);
      fetch('/api/payment-proposal/approvers').then(r => r.json()).then(j2 => j2.approvers && setInfo(j2)).catch(() => {});
    } catch (e: any) {
      setResults([{ user: '', ok: false, error: e.message }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex justify-center items-start p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-5xl shadow-2xl my-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="font-bold text-gray-900 flex items-center gap-2"><Mail size={18} /> {t('Remind approvers')}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100"><X size={18} /></button>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-[280px_1fr] gap-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">{t('Approvers with pending documents')}</p>
            {loadError && <p className="text-xs text-red-700 mb-2">{tx(loadError)}</p>}
            <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
              {byUser.map(([u, list]) => {
                const a = info?.approvers[u];
                const last = info?.log[u];
                return (
                  <label key={u} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer ${users.has(u) ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                    <input type="checkbox" className="mt-1" checked={users.has(u)} onChange={() => toggleUser(u)} />
                    <span className="text-sm leading-tight">
                      <span className="font-semibold text-gray-900">{a?.name || u}</span>
                      <span className="block text-[11px] text-gray-500">{t('{n} documents', { n: list.length })} · {money(list.reduce((s, d) => s + (d.remainingLCY || 0), 0))} {lcy}</span>
                      <span className={`block text-[11px] ${a && !a.email ? 'text-red-600' : 'text-gray-400'}`}>{info ? (a?.email || t('no e-mail in BC')) : '…'}</span>
                      {last && <span className="block text-[11px] text-amber-700">{t('Last reminder {date}', { date: new Date(last.at).toLocaleDateString(locale) })}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="min-w-0">
            {!users.size ? (
              <p className="text-sm text-gray-500 py-10 text-center">{t('Tick one or more approvers on the left.')}</p>
            ) : (
              <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
                {byUser.filter(([u]) => users.has(u)).map(([u, list]) => {
                  const vendors = Array.from(list.reduce((m, d) => m.set(d.vendorName, [...(m.get(d.vendorName) || []), d]), new Map<string, PendingDoc[]>()).entries()).sort((a, b) => a[0].localeCompare(b[0]));
                  const count = list.filter(d => isOn(u, d)).length;
                  return (
                    <div key={u} className="border border-gray-200 rounded-xl">
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200 rounded-t-xl">
                        <p className="font-semibold text-gray-900">{info?.approvers[u]?.name || u}</p>
                        <span className="text-xs text-gray-500">{t('{n} of {m} documents selected', { n: count, m: list.length })}</span>
                        <span className="ml-auto flex gap-2 text-xs">
                          <button onClick={() => setDocs(u, list, true)} className="underline text-gray-600 hover:text-black">{t('Select all')}</button>
                          <button onClick={() => setDocs(u, list, false)} className="underline text-gray-600 hover:text-black">{t('Deselect all')}</button>
                        </span>
                      </div>
                      <table className="w-full text-xs">
                        <tbody>
                          {vendors.map(([vendor, vdocs]) => {
                            const allOn = vdocs.every(d => isOn(u, d)), someOn = vdocs.some(d => isOn(u, d));
                            return (
                              <React.Fragment key={vendor}>
                                <tr className="border-t border-gray-100 bg-white">
                                  <td className="px-3 py-1.5" colSpan={6}>
                                    <label className="inline-flex items-center gap-2 font-semibold text-gray-800 cursor-pointer">
                                      <input type="checkbox" checked={allOn} ref={el => { if (el) el.indeterminate = someOn && !allOn; }} onChange={() => setDocs(u, vdocs, !allOn)} />
                                      {vendor} <span className="font-normal text-gray-400">({vdocs.length})</span>
                                    </label>
                                  </td>
                                </tr>
                                {vdocs.map(d => {
                                  const others = usersOf(d).filter(x => x !== u);
                                  return (
                                    <tr key={d.entryNo} className={`border-t border-gray-50 ${isOn(u, d) ? 'text-gray-800' : 'text-gray-400'}`}>
                                      <td className="pl-9 pr-2 py-1"><input type="checkbox" checked={isOn(u, d)} onChange={() => setDocs(u, [d], !isOn(u, d))} /></td>
                                      <td className="px-2 py-1 font-mono whitespace-nowrap">{d.docNo}</td>
                                      <td className="px-2 py-1">{d.extDocNo}</td>
                                      <td className="px-2 py-1 whitespace-nowrap">{t('due {date}', { date: dateFmt(d.dueDate) })}</td>
                                      <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{money(d.remaining)} {d.currency}</td>
                                      <td className="px-2 py-1 text-[11px] text-indigo-700">{others.length ? t('also pending: {list}', { list: others.map(x => info?.approvers[x]?.name || x).join(', ') }) : ''}</td>
                                    </tr>
                                  );
                                })}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            )}
            <label className="block mt-4 text-xs font-semibold text-gray-500">{t('Note added to the e-mail (optional)')}
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-normal text-gray-900" />
            </label>
          </div>
        </div>

        {results && (
          <div className="px-5 pb-3 space-y-1">
            {results.map((r, i) => (
              <p key={i} className={`text-sm flex items-center gap-2 ${r.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                {r.ok ? <CheckCircle size={14} /> : <X size={14} />}
                {r.ok ? t('Sent to {user} ({email})', { user: info?.approvers[r.user]?.name || r.user, email: r.email || '' }) : `${r.user ? `${r.user}: ` : ''}${tx(r.error || '')}`}
              </p>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4 border-t border-gray-200">
          <span className="mr-auto text-xs text-gray-500">{t('One e-mail per approver from {mailbox}, with the selected documents.', { mailbox: 'invoice@craze-group.com' })}</span>
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold">{t('Close')}</button>
          <button onClick={send} disabled={sending || !chosen.length}
            className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-black disabled:opacity-40">
            <Send size={15} /> {sending ? t('Sending…') : t('Send {n} e-mail(s)', { n: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
