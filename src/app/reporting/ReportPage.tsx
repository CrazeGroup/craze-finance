'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { FileDown, RefreshCw } from 'lucide-react';
import { companyLabel, useCompany } from '@/contexts/CompanyContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { makeT } from './i18n';
import OperationalView, { InventoryAnalysisView, Loaded } from './OperationalView';
import ManagementView from './ManagementView';

const SECTIONS = ['inventory', 'purchases', 'receivables', 'payables', 'provisions', 'bwa', 'cashflow', 'analysis'] as const;
type SectionKey = typeof SECTIONS[number];
type View = 'operational' | 'management';
const VIEWS: View[] = ['operational', 'management'];
// Reporting (Operacional / Dirección) o Análisis Inventario (apartado propio del menú, solo inventario y compras)
export type ReportMode = 'reporting' | 'inventory';
const MODE_SECTIONS: Record<ReportMode, readonly SectionKey[]> = {
  reporting: ['inventory', 'purchases', 'receivables', 'payables', 'provisions', 'bwa', 'cashflow'],
  inventory: ['inventory', 'purchases', 'analysis'],
};
// analysis = inventario de cada fin de mes (Análisis Inventario)
const sectionUrl = (s: SectionKey) => (s === 'analysis' ? '/api/reporting/inventory-analysis' : `/api/reporting/${s}`);

const monthKey = (d: Date) => d.toISOString().substring(0, 7);
const shift = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number); return monthKey(new Date(Date.UTC(y, m - 1 + n, 1))); };
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

export default function ReportPage({ mode }: { mode: ReportMode }) {
  const { selectedCompany } = useCompany();
  const { lang } = useLanguage();
  const [view, setView] = useState<View>('operational');
  const [month, setMonth] = useState(() => shift(monthKey(new Date()), -1));
  const [reload, setReload] = useState({ n: 0, force: false });
  const [printing, setPrinting] = useState(false);
  const loadSections = MODE_SECTIONS[mode];
  const [sections, setSections] = useState<Record<SectionKey, Loaded>>(
    () => Object.fromEntries(SECTIONS.map(s => [s, { data: null, loading: true, error: null }])) as Record<SectionKey, Loaded>
  );

  const fmt = useMemo(() => makeT(lang), [lang]);
  const { t } = fmt;

  useEffect(() => {
    const v = store.get('crz-view') as View | null;
    if (v && VIEWS.includes(v)) setView(v);
  }, []);

  // Carga de todos los bloques (en paralelo; los pesados quedan en caché en el servidor)
  useEffect(() => {
    if (selectedCompany === 'ALL') return;
    let cancelled = false;
    setSections(Object.fromEntries(SECTIONS.map(s => [s, { data: null, loading: true, error: null }])) as Record<SectionKey, Loaded>);
    for (const s of loadSections) {
      fetch(`${sectionUrl(s)}?month=${month}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
        .then(async res => {
          const data = await res.json();
          if (cancelled) return;
          setSections(prev => ({ ...prev, [s]: res.ok && !data.error ? { data, loading: false, error: null } : { data: null, loading: false, error: data.error || `HTTP ${res.status}` } }));
        })
        .catch(err => !cancelled && setSections(prev => ({ ...prev, [s]: { data: null, loading: false, error: err.message } })));
    }
    return () => { cancelled = true; };
  }, [month, reload, selectedCompany, loadSections]);

  const changeView = (v: View) => { setView(v); store.set('crz-view', v); };

  // PDF: se muestran las dos vistas y se abre el diálogo de impresión (Guardar como PDF)
  const exportPdf = () => {
    setPrinting(true);
    setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 800);
  };

  const months = Array.from({ length: 13 }, (_, i) => shift(monthKey(new Date()), -i));
  const anyLoading = loadSections.some(s => sections[s].loading);
  const cutoff = sections.receivables.data?.date || sections.inventory.data?.date;
  const company = selectedCompany === 'ALL' ? 'CRAZE' : selectedCompany;

  const operational = <OperationalView fmt={fmt} inv={sections.inventory} ar={sections.receivables} />;
  const inventory = <InventoryAnalysisView fmt={fmt} month={month} inv={sections.inventory} pur={sections.purchases} an={sections.analysis} />;
  const management = <ManagementView fmt={fmt} month={month} company={company} ar={sections.receivables} ap={sections.payables} prov={sections.provisions} bwa={sections.bwa} cf={sections.cashflow} />;

  return (
    <div className="rpt-root min-h-screen bg-[#F3F4F7] pb-24">
      <header className="rpt-header sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-4 mr-auto">
            <Image src="/logo.png" alt="Craze Group" width={104} height={50} className="object-contain" />
            <div>
              <p className="font-bold text-gray-900 leading-tight">{t(mode === 'inventory' ? 'inventory' : 'title')}</p>
              <p className="text-xs text-gray-500">{t('closing', { month: fmt.monthText(month), date: cutoff ? fmt.date(cutoff) : '…' })} · {companyLabel(company)}</p>
            </div>
          </div>
          <div className="rpt-noprint flex flex-wrap items-center gap-3">
            {mode === 'reporting' && (
              <div className="flex bg-gray-100 rounded-lg p-1">
                {VIEWS.map(v => (
                  <button key={v} onClick={() => changeView(v)} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${view === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                    {t(v)}
                  </button>
                ))}
              </div>
            )}
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 hidden sm:inline">{t('month')}</span>
            <select value={month} onChange={e => setMonth(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold bg-white">
              {months.map(m => <option key={m} value={m}>{fmt.monthName(m)}</option>)}
            </select>
            <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={anyLoading} title={t('refresh')}
              className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
              <RefreshCw size={16} className={anyLoading ? 'animate-spin' : ''} />
            </button>
            <button onClick={exportPdf} disabled={anyLoading} className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
              <FileDown size={16} /> {t('exportPdf')}
            </button>
          </div>
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-6 space-y-10">
        {selectedCompany === 'ALL' ? (
          <p className="text-sm text-gray-600">{t('selectCompany')}</p>
        ) : mode === 'inventory' ? inventory : printing ? (
          <>
            {operational}
            <div className="rpt-pagebreak" />
            {management}
          </>
        ) : view === 'operational' ? operational : management}
        <p className="text-xs text-gray-500 border-t border-gray-200 pt-4">{t('footer')}</p>
      </main>
    </div>
  );
}
