'use client';

import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Download, RefreshCw, Send, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useT } from '@/contexts/LanguageContext';
import { useCompany } from '@/contexts/CompanyContext';

// EDEKA EDI: facturas a EDEKA (Bill-to EDEKA Zentralhandels) → mensaje TRANSUSXML con precios brutos, descuentos
// DI/EAB/TD escalonados a nivel de factura y FSDU con sus artículos como unidades de consumo. Vista previa, descarga
// del XML (para la pestaña Test de Transus) y envío por WebConnect con confirmación. Ver src/lib/edekaInvoice.ts.
type Row = { no: string; date: string; sellTo: string; sellToName: string; shipTo: string; orderNo: string; amount: number; amountInclVat: number; sent?: { at: string; by: string; transactionId: string; test: boolean } | null };
type Build = {
  no: string; xml: string; warnings: string[]; header: Record<string, string>;
  articles: { line: number; itemNo: string; gtin: string; code: string; description: string; kind: 'item' | 'display' | 'component'; parentGtin?: string; qty: number; grossPrice: number; netPriceBc?: number; amount: number; consumerUnits?: number }[];
  discounts: { code: string; pct: number; base: string; amount: number }[];
  totals: { lines: number; discounts: number; base: number; vat: number; total: number; vatPct: number };
  bc: { base: number; vat: number; total: number };
};

export default function EdekaInvoicesPage() {
  const { t, tx, locale } = useT();
  const { selectedCompany } = useCompany();
  const today = new Date().toISOString().substring(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().substring(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [builds, setBuilds] = useState<Record<string, Build | { error: string } | 'loading'>>({});
  const [test, setTest] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const [showXml, setShowXml] = useState(false);

  const n2 = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (d: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(locale) : '');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/edeka-invoices?from=${from}&to=${to}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRows(data.invoices || []);
    } catch (e: any) { setError(e.message || String(e)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [selectedCompany]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = async (no: string, force = false) => {
    if (open === no && !force) { setOpen(null); return; }
    setOpen(no); setShowXml(false);
    if (builds[no] && builds[no] !== 'loading' && !force) return;
    setBuilds(b => ({ ...b, [no]: 'loading' }));
    try {
      const res = await fetch(`/api/edeka-invoices?no=${encodeURIComponent(no)}&test=${test ? 1 : 0}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBuilds(b => ({ ...b, [no]: data }));
    } catch (e: any) { setBuilds(b => ({ ...b, [no]: { error: e.message || String(e) } })); }
  };

  // El XML descargado lleva IsTestMessage según la casilla (se pide de nuevo para que coincida)
  const download = async (no: string) => {
    const res = await fetch(`/api/edeka-invoices?no=${encodeURIComponent(no)}&test=${test ? 1 : 0}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) { alert(tx(data.error)); return; }
    const url = URL.createObjectURL(new Blob([data.xml], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = `EDEKA_${no}${test ? '_TEST' : ''}.xml`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const send = async (row: Row) => {
    const msg = (row.sent ? t('{no} was already sent to Transus on {date}.', { no: row.no, date: new Date(row.sent.at).toLocaleString(locale) }) + '\n\n' : '')
      + (test
        ? t('Send {no} to Transus as a TEST message (IsTestMessage = Y)?', { no: row.no })
        : t('Send {no} to Transus as a REAL invoice? Transus will forward it to EDEKA.', { no: row.no }));
    if (!confirm(msg)) return;
    setSending(row.no);
    try {
      const res = await fetch('/api/edeka-invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ no: row.no, test, confirm: true }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert(t('Sent to Transus. TransactionID: {id}', { id: data.transactionId }));
      load();
    } catch (e: any) { alert(t('Could not send: {error}', { error: tx(e.message || String(e)) })); } finally { setSending(null); }
  };

  const kindLabel = (k: string) => (k === 'display' ? t('Display (invoice unit)') : k === 'component' ? t('Consumer unit') : t('Item'));

  return (
    <div className="w-full px-4 md:px-8 py-8 space-y-4">
      <div>
        <h1 className="text-4xl font-black text-black mb-2">{t('EDEKA EDI')}</h1>
        <p className="text-gray-700 font-semibold text-sm">{t('EDEKA invoices from BC as Transus XML: gross prices, DI/EAB/TD discounts at invoice level and FSDU with their consumer units.')}</p>
      </div>

      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {t('The EDEKA Send Invoice process in Transus still uses the Transus Online data source. Until it is switched to Dynamics 365 Business Central, download the XML and check it in the Test tab; do not send real invoices.')}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-bold text-gray-700">{t('From')}<input type="date" value={from} onChange={e => setFrom(e.target.value)} className="block border border-gray-300 rounded px-2 py-1 text-sm" /></label>
        <label className="text-xs font-bold text-gray-700">{t('To')}<input type="date" value={to} onChange={e => setTo(e.target.value)} className="block border border-gray-300 rounded px-2 py-1 text-sm" /></label>
        <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm font-bold hover:bg-gray-50"><RefreshCw size={14} /> {t('Load')}</button>
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-800 ml-2">
          <input type="checkbox" checked={test} onChange={e => setTest(e.target.checked)} /> {t('Test message (IsTestMessage = Y)')}
        </label>
      </div>

      {error && <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{tx(error)}</div>}

      <div className="rounded-2xl border border-gray-200 bg-white shadow overflow-hidden">
        <div className="table-scroll">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-gray-700 font-semibold">
                <th className="p-3">{t('Invoice')}</th>
                <th className="p-3">{t('Date')}</th>
                <th className="p-3">{t('Customer')}</th>
                <th className="p-3">{t('Ship-to')}</th>
                <th className="p-3">{t('EDEKA order')}</th>
                <th className="p-3 text-right">{t('Amount excl. VAT')}</th>
                <th className="p-3">{t('Transus')}</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="p-6 text-center text-gray-500">{t('Loading…')}</td></tr>}
              {!loading && !rows.length && <tr><td colSpan={8} className="p-6 text-center text-gray-500">{t('No EDEKA invoices in this period.')}</td></tr>}
              {!loading && rows.map(r => {
                const b = builds[r.no];
                return (
                  <React.Fragment key={r.no}>
                    <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => preview(r.no)}>
                      <td className="p-3 font-bold text-gray-900 whitespace-nowrap">{open === r.no ? <ChevronDown size={14} className="inline" /> : <ChevronRight size={14} className="inline" />} {r.no}</td>
                      <td className="p-3">{fmtDate(r.date)}</td>
                      <td className="p-3">{r.sellTo} {r.sellToName}</td>
                      <td className="p-3 text-gray-700">{r.shipTo}</td>
                      <td className="p-3">{r.orderNo}</td>
                      <td className="p-3 text-right font-semibold">{n2(r.amount)}</td>
                      <td className="p-3 text-xs">{r.sent ? <span className="text-green-700 font-bold">{t('Sent {date}', { date: new Date(r.sent.at).toLocaleDateString(locale) })}{r.sent.test ? ` (${t('test')})` : ''}</span> : <span className="text-gray-500">{t('Not sent')}</span>}</td>
                      <td className="p-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                        <button onClick={() => download(r.no)} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 text-xs font-semibold hover:bg-gray-100 mr-1" title={t('Download XML')}><Download size={12} /> XML</button>
                        <button disabled={sending !== null} onClick={() => send(r)} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-indigo-200 text-indigo-800 text-xs font-semibold hover:bg-indigo-50 disabled:opacity-50"><Send size={12} /> {sending === r.no ? t('Sending…') : t('Send')}</button>
                      </td>
                    </tr>
                    {open === r.no && (
                      <tr className="bg-gray-50"><td colSpan={8} className="p-4">
                        {b === 'loading' && <div className="text-gray-500">{t('Building the message from BC…')}</div>}
                        {b && b !== 'loading' && 'error' in b && <div className="text-red-700">{tx(b.error)}</div>}
                        {b && b !== 'loading' && !('error' in b) && (
                          <div className="space-y-3">
                            {b.warnings.length > 0 ? (
                              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-1">
                                {b.warnings.map((w, i) => <div key={i} className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{tx(w)}</div>)}
                              </div>
                            ) : <div className="flex items-center gap-2 text-sm text-green-700 font-semibold"><CheckCircle2 size={14} /> {t('No warnings: totals match BC.')}</div>}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                              {Object.entries(b.header).map(([k, v]) => <div key={k}><span className="text-gray-500">{k}:</span> <span className="font-semibold text-gray-900">{v || '—'}</span></div>)}
                            </div>
                            <table className="w-full text-xs border-collapse bg-white rounded">
                              <thead><tr className="border-b border-gray-200 text-gray-600">
                                <th className="p-2 text-left">#</th><th className="p-2 text-left">{t('Item')}</th><th className="p-2 text-left">GTIN</th><th className="p-2 text-left">{t('Type')}</th>
                                <th className="p-2 text-right">{t('Quantity')}</th><th className="p-2 text-right">{t('Gross price')}</th><th className="p-2 text-right">{t('BC net price')}</th><th className="p-2 text-right">{t('Amount')}</th>
                              </tr></thead>
                              <tbody>
                                {b.articles.map(a => (
                                  <tr key={a.line} className={`border-b border-gray-100 ${a.kind === 'component' ? 'text-gray-600' : 'font-semibold'}`}>
                                    <td className="p-2">{a.line}</td>
                                    <td className={`p-2 ${a.kind === 'component' ? 'pl-6' : ''}`}>{a.code} · {a.description}</td>
                                    <td className="p-2">{a.gtin || <span className="text-red-600">—</span>}</td>
                                    <td className="p-2">{kindLabel(a.kind)}{a.consumerUnits ? ` · ${t('{n} consumer units', { n: a.consumerUnits })}` : ''}</td>
                                    <td className="p-2 text-right">{a.qty.toLocaleString(locale)}</td>
                                    <td className="p-2 text-right">{n2(a.grossPrice)}</td>
                                    <td className="p-2 text-right">{a.netPriceBc !== undefined ? a.netPriceBc.toLocaleString(locale, { maximumFractionDigits: 5 }) : ''}</td>
                                    <td className="p-2 text-right">{n2(a.amount)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div className="flex flex-wrap gap-6 text-sm">
                              <table className="text-sm">
                                <tbody>
                                  <tr><td className="pr-4 text-gray-600">{t('Lines (gross)')}</td><td className="text-right font-semibold">{n2(b.totals.lines)}</td></tr>
                                  {b.discounts.map((d, i) => <tr key={i}><td className="pr-4 text-gray-600">{d.code} {d.pct.toLocaleString(locale)} % ({d.base === 'gross' ? t('on gross') : t('on the rest')})</td><td className="text-right">−{n2(d.amount)}</td></tr>)}
                                  <tr className="border-t"><td className="pr-4 font-bold">{t('VAT base')}</td><td className="text-right font-bold">{n2(b.totals.base)}</td></tr>
                                  <tr><td className="pr-4 text-gray-600">{t('VAT')} {b.totals.vatPct} %</td><td className="text-right">{n2(b.totals.vat)}</td></tr>
                                  <tr><td className="pr-4 font-bold">{t('Invoice amount')}</td><td className="text-right font-bold">{n2(b.totals.total)}</td></tr>
                                </tbody>
                              </table>
                              <table className="text-sm">
                                <tbody>
                                  <tr><td className="pr-4 text-gray-600">{t('BC base')}</td><td className="text-right">{n2(b.bc.base)}</td></tr>
                                  <tr><td className="pr-4 text-gray-600">{t('BC VAT')}</td><td className="text-right">{n2(b.bc.vat)}</td></tr>
                                  <tr><td className="pr-4 text-gray-600">{t('BC total')}</td><td className="text-right">{n2(b.bc.total)}</td></tr>
                                  <tr><td className="pr-4 text-gray-600">{t('Difference')}</td><td className={`text-right font-bold ${Math.abs(b.totals.total - b.bc.total) > 0.005 ? 'text-red-600' : 'text-green-700'}`}>{n2(b.totals.total - b.bc.total)}</td></tr>
                                </tbody>
                              </table>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => setShowXml(s => !s)} className="px-2 py-1 rounded border border-gray-200 text-xs font-semibold hover:bg-gray-100">{showXml ? t('Hide XML') : t('Show XML')}</button>
                              <button onClick={() => preview(r.no, true)} className="px-2 py-1 rounded border border-gray-200 text-xs font-semibold hover:bg-gray-100">{t('Rebuild from BC')}</button>
                            </div>
                            {showXml && <pre className="text-xs bg-white border border-gray-200 rounded p-3 max-h-96 overflow-auto">{b.xml}</pre>}
                          </div>
                        )}
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
