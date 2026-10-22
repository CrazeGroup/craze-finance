'use client';

import { useEffect, useState } from 'react';
import { COMPANIES } from '@/contexts/CompanyContext';

// Selector de empresa de cada informe de Controlling (como el de BWA (Power BI)). "CRAZE Consolidated" suma todas las
// empresas (en EUR cuando el informe lo convierte); arranca con la empresa del menú.
export const CONSOLIDATED = 'CRAZE Consolidated';
export const REPORT_COMPANIES = COMPANIES.filter(c => c !== 'ALL');

export function useReportCompany(globalCompany: string, allowConsolidated = true) {
  const initial = globalCompany === 'ALL' ? (allowConsolidated ? CONSOLIDATED : 'CRAZE') : globalCompany;
  const [company, setCompany] = useState(initial);
  useEffect(() => { setCompany(initial); }, [initial]);
  return [company, setCompany] as const;
}

export default function CompanySelect({ value, onChange, allowConsolidated = true }: { value: string; onChange: (v: string) => void; allowConsolidated?: boolean }) {
  return (
    <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
      CRAZE Company
      <select value={value} onChange={e => onChange(e.target.value)}
        className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal">
        {allowConsolidated && <option value={CONSOLIDATED}>{CONSOLIDATED}</option>}
        {REPORT_COMPANIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </label>
  );
}
