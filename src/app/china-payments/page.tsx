'use client';

import ChinaPaymentsView from './ChinaPaymentsView';
import { useCompany } from '@/contexts/CompanyContext';
import { useT } from '@/contexts/LanguageContext';

// China Payments: previsión de pagos a los proveedores CHINA TRF por Scheduled Payment Date (editable, se escribe en BC)
export default function ChinaPaymentsPage() {
  const { t } = useT();
  const { selectedCompany } = useCompany();
  return (
    <div className="w-full px-4 md:px-8 py-8">
      <h1 className="text-4xl font-black text-black mb-2">{t('China Payments')}</h1>
      <p className="text-gray-700 font-semibold text-sm mb-6">{t('Payment forecast to China vendors (CHINA TRF)')}</p>
      {/* key: recarga al cambiar de empresa */}
      <ChinaPaymentsView key={selectedCompany} />
    </div>
  );
}
