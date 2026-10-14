'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { makeT } from '../reporting/i18n';
import type { Loaded } from '../reporting/OperationalView';
import ProvisionView from '../reporting/ProvisionView';

// Provision: provisiones G/L (documentos PROV-, como en el Reporting) y provisión de condiciones y marketing
// por Customer Group de la LM de BC.
const monthKey = (d: Date) => d.toISOString().substring(0, 7);
const shift = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number); return monthKey(new Date(Date.UTC(y, m - 1 + n, 1))); };

export default function ProvisionPage() {
  const { selectedCompany } = useCompany();
  const fmt = useMemo(() => makeT('es'), []);
  const [month, setMonth] = useState(() => shift(monthKey(new Date()), -1));
  const [reload, setReload] = useState({ n: 0, force: false });
  const [prov, setProv] = useState<Loaded>({ data: null, loading: true, error: null });

  useEffect(() => {
    if (selectedCompany === 'ALL') return;
    let cancelled = false;
    setProv({ data: null, loading: true, error: null });
    fetch(`/api/reporting/provisions?month=${month}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json();
        if (cancelled) return;
        setProv(res.ok && !data.error ? { data, loading: false, error: null } : { data: null, loading: false, error: data.error || `HTTP ${res.status}` });
      })
      .catch(err => !cancelled && setProv({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [month, reload, selectedCompany]);

  const months = Array.from({ length: 13 }, (_, i) => shift(monthKey(new Date()), -i));

  return (
    <div className="rpt-root min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight">Provision</p>
            <p className="text-xs text-gray-500">{selectedCompany}</p>
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 hidden sm:inline">Mes</span>
          <select value={month} onChange={e => setMonth(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold bg-white">
            {months.map(m => <option key={m} value={m}>{fmt.monthName(m)}</option>)}
          </select>
          <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={prov.loading} title="Actualizar datos"
            className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
            <RefreshCw size={16} className={prov.loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 md:px-8 pt-6">
        {selectedCompany === 'ALL'
          ? <p className="text-sm text-gray-600">{fmt.t('selectCompany')}</p>
          : <ProvisionView fmt={fmt} month={month} company={selectedCompany} prov={prov} reload={reload} />}
      </main>
    </div>
  );
}
