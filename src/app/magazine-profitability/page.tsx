'use client';

import { companyLabel, useCompany } from '@/contexts/CompanyContext';
import MagazineProfitabilityView from './MagazineProfitabilityView';

// Magazine Profitability (solo Craze Entertainment): beneficio por revista, ver src/lib/magazineAnalysis.ts
const COMPANY = 'Craze Entertainment';

export default function MagazineProfitabilityPage() {
  const { selectedCompany } = useCompany();

  if (selectedCompany !== COMPANY) {
    return (
      <div className="min-h-screen bg-[#F3F4F7] p-8">
        <p className="text-sm text-gray-600">Magazine Profitability solo está disponible para {companyLabel(COMPANY)}. Selecciónala en el menú lateral.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3">
          <p className="font-bold text-gray-900 leading-tight text-lg">Magazine Profitability</p>
          <p className="text-xs text-gray-500">{companyLabel(COMPANY)}</p>
        </div>
      </header>
      <main className="w-full px-4 md:px-8 pt-6">
        <MagazineProfitabilityView />
      </main>
    </div>
  );
}
