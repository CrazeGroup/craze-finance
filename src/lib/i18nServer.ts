import { cookies } from 'next/headers';
import { LANG_COOKIE, Lang, translate, Vars } from '@/i18n/translate';

// Idioma de la petición (cookie crz-app-lang que pone el selector; inglés por defecto) para los mensajes del servidor.
// Lo que se guarda en caché (avisos de un cálculo) se escribe en inglés y lo traduce la página con tx().
export async function serverLang(): Promise<Lang> {
  try { return (await cookies()).get(LANG_COOKIE)?.value === 'es' ? 'es' : 'en'; } catch { return 'en'; }
}
export async function serverT() {
  const lang = await serverLang();
  return (en: string, vars?: Vars) => translate(lang, en, vars);
}
