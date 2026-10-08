'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { FileDown, RefreshCw } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { Lang, LANGS, makeT } from './i18n';
import { KeyPoints } from './ui';
import OperationalView, { Loaded } from './OperationalView';
import ManagementView from './ManagementView';

const SECTIONS = ['inventory', 'purchases', 'receivables', 'payables', 'provisions', 'bwa', 'cashflow'] as const;
type SectionKey = typeof SECTIONS[number];
type View = 'operational' | 'management';

const monthKey = (d: Date) => d.toISOString().substring(0, 7);
const shift = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number); return monthKey(new Date(Date.UTC(y, m - 1 + n, 1))); };
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

// Cifras compactas que se envían a la IA para redactar los puntos clave de cada vista
function summaryInput(view: View, d: Record<SectionKey, any>) {
  if (view === 'operational') {
    const inv = d.inventory, pur = d.purchases, ar = d.receivables;
    return {
      inventario: inv && {
        fecha: inv.date, valor: inv.total, valorMesAnterior: inv.prevTotal, trasDepreciacion2023: inv.totalDep,
        porAlmacen: inv.locations.slice(0, 6).map((l: any) => ({ almacen: l.loc, valor: l.value, mesAnterior: l.prevValue })),
        topSuben: inv.up.slice(0, 5).map((i: any) => ({ ref: i.code, desc: i.desc, delta: i.dv })),
        topBajan: inv.down.slice(0, 5).map((i: any) => ({ ref: i.code, desc: i.desc, delta: i.dv })),
        cuentaContable1140: inv.glBalance,
        costeMedio: { anterior: inv.cost.unitCostPrev, actual: inv.cost.unitCostCur, efectoPrecio: inv.cost.priceEffect, efectoVolumenMix: inv.cost.volEffect, principales: inv.cost.items.slice(0, 4).map((i: any) => ({ ref: i.code, desc: i.desc, variacionPct: i.dcp, efecto: i.eff })) },
      },
      comprasChinaTrf: pur && { mes: pur.total, facturas: pur.n, mesAnterior: pur.prevTotal, media12m: pur.avg12, porProveedor: pur.byVendor },
      sinSeguro: ar && Object.fromEntries(Object.entries(ar.uninsured).map(([k, v]: any) => [k, { total: v.total, vencido: v.overdue, partidas: v.n }])),
    };
  }
  const ar = d.receivables, ap = d.payables, prov = d.provisions, bwa = d.bwa, cf = d.cashflow;
  const bwaLine = (code: string) => bwa?.lines.find((l: any) => l.code === code);
  return {
    clientes: ar && { total: ar.ar.total, vencido: ar.ar.overdue, porFormaPago: ar.ar.byPM.slice(0, 6).map((p: any) => ({ fp: p.pm || 'sin forma de pago', importe: p.amt, vencido: p.od })) },
    amazon: ar && { total: ar.amazon.total, noVencido: ar.amazon.notDue, vencidoNeto: ar.amazon.overdue, partidasMas90Dias: ar.amazon.old },
    markant: ar && { total: ar.markant.total, conFecha: ar.markant.conf, sinFecha: ar.markant.unconf, principalesSinFecha: ar.markant.unconfTop.slice(0, 3) },
    proveedores: ap && { total: ap.ap.total, chinaTrf: { total: ap.china.total, conFechaProgramada: ap.china.conf, sinFecha: ap.china.unconf, vencido: ap.china.overdue, vencidoSinFecha: ap.china.unconfOverdue } },
    provisiones: prov && { original: prov.orig, consumido: prov.cons, abierto: prov.open, porTipo: prov.byType, dotacionMes: prov.month },
    bwaAcumulado: bwa && ['1020', '1080', '1300', '1380'].map(code => ({ linea: bwaLine(code)?.description, porSociedad: Object.fromEntries(bwa.columns.map((c: string) => [c, Math.round(bwaLine(code)?.values[c]?.ytd || 0)])), crazeAnoAnterior: Math.round(bwaLine(code)?.values.CRAZE?.prevYtd || 0) })),
    tesoreria: cf && { limite: cf.limit, saldoInicial: cf.start, minimo: cf.min, saldoFinal: cf.end, diasBajoLimite: cf.breachDays, tramosBajoLimite: cf.breaches.slice(0, 4), movimientosGrandes: cf.bigMoves.slice(0, 12) },
  };
}

type SummaryState = { points: string[] | null; loading: boolean; error: string | null; waiting: boolean };
const VIEW_SECTIONS: Record<View, SectionKey[]> = {
  operational: ['inventory', 'purchases', 'receivables'],
  management: ['receivables', 'payables', 'provisions', 'bwa', 'cashflow'],
};

export default function ReportingPage() {
  const { selectedCompany } = useCompany();
  const [lang, setLang] = useState<Lang>('es');
  const [view, setView] = useState<View>('operational');
  const [month, setMonth] = useState(() => shift(monthKey(new Date()), -1));
  const [reload, setReload] = useState({ n: 0, force: false });
  const [printing, setPrinting] = useState(false);
  const [sections, setSections] = useState<Record<SectionKey, Loaded>>(
    () => Object.fromEntries(SECTIONS.map(s => [s, { data: null, loading: true, error: null }])) as Record<SectionKey, Loaded>
  );
  const [summaries, setSummaries] = useState<Record<View, SummaryState>>({
    operational: { points: null, loading: false, error: null, waiting: true },
    management: { points: null, loading: false, error: null, waiting: true },
  });
  const [summaryForce, setSummaryForce] = useState<Record<View, number>>({ operational: 0, management: 0 });
  // Nº de petición por vista: se descartan respuestas de peticiones anteriores (otro mes o idioma)
  const summaryReq = useRef<Record<View, number>>({ operational: 0, management: 0 });

  const fmt = useMemo(() => makeT(lang), [lang]);
  const { t } = fmt;

  useEffect(() => {
    const l = store.get('crz-lang') as Lang | null;
    if (l && LANGS.includes(l)) setLang(l);
    const v = store.get('crz-view') as View | null;
    if (v === 'operational' || v === 'management') setView(v);
  }, []);

  // Carga de todos los bloques (en paralelo; los pesados quedan en caché en el servidor)
  useEffect(() => {
    if (selectedCompany === 'ALL') return;
    let cancelled = false;
    setSections(Object.fromEntries(SECTIONS.map(s => [s, { data: null, loading: true, error: null }])) as Record<SectionKey, Loaded>);
    for (const s of SECTIONS) {
      fetch(`/api/reporting/${s}?month=${month}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
        .then(async res => {
          const data = await res.json();
          if (cancelled) return;
          setSections(prev => ({ ...prev, [s]: res.ok && !data.error ? { data, loading: false, error: null } : { data: null, loading: false, error: data.error || `HTTP ${res.status}` } }));
        })
        .catch(err => !cancelled && setSections(prev => ({ ...prev, [s]: { data: null, loading: false, error: err.message } })));
    }
    return () => { cancelled = true; };
  }, [month, reload, selectedCompany]);

  // Puntos clave de cada vista, cuando sus bloques han cargado
  const viewReady = useCallback((v: View) => VIEW_SECTIONS[v].every(s => !sections[s].loading), [sections]);
  useEffect(() => {
    for (const v of ['operational', 'management'] as View[]) {
      if (!viewReady(v)) { setSummaries(prev => ({ ...prev, [v]: { points: null, loading: false, error: null, waiting: true } })); continue; }
      const data = summaryInput(v, Object.fromEntries(SECTIONS.map(s => [s, sections[s].data])) as Record<SectionKey, any>);
      const req = ++summaryReq.current[v];
      const stale = () => summaryReq.current[v] !== req;
      setSummaries(prev => ({ ...prev, [v]: { points: null, loading: true, error: null, waiting: false } }));
      fetch('/api/reporting/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ view: v, lang, month, data, force: summaryForce[v] > 0 }),
      })
        .then(async res => {
          const r = await res.json();
          if (stale()) return;
          setSummaries(prev => ({ ...prev, [v]: res.ok && !r.error ? { points: r.points, loading: false, error: null, waiting: false } : { points: null, loading: false, error: r.error || `HTTP ${res.status}`, waiting: false } }));
        })
        .catch(err => !stale() && setSummaries(prev => ({ ...prev, [v]: { points: null, loading: false, error: err.message, waiting: false } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewReady('operational'), viewReady('management'), lang, month, summaryForce]);

  const changeLang = (l: Lang) => { setLang(l); store.set('crz-lang', l); };
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
  const anyLoading = SECTIONS.some(s => sections[s].loading);
  const cutoff = sections.receivables.data?.date || sections.inventory.data?.date;
  const company = selectedCompany === 'ALL' ? 'CRAZE' : selectedCompany;

  const operational = (
    <div className="space-y-8">
      <KeyPoints title={t('keyPointsOp')} state={summaries.operational} fmt={fmt} onRegenerate={() => setSummaryForce(f => ({ ...f, operational: f.operational + 1 }))} />
      <OperationalView fmt={fmt} month={month} inv={sections.inventory} pur={sections.purchases} ar={sections.receivables} />
    </div>
  );
  const management = (
    <div className="space-y-8">
      <KeyPoints title={t('keyPointsDir')} state={summaries.management} fmt={fmt} onRegenerate={() => setSummaryForce(f => ({ ...f, management: f.management + 1 }))} />
      <ManagementView fmt={fmt} month={month} company={company} ar={sections.receivables} ap={sections.payables} prov={sections.provisions} bwa={sections.bwa} cf={sections.cashflow} />
    </div>
  );

  return (
    <div className="rpt-root min-h-screen bg-[#F3F4F7] pb-24">
      <header className="rpt-header sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-4 mr-auto">
            <Image src="/logo.png" alt="Craze Group" width={104} height={50} className="object-contain" />
            <div>
              <p className="font-bold text-gray-900 leading-tight">{t('title')}</p>
              <p className="text-xs text-gray-500">{t('closing', { month: fmt.monthText(month), date: cutoff ? fmt.date(cutoff) : '…' })} · {company}</p>
            </div>
          </div>
          <div className="rpt-noprint flex flex-wrap items-center gap-3">
            <div className="flex bg-gray-100 rounded-lg p-1">
              {(['operational', 'management'] as View[]).map(v => (
                <button key={v} onClick={() => changeView(v)} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${view === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                  {t(v === 'operational' ? 'operational' : 'management')}
                </button>
              ))}
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 hidden sm:inline">{t('month')}</span>
            <select value={month} onChange={e => setMonth(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold bg-white">
              {months.map(m => <option key={m} value={m}>{fmt.monthName(m)}</option>)}
            </select>
            <select value={lang} onChange={e => changeLang(e.target.value as Lang)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white">
              {LANGS.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
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

      <main className="max-w-7xl mx-auto px-4 md:px-8 pt-6 space-y-10">
        {selectedCompany === 'ALL' ? (
          <p className="text-sm text-gray-600">{t('selectCompany')}</p>
        ) : printing ? (
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
