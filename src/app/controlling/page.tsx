'use client';

import { useEffect, useMemo, useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { makeT } from '../reporting/i18n';
import { useT } from '@/contexts/LanguageContext';
import PurchaseItemsView from './PurchaseItemsView';
import PurchaseVendorsView from './PurchaseVendorsView';
import ConsumedProvisionsView from './ConsumedProvisionsView';
import LicenseSalesView from './LicenseSalesView';
import OrderIntakeView from './OrderIntakeView';
import BwaPbiView from './BwaPbiView';

// Controlling: varios reportes de control que se cambian con las pestañas de la cabecera (como en Reporting).
const REPORTS = [
  { id: 'purchase-items', label: 'Purchases by item' },
  { id: 'purchase-vendors', label: 'Purchases by vendor' },
  { id: 'consumed-provisions', label: 'Consumed Provisions' },
  { id: 'license-sales', label: 'Sales by license' },
  { id: 'order-intake', label: 'Invoicing by Order Date' },
  { id: 'bwa-pbi', label: 'BWA (Power BI)' },
] as const;
type ReportId = typeof REPORTS[number]['id'];

export default function ControllingPage() {
  const { selectedCompany } = useCompany();
  const { t, lang } = useT();
  const fmt = useMemo(() => makeT(lang), [lang]);
  const [report, setReport] = useState<ReportId>('purchase-items');

  useEffect(() => {
    try {
      const saved = localStorage.getItem('crz-controlling-report');
      if (REPORTS.some(r => r.id === saved)) setReport(saved as ReportId);
    } catch { /* sin almacenamiento */ }
  }, []);
  const change = (id: ReportId) => {
    setReport(id);
    try { localStorage.setItem('crz-controlling-report', id); } catch { /* sin almacenamiento */ }
  };

  return (
    <div className="rpt-root min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight">Controlling</p>
            <p className="text-xs text-gray-500">{selectedCompany}</p>
          </div>
          <div className="flex bg-gray-100 rounded-lg p-1">
            {REPORTS.map(r => (
              <button key={r.id} onClick={() => change(r.id)}
                className={`px-4 py-1.5 rounded-md text-sm font-semibold ${report === r.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                {t(r.label)}
              </button>
            ))}
          </div>
        </div>
      </header>
      <main className="w-full px-4 md:px-8 pt-6">
        {selectedCompany === 'ALL' && report === 'consumed-provisions' ? <p className="text-sm text-gray-600">{fmt.t('selectCompany')}</p>
          : report === 'purchase-items' ? <PurchaseItemsView fmt={fmt} company={selectedCompany} />
          : report === 'purchase-vendors' ? <PurchaseVendorsView fmt={fmt} company={selectedCompany} />
          : report === 'bwa-pbi' ? <BwaPbiView fmt={fmt} />
          : report === 'order-intake' ? <OrderIntakeView fmt={fmt} company={selectedCompany} />
          : report === 'license-sales' ? <LicenseSalesView fmt={fmt} company={selectedCompany} />
          : <ConsumedProvisionsView fmt={fmt} company={selectedCompany} />}
      </main>
    </div>
  );
}
