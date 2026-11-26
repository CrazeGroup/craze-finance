'use client';

import { companyLabel, useCompany } from '@/contexts/CompanyContext';
import { useT } from '@/contexts/LanguageContext';
import MailfinishInventoryView from './MailfinishInventoryView';

// Mailfinish Inventory (solo Craze Entertainment): stock de fin de mes de Mailfinish contra BC, ver src/lib/mailfinishInventory.ts
const COMPANY = 'Craze Entertainment';

export default function MailfinishInventoryPage() {
  const { selectedCompany } = useCompany();
  const { t } = useT();

  if (selectedCompany !== COMPANY) {
    return (
      <div className="min-h-screen bg-[#F3F4F7] p-8">
        <p className="text-sm text-gray-600">{t('{module} is only available for {company}. Select it in the side menu.', { module: 'Mailfinish Inventory', company: companyLabel(COMPANY) })}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3">
          <p className="font-bold text-gray-900 leading-tight text-lg">Mailfinish Inventory</p>
          <p className="text-xs text-gray-500">{companyLabel(COMPANY)}</p>
        </div>
      </header>
      <main className="w-full px-4 md:px-8 pt-6">
        <MailfinishInventoryView />
      </main>
    </div>
  );
}
