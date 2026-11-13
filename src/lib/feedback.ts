import prisma from '@/lib/prisma';

// Feedback de OCR y BANCO: cada caso en ApiConfig feedback:<id> (JSON) y su PDF, si lo hay, en feedback-pdf:<id>
// (base64) y las capturas de pantalla en feedback-img:<id>:<n> ({ type, data } en base64). kind auto = lo que el usuario cambió de la propuesta al enviarla a BC; manual = botón "Algo está mal".
// Claude los lee con GET /api/feedback y los marca como aplicados con PATCH al corregir las reglas.
export type FeedbackStatus = 'pending' | 'applied' | 'dismissed';
export type Feedback = {
  id: string; at: string; by: string; company: string; area: 'ocr' | 'banco'; kind: 'auto' | 'manual';
  title: string; message: string; changes: string[]; context: unknown; hasPdf: boolean; pdfName?: string;
  images?: { name: string; type: string }[];
  status: FeedbackStatus; resolution?: string; resolvedBy?: string; resolvedAt?: string;
};
export const PREFIX = 'feedback:';
export const PDF_PREFIX = 'feedback-pdf:';
export const IMG_PREFIX = 'feedback-img:';

export async function listFeedback(): Promise<Feedback[]> {
  const rows = await prisma.apiConfig.findMany({ where: { key: { startsWith: PREFIX } } });
  return rows.map(r => { try { return JSON.parse(r.config || '') as Feedback; } catch { return null; } })
    .filter((f): f is Feedback => !!f).sort((a, b) => b.at.localeCompare(a.at));
}
export async function getFeedback(id: string) {
  const row = await prisma.apiConfig.findUnique({ where: { key: PREFIX + id } });
  try { return row?.config ? (JSON.parse(row.config) as Feedback) : null; } catch { return null; }
}
export async function saveFeedback(f: Feedback) {
  const config = JSON.stringify(f);
  await prisma.apiConfig.upsert({ where: { key: PREFIX + f.id }, update: { config }, create: { key: PREFIX + f.id, url: '', config } });
}
export async function savePdf(id: string, data: Buffer) {
  const config = data.toString('base64');
  await prisma.apiConfig.upsert({ where: { key: PDF_PREFIX + id }, update: { config }, create: { key: PDF_PREFIX + id, url: '', config } });
}
export async function saveImage(id: string, n: number, type: string, data: Buffer) {
  const key = `${IMG_PREFIX}${id}:${n}`;
  const config = JSON.stringify({ type, data: data.toString('base64') });
  await prisma.apiConfig.upsert({ where: { key }, update: { config }, create: { key, url: '', config } });
}
export async function readImage(id: string, n: number) {
  const row = await prisma.apiConfig.findUnique({ where: { key: `${IMG_PREFIX}${id}:${n}` } });
  try { const x = JSON.parse(row?.config || ''); return { type: String(x.type || 'image/jpeg'), data: Buffer.from(x.data, 'base64') }; } catch { return null; }
}
export async function readPdf(id: string) {
  const row = await prisma.apiConfig.findUnique({ where: { key: PDF_PREFIX + id } });
  return row?.config ? Buffer.from(row.config, 'base64') : null;
}
