'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { AlertTriangle, Download, RefreshCw, Search } from 'lucide-react';
import DocPdfLink from '@/components/DocPdfLink';
import { useT } from '@/contexts/LanguageContext';
import type { MfInventory, MfMonth, MfRow } from '@/lib/mailfinishInventory';

const COMPANY = 'Craze Entertainment';
const dmy = (d: string) => (d ? d.split('-').reverse().join('/') : '');
const diffCls = (v: number) => (Math.abs(v) < 0.5 ? 'text-gray-400' : v > 0 ? 'text-amber-700 font-semibold' : 'text-red-600 font-semibold');
const sum = (rows: MfRow[], f: (r: MfRow) => number) => rows.reduce((s, r) => s + f(r), 0);
const totalDiff = (r: MfRow) => r.mfGood + r.mfDamaged - r.bcGood - r.bcDamaged;

export default function MailfinishInventoryView() {
  const { t, locale } = useT();
  const qf = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
  const u = (v: number) => (Math.abs(v) < 0.5 ? '—' : qf.format(v));
  const sd = (v: number) => (Math.abs(v) < 0.5 ? '0' : (v > 0 ? '+' : '') + qf.format(v));
  const monthName = (m: string) => new Date(`${m}-15`).toLocaleDateString(locale, { month: 'long', year: 'numeric' });

  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(String(thisYear));
  const [data, setData] = useState<MfInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [month, setMonth] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [search, setSearch] = useState('');

  const load = async (force = false) => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/mailfinish/inventory?year=${year}${force ? '&force=1' : ''}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
      setMonth(m => (json.months.some((x: MfMonth) => x.month === m) ? m : json.months.at(-1)?.month || ''));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps

  const sel = data?.months.find(m => m.month === month) || null;
  const rows = useMemo(() => {
    if (!sel) return [];
    const s = search.trim().toLowerCase();
    return sel.rows.filter(r => (!onlyDiff || Math.abs(r.mfGood - r.bcGood) >= 0.5 || Math.abs(r.mfDamaged - r.bcDamaged) >= 0.5)
      && (!s || `${r.bcItem || ''} ${r.codes.join(' ')} ${r.description}`.toLowerCase().includes(s)));
  }, [sel, onlyDiff, search]);

  // Diferencia total (Mailfinish − BC) por artículo y mes
  const matrix = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, { key: string; label: string; description: string; byMonth: Record<string, number> }>();
    for (const mo of data.months) for (const r of mo.rows) {
      const x = m.get(r.key) || { key: r.key, label: r.bcItem || r.codes.join(', '), description: r.description, byMonth: {} };
      x.byMonth[mo.month] = totalDiff(r);
      m.set(r.key, x);
    }
    return Array.from(m.values()).filter(x => Object.values(x.byMonth).some(v => Math.abs(v) >= 0.5)).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  const exportExcel = () => {
    if (!sel) return;
    const sheet = XLSX.utils.json_to_sheet(sel.rows.map(r => ({
      [t('BC item')]: r.bcItem || '', [t('Mailfinish code')]: r.codes.join(', '), [t('Description')]: r.description,
      [`Mailfinish`]: r.mfGood, [`BC ${'MAILFINISH'}`]: r.bcGood, [t('Difference')]: r.mfGood - r.bcGood,
      [`Mailfinish UNUSABLE`]: r.mfDamaged, [`BC DESTR MAIL`]: r.bcDamaged, [`${t('Difference')} UNUSABLE`]: r.mfDamaged - r.bcDamaged,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, sel.month);
    XLSX.writeFile(wb, `Mailfinish_Inventory_${sel.month}.xlsx`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <select value={year} onChange={e => setYear(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white">
          {[thisYear, thisYear - 1].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={() => load(true)} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> {t('Reload from BC')}
        </button>
        <p className="text-xs text-gray-500 max-w-3xl">
          {t('Month-end stock reported by Mailfinish (Excel attached to each Storage invoice, units of the last day) compared with BC stock on the same day: MAILFINISH location, and DESTR MAIL for the UNUSABLE codes (_3).')}
        </p>
      </div>

      {error && <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}
      {loading && !data && <p className="text-sm text-gray-500">{t('Reading the Storage invoices and their Excel files in BC…')}</p>}

      {data && (
        <>
          {(data.missing.length > 0 || data.warnings.length > 0) && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800 space-y-1">
              {data.missing.length > 0 && (
                <p className="flex items-start gap-1.5"><AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  {t('No inventory Excel attached to a Storage invoice for: {months}', { months: data.missing.map(monthName).join(', ') })}</p>
              )}
              {data.warnings.map((w, i) => <p key={i}>{t(w.text, w.params)}</p>)}
            </div>
          )}

          {/* Resumen por mes */}
          <section className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">{t('Month')}</th>
                  <th className="px-3 py-2 text-left">{t('Storage invoice')}</th>
                  <th className="px-3 py-2 text-right">Mailfinish</th>
                  <th className="px-3 py-2 text-right">BC MAILFINISH</th>
                  <th className="px-3 py-2 text-right">{t('Difference')}</th>
                  <th className="px-3 py-2 text-right">Mailfinish UNUSABLE</th>
                  <th className="px-3 py-2 text-right">BC DESTR MAIL</th>
                  <th className="px-3 py-2 text-right">{t('Difference')}</th>
                  <th className="px-3 py-2 text-right">{t('Items with differences')}</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map(m => {
                  const g = sum(m.rows, r => r.mfGood) - sum(m.rows, r => r.bcGood);
                  const d = sum(m.rows, r => r.mfDamaged) - sum(m.rows, r => r.bcDamaged);
                  const n = m.rows.filter(r => Math.abs(r.mfGood - r.bcGood) >= 0.5 || Math.abs(r.mfDamaged - r.bcDamaged) >= 0.5).length;
                  return (
                    <tr key={m.month} onClick={() => setMonth(m.month)}
                      className={`border-t border-gray-100 cursor-pointer ${m.month === month ? 'bg-pink-50' : 'hover:bg-gray-50'}`}>
                      <td className="px-3 py-2 font-medium capitalize">{monthName(m.month)}</td>
                      <td className="px-3 py-2 text-gray-600">{m.invoice}<DocPdfLink company={COMPANY} documentNo={m.invoice} /> <span className="text-xs text-gray-400">{m.file}</span></td>
                      <td className="px-3 py-2 text-right">{u(sum(m.rows, r => r.mfGood))}</td>
                      <td className="px-3 py-2 text-right">{u(sum(m.rows, r => r.bcGood))}</td>
                      <td className={`px-3 py-2 text-right ${diffCls(g)}`}>{sd(g)}</td>
                      <td className="px-3 py-2 text-right">{u(sum(m.rows, r => r.mfDamaged))}</td>
                      <td className="px-3 py-2 text-right">{u(sum(m.rows, r => r.bcDamaged))}</td>
                      <td className={`px-3 py-2 text-right ${diffCls(d)}`}>{sd(d)}</td>
                      <td className="px-3 py-2 text-right">{n}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {/* Detalle del mes */}
          {sel && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-semibold text-gray-900 capitalize">{monthName(sel.month)} · {dmy(sel.endOfMonth)}</h2>
                <label className="inline-flex items-center gap-1.5 text-sm text-gray-700">
                  <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} /> {t('Only differences')}
                </label>
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Search item…')}
                    className="pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg" />
                </div>
                <button onClick={exportExcel} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50">
                  <Download size={14} /> Excel
                </button>
              </div>
              {sel.warnings.length > 0 && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800 space-y-1">
                  {sel.warnings.map((w, i) => <p key={i}>{t(w.text, w.params)}</p>)}
                </div>
              )}
              <section className="bg-white rounded-xl border border-gray-200 table-scroll">
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-500 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">{t('BC item')}</th>
                      <th className="px-3 py-2 text-left">{t('Mailfinish code')}</th>
                      <th className="px-3 py-2 text-left">{t('Description')}</th>
                      <th className="px-3 py-2 text-right">Mailfinish</th>
                      <th className="px-3 py-2 text-right">BC MAILFINISH</th>
                      <th className="px-3 py-2 text-right">{t('Difference')}</th>
                      <th className="px-3 py-2 text-right">Mailfinish UNUSABLE</th>
                      <th className="px-3 py-2 text-right">BC DESTR MAIL</th>
                      <th className="px-3 py-2 text-right">{t('Difference')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.key} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 font-medium">{r.bcItem || <span className="text-red-600">{t('not in BC')}</span>}</td>
                        <td className="px-3 py-1.5 text-gray-600">{r.codes.join(', ') || <span className="text-gray-400">{t('not reported')}</span>}</td>
                        <td className="px-3 py-1.5 text-gray-600">{r.description}</td>
                        <td className="px-3 py-1.5 text-right">{u(r.mfGood)}</td>
                        <td className="px-3 py-1.5 text-right">{u(r.bcGood)}</td>
                        <td className={`px-3 py-1.5 text-right ${diffCls(r.mfGood - r.bcGood)}`}>{sd(r.mfGood - r.bcGood)}</td>
                        <td className="px-3 py-1.5 text-right">{u(r.mfDamaged)}</td>
                        <td className="px-3 py-1.5 text-right">{u(r.bcDamaged)}</td>
                        <td className={`px-3 py-1.5 text-right ${diffCls(r.mfDamaged - r.bcDamaged)}`}>{sd(r.mfDamaged - r.bcDamaged)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-gray-300 font-semibold bg-gray-50">
                      <td className="px-3 py-2" colSpan={3}>{t('Total')} ({rows.length})</td>
                      <td className="px-3 py-2 text-right">{u(sum(rows, r => r.mfGood))}</td>
                      <td className="px-3 py-2 text-right">{u(sum(rows, r => r.bcGood))}</td>
                      <td className={`px-3 py-2 text-right ${diffCls(sum(rows, r => r.mfGood - r.bcGood))}`}>{sd(sum(rows, r => r.mfGood - r.bcGood))}</td>
                      <td className="px-3 py-2 text-right">{u(sum(rows, r => r.mfDamaged))}</td>
                      <td className="px-3 py-2 text-right">{u(sum(rows, r => r.bcDamaged))}</td>
                      <td className={`px-3 py-2 text-right ${diffCls(sum(rows, r => r.mfDamaged - r.bcDamaged))}`}>{sd(sum(rows, r => r.mfDamaged - r.bcDamaged))}</td>
                    </tr>
                  </tbody>
                </table>
              </section>
            </>
          )}

          {/* Evolución de las diferencias */}
          {matrix.length > 0 && (
            <>
              <h2 className="font-semibold text-gray-900">{t('Differences by month (Mailfinish − BC, both locations)')}</h2>
              <section className="bg-white rounded-xl border border-gray-200 max-h-[70vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-500 uppercase sticky top-0 z-10 bg-gray-50 shadow-[inset_0_-1px_0_rgb(229,231,235)]">
                    <tr>
                      <th className="px-3 py-2 text-left">{t('Item')}</th>
                      <th className="px-3 py-2 text-left">{t('Description')}</th>
                      {data.months.map(m => <th key={m.month} className="px-3 py-2 text-right capitalize">{new Date(`${m.month}-15`).toLocaleDateString(locale, { month: 'short' })}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.map(x => (
                      <Fragment key={x.key}>
                        <tr className="border-t border-gray-100">
                          <td className="px-3 py-1.5 font-medium">{x.label}</td>
                          <td className="px-3 py-1.5 text-gray-600">{x.description}</td>
                          {data.months.map(m => {
                            const v = x.byMonth[m.month];
                            return <td key={m.month} className={`px-3 py-1.5 text-right ${v == null ? 'text-gray-300' : diffCls(v)}`}>{v == null ? '·' : sd(v)}</td>;
                          })}
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
