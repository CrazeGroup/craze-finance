// Traducción de la app: los textos se escriben en INGLÉS en el código (idioma base) y, con el idioma "es", se buscan en
// el diccionario castellano (src/i18n/es/*.ts, clave = el texto inglés exacto). Lo que no está en el diccionario se ve
// en inglés.
// - t('Open invoices') → 'Facturas abiertas'
// - Variables: t('{n} invoices', { n: 3 }) → '3 facturas' (la clave lleva {n}; en el texto castellano también)
// - Textos que llegan ya montados del servidor (avisos, errores, notas con números o nombres dentro): tx(texto) busca
//   la clave exacta y si no, las claves con {variables} como plantilla ('Replaces {old} (cancelled with {memo})')
import ES from './es';

export type Lang = 'en' | 'es';
export const LANGS: Lang[] = ['en', 'es'];
export const LANG_NAMES: Record<Lang, string> = { en: 'English', es: 'Español' };
export const LOCALE: Record<Lang, string> = { en: 'en-GB', es: 'es-ES' };
export const LANG_COOKIE = 'crz-app-lang';

export type Vars = Record<string, string | number | null | undefined>;
const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k]))) : s);

// Plantillas: claves con {variables}, de más larga a más corta (la más específica gana)
let patterns: { re: RegExp; names: string[]; es: string }[] | null = null;
function compiled() {
  if (patterns) return patterns;
  patterns = Object.entries(ES)
    .filter(([k]) => /\{\w+\}/.test(k))
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k, es]) => {
      const names: string[] = [];
      const src = k.split(/(\{\w+\})/).map(part => {
        const m = part.match(/^\{(\w+)\}$/);
        if (m) { names.push(m[1]); return '([\\s\\S]+?)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      return { re: new RegExp(`^${src}$`), names, es };
    });
  return patterns;
}

export function translate(lang: Lang, en: string, vars?: Vars): string {
  if (lang !== 'es' || !en) return fill(en, vars);
  const hit = ES[en];
  return fill(hit ?? en, vars);
}

// Texto ya montado (del servidor): exacto, si no por plantilla; los valores capturados también se intentan traducir
export function translateText(lang: Lang, text: string): string {
  if (lang !== 'es' || !text) return text;
  const hit = ES[text];
  if (hit !== undefined) return hit;
  for (const p of compiled()) {
    const m = text.match(p.re);
    if (!m) continue;
    const vars: Vars = {};
    p.names.forEach((n, i) => { vars[n] = ES[m[i + 1]] ?? m[i + 1]; });
    return fill(p.es, vars);
  }
  // Varios avisos unidos con " · " o "; ": cada trozo por separado
  for (const sep of [' · ', '; ']) {
    if (text.includes(sep)) {
      const parts = text.split(sep);
      const out = parts.map(x => translateText(lang, x));
      if (out.some((x, i) => x !== parts[i])) return out.join(sep);
    }
  }
  return text;
}
