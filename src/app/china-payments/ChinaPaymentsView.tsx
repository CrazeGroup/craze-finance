'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, X, Calendar, Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useT } from '@/contexts/LanguageContext';
import DocPdfLink, { purchasePdfKind } from '@/components/DocPdfLink';

// Previsión de pagos a China (CHINA TRF): proveedor → pago (Scheduled Payment Date, vacía = To be confirmed) → facturas.
// Cambiar la fecha de un pago o de una factura la escribe en BC (Vendor Ledger Entries, Scheduled Payment Date).
type Entry = {
  entryNo: number; vendorNo: string; vendorName: string; documentType: string; documentNo: string; externalDocumentNo: string;
  postingDate: string; dueDate: string; currencyCode: string; remainingAmount: number; remainingAmtLCY: number; scheduledDate: string | null;
};
const TBC = '';

export default function ChinaPaymentsView() {
  const { t, locale } = useT();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [company, setCompany] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [openVendors, setOpenVendors] = useState<Record<string, boolean>>({});
  const [openPayments, setOpenPayments] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/china-payments', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEntries(data.entries || []); setCompany(data.company || '');
    } catch (e: any) { setError(e.message || String(e)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const today = new Date().toISOString().substring(0, 10);
  const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(locale);
  const eur = (v: number) => `€${v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Proveedor (mayor importe primero) → pagos (To be confirmed primero, luego por fecha) → facturas
  const vendors = useMemo(() => {
    const map = new Map<string, { vendorNo: string; name: string; total: number; payments: Map<string, Entry[]> }>();
    for (const e of entries) {
      if (!map.has(e.vendorNo)) map.set(e.vendorNo, { vendorNo: e.vendorNo, name: e.vendorName, total: 0, payments: new Map() });
      const v = map.get(e.vendorNo)!;
      v.total += e.remainingAmtLCY;
      const key = e.scheduledDate || TBC;
      if (!v.payments.has(key)) v.payments.set(key, []);
      v.payments.get(key)!.push(e);
    }
    return Array.from(map.values()).sort((a, b) => a.total - b.total).map(v => ({
      ...v,
      payments: Array.from(v.payments.entries()).sort(([a], [b]) => (a === TBC ? -1 : b === TBC ? 1 : a < b ? -1 : 1))
        .map(([date, list]) => ({ date, list: list.sort((x, y) => x.dueDate < y.dueDate ? -1 : 1), total: list.reduce((s, e) => s + e.remainingAmtLCY, 0) })),
    }));
  }, [entries]);
  const grandTotal = entries.reduce((s, e) => s + e.remainingAmtLCY, 0);
  // Total por fecha de pago, todos los proveedores
  const byDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.scheduledDate || TBC, (m.get(e.scheduledDate || TBC) || 0) + e.remainingAmtLCY);
    return Array.from(m.entries()).sort(([a], [b]) => (a === TBC ? -1 : b === TBC ? 1 : a < b ? -1 : 1));
  }, [entries]);

  // Escribe la fecha en BC para esas facturas (null = vaciar → To be confirmed)
  const setDate = async (list: Entry[], date: string | null, key: string) => {
    const what = list.length === 1 ? (list[0].externalDocumentNo || list[0].documentNo) : t('{n} invoices', { n: list.length });
    const msg = date
      ? t('Set the Scheduled Payment Date of {what} to {date} in Business Central?', { what, date: fmtDate(date) })
      : t('Clear the Scheduled Payment Date of {what} in Business Central (To be confirmed)?', { what });
    if (!confirm(msg)) return;
    setSaving(key);
    try {
      const res = await fetch('/api/china-payments', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryNos: list.map(e => e.entryNo), date, docs: list.map(e => e.documentNo) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const failed = (data.results || []).filter((r: any) => !r.ok);
      if (failed.length) alert(t('{n} could not be changed in BC:', { n: failed.length }) + '\n' + failed.map((r: any) => `${list.find(e => e.entryNo === r.entryNo)?.documentNo}: ${r.error}`).join('\n'));
      const okIds = new Set((data.results || []).filter((r: any) => r.ok).map((r: any) => r.entryNo));
      setEntries(prev => prev.map(e => okIds.has(e.entryNo) ? { ...e, scheduledDate: date } : e));
    } catch (e: any) {
      alert(t('Could not change the date: {error}', { error: e.message || e }));
    } finally { setSaving(null); }
  };

  const exportExcel = () => {
    const rows = vendors.flatMap(v => v.payments.flatMap(p => p.list.map(e => ({
      [t('Vendor')]: `${e.vendorNo} ${e.vendorName}`,
      [t('Payment date')]: p.date ? fmtDate(p.date) : t('To be confirmed'),
      [t('Vendor Invoice No.')]: e.externalDocumentNo, [t('Document')]: e.documentNo, [t('Type')]: e.documentType,
      [t('Posting Date')]: e.postingDate ? fmtDate(e.postingDate) : '', [t('Due Date')]: e.dueDate ? fmtDate(e.dueDate) : '',
      [t('Currency')]: e.currencyCode || 'EUR', [t('Remaining')]: e.remainingAmount, [t('Remaining (EUR)')]: e.remainingAmtLCY,
    }))));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'China payments');
    XLSX.writeFile(wb, `China_payments_${company}_${today}.xlsx`.replace(/\s+/g, '_'));
  };

  const dateLabel = (d: string) => d ? fmtDate(d) : t('To be confirmed');
  const dateClass = (d: string) => !d ? 'text-gray-700' : d <= today ? 'text-red-600' : 'text-gray-900';

  // Selector de fecha + vaciar, para un pago (todas sus facturas) o una factura. "Change date" abre un campo de
  // fecha visible con OK (un input de fecha invisible encima del botón no abre el calendario en Chrome).
  const [editing, setEditing] = useState<{ k: string; value: string } | null>(null);
  const renderDateEditor = (list: Entry[], value: string, k: string) => (
    <span className="inline-flex items-center gap-1" onClick={e => e.stopPropagation()}>
      {editing?.k === k ? (
        <>
          <input type="date" autoFocus value={editing.value}
            onChange={e => setEditing({ k, value: e.target.value })}
            onKeyDown={e => {
              if (e.key === 'Enter' && editing.value && editing.value !== value) { setEditing(null); setDate(list, editing.value, k); }
              if (e.key === 'Escape') setEditing(null);
            }}
            className="border border-indigo-300 rounded px-1.5 py-0.5 text-xs text-gray-900" />
          <button disabled={!editing.value || editing.value === value}
            onClick={() => { const v = editing.value; setEditing(null); setDate(list, v, k); }}
            className="px-2 py-0.5 rounded bg-indigo-600 text-white text-xs font-bold disabled:opacity-40">OK</button>
          <button onClick={() => setEditing(null)} className="p-1 rounded text-gray-500 hover:bg-gray-100" title={t('Cancel')}><X size={12} /></button>
        </>
      ) : (
        <>
          <button disabled={saving !== null} onClick={() => setEditing({ k, value: value || today })}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-xs font-semibold ${saving === k ? 'opacity-50' : 'hover:bg-indigo-50 border-indigo-200 text-indigo-800'}`}
            title={t('Change the Scheduled Payment Date in BC')}>
            <Calendar size={12} /> {saving === k ? t('Saving…') : t('Change date')}
          </button>
          {value && (
            <button disabled={saving !== null} onClick={() => setDate(list, null, k)} className="p-1 rounded text-gray-500 hover:text-red-600 hover:bg-red-50" title={t('Clear the date (To be confirmed)')}>
              <X size={12} />
            </button>
          )}
        </>
      )}
    </span>
  );

  if (loading) return <div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-teal-400"></div></div>;
  if (error) return <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{t('Could not read the CHINA TRF entries from BC: {error}', { error })}</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-700 font-semibold">
          {t('Open vendor entries with payment method CHINA TRF, grouped by Scheduled Payment Date (live from BC). Changing a date updates it in Vendor Ledger Entries.')}
        </p>
        <div className="flex gap-2">
          <button onClick={exportExcel} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm font-bold hover:bg-gray-50"><Download size={14} /> {t('Export Excel')}</button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm font-bold hover:bg-gray-50"><RefreshCw size={14} /> {t('Reload from BC')}</button>
        </div>
      </div>

      {/* Pagos por fecha (todos los proveedores) */}
      <div className="flex flex-wrap gap-2">
        {byDate.map(([d, total]) => (
          <div key={d || 'tbc'} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
            <div className={`text-xs font-bold ${dateClass(d)}`}>{dateLabel(d)}</div>
            <div className="font-black text-gray-900">{eur(total)}</div>
          </div>
        ))}
        <div className="rounded-lg border border-gray-300 bg-gray-100 px-3 py-2 text-sm">
          <div className="text-xs font-bold text-gray-700">{t('Grand total')}</div>
          <div className="font-black text-gray-900">{eur(grandTotal)}</div>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white shadow overflow-hidden">
        <div className="table-scroll">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-gray-700 font-semibold">
                <th className="p-3">{t('Vendor / payment / invoice')}</th>
                <th className="p-3">{t('Document')}</th>
                <th className="p-3">{t('Posting Date')}</th>
                <th className="p-3">{t('Due Date')}</th>
                <th className="p-3 text-right">{t('Remaining')}</th>
                <th className="p-3 text-right">{t('Amount (EUR)')}</th>
                <th className="p-3">{t('Scheduled Payment Date')}</th>
              </tr>
            </thead>
            <tbody>
              {vendors.length === 0 && <tr><td colSpan={7} className="p-8 text-center text-gray-600">{t('No open CHINA TRF entries.')}</td></tr>}
              {vendors.map(v => {
                const vOpen = openVendors[v.vendorNo] !== false;
                return (
                  <React.Fragment key={v.vendorNo}>
                    <tr className="bg-sky-100/70 border-b border-gray-200 cursor-pointer" onClick={() => setOpenVendors(o => ({ ...o, [v.vendorNo]: !vOpen }))}>
                      <td className="p-3 font-black text-gray-900" colSpan={5}>
                        <span className="inline-flex items-center gap-2">{vOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{v.name} <span className="text-xs font-semibold text-gray-600">{v.vendorNo}</span></span>
                      </td>
                      <td className="p-3 text-right font-black text-gray-900">{eur(v.total)}</td>
                      <td />
                    </tr>
                    {vOpen && v.payments.map(p => {
                      const pk = `${v.vendorNo}|${p.date}`;
                      const pOpen = !!openPayments[pk];
                      return (
                        <React.Fragment key={pk}>
                          <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => setOpenPayments(o => ({ ...o, [pk]: !pOpen }))}>
                            <td className="p-3 pl-8 font-bold" colSpan={5}>
                              <span className={`inline-flex items-center gap-2 ${dateClass(p.date)}`}>
                                {pOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{dateLabel(p.date)}
                                <span className="text-xs font-semibold text-gray-500">{t('{n} invoices', { n: p.list.length })}</span>
                              </span>
                            </td>
                            <td className={`p-3 text-right font-bold ${dateClass(p.date)}`}>{eur(p.total)}</td>
                            <td className="p-3">{renderDateEditor(p.list, p.date, pk)}</td>
                          </tr>
                          {pOpen && p.list.map(e => (
                            <tr key={e.entryNo} className="border-b border-gray-100 bg-gray-50/60 text-gray-800">
                              <td className="py-2 px-3 pl-16 font-semibold">{e.externalDocumentNo || '—'}</td>
                              <td className="py-2 px-3">
                                <span className="inline-flex items-center gap-1">{e.documentNo}<DocPdfLink company={company} documentNo={e.documentNo} kind={purchasePdfKind(e.documentType)} /></span>
                                {e.documentType !== 'Invoice' && <span className="ml-1 text-xs text-gray-500">({e.documentType})</span>}
                              </td>
                              <td className="py-2 px-3">{e.postingDate ? fmtDate(e.postingDate) : '-'}</td>
                              <td className="py-2 px-3">{e.dueDate ? fmtDate(e.dueDate) : '-'}</td>
                              <td className="py-2 px-3 text-right">{e.currencyCode ? `${e.currencyCode} ${e.remainingAmount.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}</td>
                              <td className="py-2 px-3 text-right font-semibold">{eur(e.remainingAmtLCY)}</td>
                              <td className="py-2 px-3">{renderDateEditor([e], e.scheduledDate || '', `e${e.entryNo}`)}</td>
                            </tr>
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </React.Fragment>
                );
              })}
              {vendors.length > 0 && (
                <tr className="bg-gray-100 font-black text-gray-900">
                  <td className="p-3" colSpan={5}>{t('Grand total')}</td>
                  <td className="p-3 text-right">{eur(grandTotal)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
