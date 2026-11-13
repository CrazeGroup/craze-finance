import { getFeedback, readPdf } from '@/lib/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// El PDF de un caso de feedback (?id=)
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id') || '';
  const [f, data] = await Promise.all([getFeedback(id), readPdf(id)]);
  if (!f || !data) return new Response('No hay PDF', { status: 404 });
  return new Response(new Uint8Array(data), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${(f.pdfName || 'factura.pdf').replace(/"/g, '')}"` } });
}
