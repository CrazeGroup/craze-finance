import { GoogleGenerativeAI } from '@google/generative-ai';

// IA de la app (puntos clave del Reporting, extracción y bot de Seguros y Contratos).
// Proveedor: OpenRouter si hay OPENROUTER_API_KEY (modelo OPENROUTER_MODEL, por defecto Claude Sonnet 5.5, que lee
// PDFs); si no, Gemini con GEMINI_API_KEY como antes. Las partes siguen el formato de Gemini: texto o
// { inlineData: { data: base64, mimeType } } (PDF o imagen).

export type AiPart = string | { inlineData: { data: string; mimeType: string } };

const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';

export const aiConfigured = () => !!(process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY);
export const AI_NOT_CONFIGURED = 'No hay ninguna IA configurada: añade OPENROUTER_API_KEY (o GEMINI_API_KEY) en las variables de entorno de Vercel.';
export const aiProvider = () => (process.env.OPENROUTER_API_KEY ? `openrouter:${process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL}` : 'gemini');

export async function generateText(parts: AiPart[], opts: { json?: boolean; timeoutMs?: number } = {}): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) return openRouter(parts, opts);
  if (!process.env.GEMINI_API_KEY) throw new Error(AI_NOT_CONFIGURED);
  const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel(
    { model: 'gemini-flash-latest', ...(opts.json ? { generationConfig: { responseMimeType: 'application/json' } } : {}) },
    opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
  );
  const result = await model.generateContent(parts);
  return result.response.text();
}

async function openRouter(parts: AiPart[], opts: { json?: boolean; timeoutMs?: number }): Promise<string> {
  const content = parts.map((p, i) => {
    if (typeof p === 'string') return { type: 'text', text: p };
    const { data, mimeType } = p.inlineData;
    return mimeType.startsWith('image/')
      ? { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
      : { type: 'file', file: { filename: `documento-${i + 1}.pdf`, file_data: `data:${mimeType};base64,${data}` } };
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 50_000);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'Craze Finance',
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
        messages: [{ role: 'user', content }],
        max_tokens: 8000,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const msg = data.error?.message || `HTTP ${res.status}`;
      if (res.status === 401) throw new Error('La clave OPENROUTER_API_KEY no es válida.');
      if (res.status === 402) throw new Error('OpenRouter: sin saldo suficiente en la cuenta.');
      if (res.status === 429) throw new Error('La IA está saturada (OpenRouter 429). Prueba en unos minutos.');
      throw new Error(`Error de la IA (OpenRouter): ${String(msg).substring(0, 200)}`);
    }
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('La IA no devolvió texto.');
    return typeof text === 'string' ? text : text.map((c: any) => c.text || '').join('');
  } catch (e: any) {
    if (e.name === 'AbortError') throw new Error('La IA ha tardado demasiado en responder. Prueba de nuevo.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
