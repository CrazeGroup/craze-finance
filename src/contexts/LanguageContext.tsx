'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

// Idioma de la aplicación (inglés por defecto), elegido en el menú lateral (Config) y guardado en el navegador
export type Lang = 'es' | 'en' | 'de';
export const LANGS: Lang[] = ['en', 'es', 'de'];
export const LANG_NAMES: Record<Lang, string> = { en: 'English', es: 'Español', de: 'Deutsch' };
const KEY = 'crz-app-lang';

type LanguageContextType = { lang: Lang; setLang: (l: Lang) => void };
const LanguageContext = createContext<LanguageContextType>({ lang: 'en', setLang: () => {} });

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as Lang | null;
      if (saved && LANGS.includes(saved)) setLangState(saved);
    } catch { /* sin almacenamiento */ }
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(KEY, l); } catch { /* sin almacenamiento */ }
  };

  return <LanguageContext.Provider value={{ lang, setLang }}>{children}</LanguageContext.Provider>;
}

export const useLanguage = () => useContext(LanguageContext);
