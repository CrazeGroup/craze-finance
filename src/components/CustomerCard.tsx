import React from 'react';
import { AlertCircle, CheckCircle, Wallet, CreditCard, Clock } from 'lucide-react';
import { useT } from '@/contexts/LanguageContext';

interface CustomerCardProps {
  customer: {
    id: number;
    bcId: string | null;
    name: string;
    paymentMethod: string;
    riskLimit: number;
    balance: number;
    overdueBalance?: number;
    calculatedRisk: string | null;
    suggestedAction: string | null;
  };
}

export function CustomerCard({ customer }: CustomerCardProps) {
  const { t, tx, locale } = useT();
  const isHighRisk = customer.calculatedRisk === 'Alto Riesgo';
  const isNoRisk = customer.calculatedRisk === 'Sin riesgo';
  const isUnused = customer.calculatedRisk === 'Riesgo No Utilizado';

  return (
    <div className={`p-6 rounded-2xl bg-white border ${isHighRisk ? 'border-red-200' : isUnused ? 'border-amber-200' : isNoRisk ? 'border-emerald-200' : 'border-gray-200'} shadow-sm hover:shadow-md transition-all duration-300 hover:scale-[1.02] hover:bg-gray-50`}>
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-xl font-bold text-gray-900 tracking-tight">{customer.name}</h3>
          <p className="text-sm text-gray-500">ID: {customer.bcId || 'N/A'}</p>
        </div>
        <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm font-medium ${isHighRisk ? 'bg-red-100 text-red-700' : isUnused ? 'bg-amber-100 text-amber-700' : isNoRisk ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-700'}`}>
          {isHighRisk ? <AlertCircle size={16} /> : isUnused ? <Clock size={16} /> : <CheckCircle size={16} />}
          {customer.calculatedRisk ? tx(customer.calculatedRisk) : customer.calculatedRisk}
        </div>
      </div>

      <div className="space-y-3 mb-6">
        <div className="flex justify-between items-center text-sm text-gray-500">
          <span className="flex items-center gap-2"><CreditCard size={16} /> {t('Method of Payment')}</span>
          <span className="font-semibold text-gray-900">{customer.paymentMethod}</span>
        </div>
        <div className="flex justify-between items-center text-sm text-gray-500">
          <span className="flex items-center gap-2"><Wallet size={16} /> {t('Open Balance')}</span>
          <span className="font-semibold text-gray-900">€{customer.balance.toLocaleString(locale)}</span>
        </div>
        {(customer.overdueBalance || 0) > 0 && (
          <div className="flex justify-between items-center text-sm text-red-500">
            <span className="flex items-center gap-2"><Clock size={16} /> {t('Overdue Balance')}</span>
            <span className="font-bold">€{customer.overdueBalance!.toLocaleString(locale)}</span>
          </div>
        )}
        <div className="flex justify-between items-center text-sm text-gray-500">
          <span className="flex items-center gap-2"><AlertCircle size={16} /> {t('Risk Limit')}</span>
          <span className="font-semibold text-gray-900">€{customer.riskLimit.toLocaleString(locale)}</span>
        </div>
      </div>

      <div className={`p-4 rounded-xl ${isHighRisk ? 'bg-red-50 border border-red-100' : isUnused ? 'bg-amber-50 border border-amber-100' : 'bg-gray-50'} transition-colors`}>
        <h4 className="text-xs uppercase tracking-wider text-gray-500 mb-1 font-bold">{t('Suggested Action')}</h4>
        <p className={`text-sm font-medium ${isHighRisk ? 'text-red-800' : isUnused ? 'text-amber-800' : 'text-gray-800'}`}>
          {customer.suggestedAction ? tx(customer.suggestedAction) : customer.suggestedAction}
        </p>
      </div>
    </div>
  );
}
