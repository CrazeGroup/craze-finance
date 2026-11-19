'use client';

import { useEffect, useState } from 'react';
import { companyLabel, useCompany } from '@/contexts/CompanyContext';
import { useT } from '@/contexts/LanguageContext';
import DForceView from './DForceView';
import MailfinishView from './MailfinishView';

// D-FORCE/MF (antes MAGAZINES; solo Craze Entertainment): las revistas de D-FORCE, con una pestaña por proceso
const TABS = [
  { id: 'dforce', label: 'D-FORCE' },
  { id: 'mailfinish', label: 'MAILFINISH' },
] as const;
type TabId = typeof TABS[number]['id'];
const COMPANY = 'Craze Entertainment';

export default function MagazinesPage() {
  const { selectedCompany } = useCompany();
  const { t } = useT();
  const [tab, setTab] = useState<TabId>('dforce');

  useEffect(() => {
    try {
      const saved = localStorage.getItem('crz-magazines-tab');
      if (TABS.some(t => t.id === saved)) setTab(saved as TabId);
    } catch { /* sin almacenamiento */ }
  }, []);
  const change = (id: TabId) => {
    setTab(id);
    try { localStorage.setItem('crz-magazines-tab', id); } catch { /* sin almacenamiento */ }
  };

  if (selectedCompany !== COMPANY) {
    return (
      <div className="min-h-screen bg-[#F3F4F7] p-8">
        <p className="text-sm text-gray-600">{t('{module} is only available for {company}. Select it in the side menu.', { module: 'D-FORCE/MF', company: companyLabel(COMPANY) })}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg">D-FORCE/MF</p>
            <p className="text-xs text-gray-500">{companyLabel(COMPANY)}</p>
          </div>
          <div className="flex bg-gray-100 rounded-lg p-1">
            {TABS.map(tb => (
              <button key={tb.id} onClick={() => change(tb.id)}
                className={`px-4 py-1.5 rounded-md text-sm font-semibold ${tab === tb.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                {tb.label}
              </button>
            ))}
          </div>
        </div>
      </header>
      <main className="w-full px-4 md:px-8 pt-6">
        {tab === 'dforce' ? <DForceView /> : <MailfinishView />}
      </main>
    </div>
  );
}
