import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { cached } from './cache';

// Puntos clave del reporting generados con IA a partir de las
// cifras ya calculadas de cada vista. Se guardan en caché por idioma y por contenido.
// Proveedor: Claude (Anthropic) si hay ANTHROPIC_API_KEY; si no, Gemini (GEMINI_API_KEY), como el resto de la app.

export type SummaryLang = 'es' | 'en' | 'de';
export type SummaryView = 'operational' | 'management';

const LANG_NAME: Record<SummaryLang, string> = { es: 'castellano', en: 'English', de: 'Deutsch' };
const LANG_FORMAT: Record<SummaryLang, string> = {
  es: '14,23 M€ para millones y 616 k€ para miles (coma decimal)',
  en: '€14.23M for millions and €616k for thousands (decimal point)',
  de: '14,23 Mio. € für Millionen und 616 T€ für Tausend (Dezimalkomma)',
};

const VIEW_BRIEF: Record<SummaryView, string> = {
  operational: 'inventario por almacén y su variación, top productos que suben/bajan, compras a China (CHINA TRF), cartera sin seguro (Amazon, Aldi, Lidl) y variación del coste medio unitario',
  management: 'cartera de clientes abierta por forma de pago, Amazon, MARKANT (con y sin fecha de pago confirmada), proveedores y facturas de China (CHINA TRF) con y sin fecha de pago programada, provisiones del año, BWA/cuenta de resultados (consolidado y por sociedad, año contra año) y previsión de tesorería frente al límite de descubierto',
};

export async function generateSummary(view: SummaryView, lang: SummaryLang, month: string, company: string, data: unknown, force = false) {
  const useClaude = !!process.env.ANTHROPIC_API_KEY;
  if (!useClaude && !process.env.GEMINI_API_KEY) throw new Error('No hay ninguna IA configurada: añade ANTHROPIC_API_KEY (Claude) o GEMINI_API_KEY (Gemini) en las variables de entorno de Vercel.');
  const payload = JSON.stringify(data);
  const hash = createHash('sha1').update(`${view}|${lang}|${company}|${month}|${payload}`).digest('hex').substring(0, 16);

  return cached(`sum:${useClaude ? 'claude:' : ''}${hash}`, 30 * 24 * 3600 * 1000, async () => {
    const prompt = `Eres el controller financiero de CRAZE Group (juguetes, Alemania/España). Redacta los puntos clave
del reporting mensual para la dirección, vista "${view === 'operational' ? 'Operacional' : 'Dirección'}" (${VIEW_BRIEF[view]}),
empresa ${company}, cierre ${month}.

Reglas:
- Escribe en ${LANG_NAME[lang]}, con la terminología financiera habitual en ese idioma.
- Entre 4 y 6 puntos, cada uno de 1 o 2 frases, con cifras concretas. Formato de importes: ${LANG_FORMAT[lang]}.
- Prioriza lo que requiere atención o decisión: riesgos, desviaciones, vencidos, superación del límite de descubierto, diferencias a conciliar.
- Usa solo los datos proporcionados; no inventes cifras ni causas. Si comparas, indica contra qué periodo y compara siempre la misma sociedad o columna (p. ej. consolidado con consolidado).
- Las provisiones del año son elevadas y todavía tienen mucho saldo abierto: tenlo en cuenta al leer el resultado.
- Marca la cifra principal de cada punto con **negrita** (markdown).
- Devuelve solo un JSON: {"points": ["...", "..."]}

Datos (JSON):
${payload}`;
    const text = useClaude ? await generateWithClaude(prompt) : await generateWithRetry(new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string), prompt);
    const json = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
    const parsed = JSON.parse(json.replace(/^```json\s*|\s*```$/g, ''));
    const points: string[] = Array.isArray(parsed) ? parsed : parsed.points;
    if (!Array.isArray(points) || points.length === 0) throw new Error('La IA no devolvió puntos clave');
    return { points: points.map(String), generatedAt: new Date().toISOString() };
  }, force);
}

// Claude: un único mensaje; el SDK reintenta 429/5xx. Límite de 45 s para no pasar de los 60 s de Vercel.
// fallbacks "default": si los filtros de seguridad rechazan la petición, la API la repite con el modelo recomendado.
async function generateWithClaude(prompt: string): Promise<string> {
  const client = new Anthropic({ timeout: 45_000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') throw new Error('La IA ha rechazado generar los puntos clave.');
    const text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
    if (!text) throw new Error('La IA no devolvió texto');
    return text;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new Error('La clave ANTHROPIC_API_KEY no es válida.');
    if (error instanceof Anthropic.RateLimitError) throw new Error('La IA (Claude) está saturada. Pulsa Regenerar en unos minutos.');
    if (error instanceof Anthropic.APIError) throw new Error(`Error de la IA (Claude ${error.status}): ${String(error.message).substring(0, 160)}`);
    throw error;
  }
}

// Gemini devuelve 503/429 cuando hay mucha demanda: se reintenta y, si sigue, se usa un modelo más ligero.
// Todo dentro de ~50 s para no pasar del límite de 60 s de la función en Vercel.
const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const BUDGET_MS = 50_000;

async function generateWithRetry(genAI: GoogleGenerativeAI, prompt: string): Promise<string> {
  const deadline = Date.now() + BUDGET_MS;
  let lastError: unknown;
  for (const name of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 5_000) break;
      const model = genAI.getGenerativeModel(
        { model: name, generationConfig: { responseMimeType: 'application/json' } },
        { timeout: Math.min(25_000, remaining) }
      );
      try {
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (error: any) {
        lastError = error;
        if (!/\b(429|500|503)\b|overloaded|high demand|unavailable|timeout|abort/i.test(String(error?.message))) throw error;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw new Error(`La IA no está disponible ahora mismo (${String((lastError as any)?.message || lastError).substring(0, 120)}). Pulsa Regenerar en unos minutos.`);
}
