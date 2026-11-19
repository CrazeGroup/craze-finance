'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { LANG_COOKIE, LANG_NAMES, LANGS, LOCALE, Lang, translate, translateText, Vars } from '@/i18n/translate';

// Idioma de la aplicación: inglés por defecto (los textos del código están en inglés) o castellano, elegido en el menú
// lateral y guardado en el navegador y en la cookie crz-app-lang (para que el servidor responda en ese idioma).
export type { Lang };
export { LANGS, LANG_NAMES };
const KEY = 'crz-app-lang';

type LanguageContextType = { lang: Lang; setLang: (l: Lang) => void };
const LanguageContext = createContext<LanguageContextType>({ lang: 'en', setLang: () => {} });

const writeCookie = (l: Lang) => { try { document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`; } catch { /* sin cookies */ } };

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');

  useEffect(() => {
    let l: Lang = 'en';
    try {
      const saved = localStorage.getItem(KEY) as Lang | null;
      if (saved && LANGS.includes(saved)) l = saved;
    } catch { /* sin almacenamiento */ }
    setLangState(l);
    writeCookie(l);
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    writeCookie(l);
    try { localStorage.setItem(KEY, l); } catch { /* sin almacenamiento */ }
  };

  return <LanguageContext.Provider value={{ lang, setLang }}>{children}</LanguageContext.Provider>;
}

export const useLanguage = () => useContext(LanguageContext);

// t('English text', vars) → texto en el idioma elegido; tx(texto del servidor) → traducido por plantilla;
// locale para fechas y números (en-GB / es-ES)
export function useT() {
  const { lang } = useContext(LanguageContext);
  const t = useCallback((en: string, vars?: Vars) => translate(lang, en, vars), [lang]);
  const tx = useCallback((text: string) => translateText(lang, text), [lang]);
  return { t, tx, lang, locale: LOCALE[lang] };
}
