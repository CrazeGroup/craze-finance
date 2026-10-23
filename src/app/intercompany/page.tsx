'use client';

import { useMemo } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { makeT } from '../reporting/i18n';
import IntercompanyView from '../controlling/IntercompanyView';

// Intercompany: apartado propio del menú (fuera de Controlling) con el cruce de facturas entre empresas del grupo
export default function IntercompanyPage() {
  const { selectedCompany } = useCompany();
  const fmt = useMemo(() => makeT('es'), []);
  return (
    <div className="rpt-root min-h-screen bg-[#F3F4F7] pb-24">
      <main className="w-full px-4 md:px-8 pt-6">
        <IntercompanyView fmt={fmt} company={selectedCompany} />
      </main>
    </div>
  );
}
