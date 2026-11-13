import prisma from '@/lib/prisma';

// Feedback de OCR y BANCO: cada caso en ApiConfig feedback:<id> (JSON) y su PDF, si lo hay, en feedback-pdf:<id>
// (base64). kind auto = lo que el usuario cambió de la propuesta al enviarla a BC; manual = botón "Algo está mal".
// Claude los lee con GET /api/feedback y los marca como aplicados con PATCH al corregir las reglas.
export type FeedbackStatus = 'pending' | 'applied' | 'dismissed';
export type Feedback = {
  id: string; at: string; by: string; company: string; area: 'ocr' | 'banco'; kind: 'auto' | 'manual';
  title: string; message: string; changes: string[]; context: unknown; hasPdf: boolean; pdfName?: string;
  status: FeedbackStatus; resolution?: string; resolvedBy?: string; resolvedAt?: string;
};
export const PREFIX = 'feedback:';
export const PDF_PREFIX = 'feedback-pdf:';

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
export async function readPdf(id: string) {
  const row = await prisma.apiConfig.findUnique({ where: { key: PDF_PREFIX + id } });
  return row?.config ? Buffer.from(row.config, 'base64') : null;
}
