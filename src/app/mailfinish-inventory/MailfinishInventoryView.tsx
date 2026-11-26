'use client';

import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { AlertTriangle, Download, RefreshCw, Search } from 'lucide-react';
import DocPdfLink from '@/components/DocPdfLink';
import { useT } from '@/contexts/LanguageContext';
import type { MfInventory, MfMonth, MfRow } from '@/lib/mailfinishInventory';

const COMPANY = 'Craze Entertainment';
const dmy = (d: string) => (d ? d.split('-').reverse().join('/') : '');
const diffCls = (v: number) => (Math.abs(v) < 0.5 ? 'text-gray-400' : v > 0 ? 'text-amber-700 font-semibold' : 'text-red-600 font-semibold');
const sum = (rows: MfRow[], f: (r: MfRow) => number) => rows.reduce((s, r) => s + f(r), 0);
const diff = (r: MfRow) => r.mf - r.bc;

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
  const [view, setView] = useState<'item' | 'month'>('item');
  const [show, setShow] = useState<'all' | 'mf' | 'bc' | 'diff'>('all');

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
    return sel.rows.filter(r => (!onlyDiff || Math.abs(diff(r)) >= 0.5)
      && (!s || `${r.bcItem || ''} ${r.codes.join(' ')} ${r.description}`.toLowerCase().includes(s)));
  }, [sel, onlyDiff, search]);

  // Vista por artículo: una fila por artículo y, por columnas, cada mes (Mailfinish / BC / diferencia)
  const pivot = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, { key: string; label: string; codes: string[]; description: string; byMonth: Record<string, { mf: number; bc: number }> }>();
    for (const mo of data.months) for (const r of mo.rows) {
      const x = m.get(r.key) || { key: r.key, label: r.bcItem || '', codes: [], description: r.description, byMonth: {} };
      for (const c of r.codes) if (!x.codes.includes(c)) x.codes.push(c);
      x.byMonth[mo.month] = { mf: r.mf, bc: r.bc };
      m.set(r.key, x);
    }
    const s = search.trim().toLowerCase();
    return Array.from(m.values())
      .filter(x => (!onlyDiff || Object.values(x.byMonth).some(v => Math.abs(v.mf - v.bc) >= 0.5))
        && (!s || `${x.label} ${x.codes.join(' ')} ${x.description}`.toLowerCase().includes(s)))
      .sort((a, b) => (a.label || '~' + a.codes[0]).localeCompare(b.label || '~' + b.codes[0]));
  }, [data, onlyDiff, search]);
  const MEASURES = [
    { key: 'mf', label: 'Mailfinish', get: (v: { mf: number; bc: number }) => v.mf, diff: false },
    { key: 'bc', label: 'BC', get: (v: { mf: number; bc: number }) => v.bc, diff: false },
    { key: 'diff', label: t('Diff.'), get: (v: { mf: number; bc: number }) => v.mf - v.bc, diff: true },
  ];
  const cols = MEASURES.filter(x => show === 'all' || show === x.key);

  const exportPivot = () => {
    if (!data) return;
    const sheet = XLSX.utils.json_to_sheet(pivot.map(x => {
      const row: Record<string, string | number> = { [t('BC item')]: x.label, [t('Mailfinish code')]: x.codes.join(', '), [t('Description')]: x.description };
      for (const mo of data.months) for (const c of cols) {
        const v = x.byMonth[mo.month];
        row[`${mo.month} ${c.label}`] = v ? c.get(v) : '';
      }
      return row;
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, data.year);
    XLSX.writeFile(wb, `Mailfinish_Inventory_${data.year}_by_item.xlsx`);
  };

  const exportExcel = () => {
    if (!sel) return;
    const sheet = XLSX.utils.json_to_sheet(sel.rows.map(r => ({
      [t('BC item')]: r.bcItem || '', [t('Mailfinish code')]: r.codes.join(', '), [t('Description')]: r.description,
      Mailfinish: r.mf, 'BC MAILFINISH': r.bc, [t('Difference')]: diff(r),
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
          {t('Month-end stock reported by Mailfinish (Excel attached to each Storage invoice, units of the last day) compared with BC stock in the MAILFINISH location on the same day. UNUSABLE codes (_3) are ignored: they are destroyed and no longer in BC.')}
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
                  <th className="px-3 py-2 text-right">{t('Items with differences')}</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map(m => {
                  const g = sum(m.rows, diff);
                  const n = m.rows.filter(r => Math.abs(diff(r)) >= 0.5).length;
                  return (
                    <tr key={m.month} onClick={() => { setMonth(m.month); setView('month'); }}
                      className={`border-t border-gray-100 cursor-pointer ${m.month === month ? 'bg-pink-50' : 'hover:bg-gray-50'}`}>
                      <td className="px-3 py-2 font-medium capitalize">{monthName(m.month)}</td>
                      <td className="px-3 py-2 text-gray-600">{m.invoice}<DocPdfLink company={COMPANY} documentNo={m.invoice} /> <span className="text-xs text-gray-400">{m.file}</span></td>
                      <td className="px-3 py-2 text-right">{u(sum(m.rows, r => r.mf))}</td>
                      <td className="px-3 py-2 text-right">{u(sum(m.rows, r => r.bc))}</td>
                      <td className={`px-3 py-2 text-right ${diffCls(g)}`}>{sd(g)}</td>
                      <td className="px-3 py-2 text-right">{n}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {/* Vista: por artículo (meses en columnas) o detalle de un mes */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-lg border border-gray-300 bg-white overflow-hidden text-sm">
              {(['item', 'month'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-3 py-1.5 ${view === v ? 'bg-[#C8186C] text-white' : 'text-gray-700 hover:bg-gray-50'}`}>
                  {v === 'item' ? t('By item (months in columns)') : t('Month detail')}
                </button>
              ))}
            </div>
            <label className="inline-flex items-center gap-1.5 text-sm text-gray-700">
              <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} /> {t('Only differences')}
            </label>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Search item…')}
                className="pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg" />
            </div>
            {view === 'item' && (
              <select value={show} onChange={e => setShow(e.target.value as typeof show)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white">
                <option value="all">{t('Mailfinish, BC and difference')}</option>
                <option value="mf">{t('Only Mailfinish')}</option>
                <option value="bc">{t('Only BC')}</option>
                <option value="diff">{t('Only the difference')}</option>
              </select>
            )}
            <button onClick={view === 'item' ? exportPivot : exportExcel} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50">
              <Download size={14} /> Excel
            </button>
          </div>

          {view === 'item' && (
            <section className="bg-white rounded-xl border border-gray-200 max-h-[calc(100vh-120px)] overflow-auto">
              <table className="text-sm border-separate border-spacing-0 min-w-full">
                <thead className="text-xs text-gray-500 uppercase sticky top-0 z-20 bg-gray-50">
                  <tr>
                    <th rowSpan={2} className="px-3 py-2 text-left sticky left-0 z-30 bg-gray-50 border-b border-r border-gray-200">{t('BC item')}</th>
                    <th rowSpan={2} className="px-3 py-2 text-left border-b border-gray-200 min-w-[260px]">{t('Description')}</th>
                    {data.months.map(m => (
                      <th key={m.month} colSpan={cols.length} className="px-3 py-1.5 text-center capitalize border-l border-gray-200 text-gray-700">{monthName(m.month)}</th>
                    ))}
                  </tr>
                  <tr>
                    {data.months.map(m => cols.map((c, i) => (
                      <th key={m.month + c.key} className={`px-3 py-1.5 text-right border-b border-gray-200 ${i === 0 ? 'border-l' : ''}`}>{c.label}</th>
                    )))}
                  </tr>
                </thead>
                <tbody>
                  {pivot.map(x => (
                    <tr key={x.key} className="hover:bg-gray-50">
                      <td className="px-3 py-1.5 font-medium whitespace-nowrap sticky left-0 z-10 bg-white border-b border-r border-gray-100">
                        {x.label || <span className="text-red-600">{t('not in BC')}</span>}
                        {x.codes.length > 0 && x.codes.join(', ') !== x.label && <span className="ml-1.5 text-xs font-normal text-gray-400">{x.codes.join(', ')}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-gray-600 border-b border-gray-100">{x.description}</td>
                      {data.months.map(m => cols.map((c, i) => {
                        const v = x.byMonth[m.month];
                        const n = v ? c.get(v) : null;
                        return (
                          <td key={m.month + c.key} className={`px-3 py-1.5 text-right whitespace-nowrap border-b border-gray-100 ${i === 0 ? 'border-l border-l-gray-200' : ''} ${n == null ? 'text-gray-300' : c.diff ? diffCls(n) : ''}`}>
                            {n == null ? '·' : c.diff ? sd(n) : u(n)}
                          </td>
                        );
                      }))}
                    </tr>
                  ))}
                  <tr className="font-semibold bg-gray-50">
                    <td className="px-3 py-2 sticky left-0 z-10 bg-gray-50 border-t-2 border-r border-gray-300" colSpan={1}>{t('Total')} ({pivot.length})</td>
                    <td className="px-3 py-2 border-t-2 border-gray-300" />
                    {data.months.map(m => cols.map((c, i) => {
                      const n = pivot.reduce((s, x) => s + (x.byMonth[m.month] ? c.get(x.byMonth[m.month]) : 0), 0);
                      return <td key={m.month + c.key} className={`px-3 py-2 text-right whitespace-nowrap border-t-2 border-gray-300 ${i === 0 ? 'border-l border-l-gray-200' : ''} ${c.diff ? diffCls(n) : ''}`}>{c.diff ? sd(n) : u(n)}</td>;
                    }))}
                  </tr>
                </tbody>
              </table>
            </section>
          )}

          {/* Detalle del mes */}
          {view === 'month' && sel && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-semibold text-gray-900 capitalize">{monthName(sel.month)} · {dmy(sel.endOfMonth)}</h2>
                <span className="text-xs text-gray-500">{t('Click a month in the summary to change it.')}</span>
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
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.key} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 font-medium">{r.bcItem || <span className="text-red-600">{t('not in BC')}</span>}</td>
                        <td className="px-3 py-1.5 text-gray-600">{r.codes.join(', ') || <span className="text-gray-400">{t('not reported')}</span>}</td>
                        <td className="px-3 py-1.5 text-gray-600">{r.description}</td>
                        <td className="px-3 py-1.5 text-right">{u(r.mf)}</td>
                        <td className="px-3 py-1.5 text-right">{u(r.bc)}</td>
                        <td className={`px-3 py-1.5 text-right ${diffCls(diff(r))}`}>{sd(diff(r))}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-gray-300 font-semibold bg-gray-50">
                      <td className="px-3 py-2" colSpan={3}>{t('Total')} ({rows.length})</td>
                      <td className="px-3 py-2 text-right">{u(sum(rows, r => r.mf))}</td>
                      <td className="px-3 py-2 text-right">{u(sum(rows, r => r.bc))}</td>
                      <td className={`px-3 py-2 text-right ${diffCls(sum(rows, diff))}`}>{sd(sum(rows, diff))}</td>
                    </tr>
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
