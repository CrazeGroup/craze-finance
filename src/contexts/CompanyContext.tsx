'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

export const COMPANIES = [
  'ALL',
  'CRAZE',
  'Craze Iberia SL',
  'Craze UK',
  'CRAZE Group AG',
  'Craze Entertainment'
];

type CompanyContextType = {
  selectedCompany: string;
  setSelectedCompany: (company: string) => void;
};

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

// Cada pestaña del navegador trabaja con su propia empresa: se guarda en sessionStorage (por pestaña) y en localStorage
// (la de las pestañas nuevas). Las llamadas a /api/ de la pestaña llevan su empresa en la cabecera x-craze-company,
// que el middleware pone en la cookie craze_selected_company de esa petición; la cookie en sí se reescribe con la
// empresa de la pestaña activa (para enlaces y descargas que no pasan por fetch).
const KEY = 'craze_selected_company';
const companyRef = { current: '' };
// Empresa de esta pestaña fuera de React (p. ej. en funciones auxiliares de una página)
export const tabCompany = () => companyRef.current || COMPANIES[0];
const writeCookie = (company: string) => { document.cookie = `${KEY}=${encodeURIComponent(company)}; path=/; max-age=31536000`; };
const readStorage = (storage: Storage) => { try { const v = storage.getItem(KEY); return v && COMPANIES.includes(v) ? v : null; } catch { return null; } };

function installCompanyFetch() {
  const w = window as typeof window & { __crazeCompanyFetch?: boolean };
  if (w.__crazeCompanyFetch) return;
  w.__crazeCompanyFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let api = false;
    try { const u = new URL(url, window.location.href); api = u.origin === window.location.origin && u.pathname.startsWith('/api/'); } catch { /* URL no válida */ }
    if (!api || !companyRef.current) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('x-craze-company')) headers.set('x-craze-company', encodeURIComponent(companyRef.current));
    return original(input, { ...init, headers });
  };
}

export function CompanyProvider({ children }: { children: React.ReactNode }) {
  const [selectedCompany, setSelectedCompanyState] = useState<string>(COMPANIES[0]);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    const company = readStorage(sessionStorage) || readStorage(localStorage) || COMPANIES[0];
    companyRef.current = company;
    installCompanyFetch();
    try { sessionStorage.setItem(KEY, company); } catch { /* sin almacenamiento */ }
    writeCookie(company);
    setSelectedCompanyState(company);
    setIsMounted(true);
    // Al volver a esta pestaña, la cookie vuelve a ser su empresa
    const onActive = () => { if (document.visibilityState === 'visible') writeCookie(companyRef.current); };
    document.addEventListener('visibilitychange', onActive);
    window.addEventListener('focus', onActive);
    return () => {
      document.removeEventListener('visibilitychange', onActive);
      window.removeEventListener('focus', onActive);
    };
  }, []);

  const setSelectedCompany = (company: string) => {
    companyRef.current = company;
    setSelectedCompanyState(company);
    try {
      sessionStorage.setItem(KEY, company);
      localStorage.setItem(KEY, company);
    } catch { /* sin almacenamiento */ }
    writeCookie(company);
  };

  if (!isMounted) {
    return null; // or a loading spinner, to avoid hydration mismatch
  }

  return (
    <CompanyContext.Provider value={{ selectedCompany, setSelectedCompany }}>
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  const context = useContext(CompanyContext);
  if (context === undefined) {
    throw new Error('useCompany must be used within a CompanyProvider');
  }
  return context;
}
