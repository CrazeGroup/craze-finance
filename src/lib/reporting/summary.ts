import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { cached } from './cache';

// Puntos clave del reporting generados con IA (Gemini, igual que el resto de la app) a partir de las
// cifras ya calculadas de cada vista. Se guardan en caché por idioma y por contenido.

export type SummaryLang = 'es' | 'en' | 'de';
export type SummaryView = 'operational' | 'management';

const LANG_NAME: Record<SummaryLang, string> = { es: 'castellano', en: 'English', de: 'Deutsch' };

const VIEW_BRIEF: Record<SummaryView, string> = {
  operational: 'inventario por almacén y su variación, top productos que suben/bajan, compras a China (CHINA TRF), cartera sin seguro (Amazon, Aldi, Lidl) y variación del coste medio unitario',
  management: 'cartera de clientes abierta por forma de pago, Amazon, MARKANT (con y sin fecha de pago confirmada), proveedores y facturas de China (CHINA TRF) con y sin fecha de pago programada, provisiones del año, BWA/cuenta de resultados (consolidado y por sociedad, año contra año) y previsión de tesorería frente al límite de descubierto',
};

export async function generateSummary(view: SummaryView, lang: SummaryLang, month: string, company: string, data: unknown, force = false) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');
  const payload = JSON.stringify(data);
  const hash = createHash('sha1').update(`${view}|${lang}|${company}|${month}|${payload}`).digest('hex').substring(0, 16);

  return cached(`sum:${hash}`, 30 * 24 * 3600 * 1000, async () => {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
    const prompt = `Eres el controller financiero de CRAZE Group (juguetes, Alemania/España). Redacta los puntos clave
del reporting mensual para la dirección, vista "${view === 'operational' ? 'Operacional' : 'Dirección'}" (${VIEW_BRIEF[view]}),
empresa ${company}, cierre ${month}.

Reglas:
- Escribe en ${LANG_NAME[lang]}, con la terminología financiera habitual en ese idioma.
- Entre 4 y 6 puntos, cada uno de 1 o 2 frases, con cifras concretas (formato de importes del idioma, p. ej. 14,23 M€ / €14.23M / 14,23 Mio. €; k€ para miles).
- Prioriza lo que requiere atención o decisión: riesgos, desviaciones, vencidos, superación del límite de descubierto, diferencias a conciliar.
- Usa solo los datos proporcionados; no inventes cifras ni causas. Si comparas, indica contra qué periodo.
- Las provisiones del año son elevadas y todavía tienen mucho saldo abierto: tenlo en cuenta al leer el resultado.
- Marca la cifra principal de cada punto con **negrita** (markdown).
- Devuelve solo un JSON: {"points": ["...", "..."]}

Datos (JSON):
${payload}`;
    const text = await generateWithRetry(genAI, prompt);
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
    const points: string[] = Array.isArray(parsed) ? parsed : parsed.points;
    if (!Array.isArray(points) || points.length === 0) throw new Error('La IA no devolvió puntos clave');
    return { points: points.map(String), generatedAt: new Date().toISOString() };
  }, force);
}

// Gemini devuelve 503/429 cuando hay mucha demanda: se reintenta y, si sigue, se usa un modelo más ligero
const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

async function generateWithRetry(genAI: GoogleGenerativeAI, prompt: string): Promise<string> {
  let lastError: unknown;
  for (const name of MODELS) {
    const model = genAI.getGenerativeModel({ model: name, generationConfig: { responseMimeType: 'application/json' } });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (error: any) {
        lastError = error;
        if (!/\b(429|500|503)\b|overloaded|high demand|unavailable/i.test(String(error?.message))) throw error;
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
