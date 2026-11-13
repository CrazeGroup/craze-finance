import { readImage } from '@/lib/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Captura de pantalla de un caso de feedback (?id=&n=)
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const img = await readImage(p.get('id') || '', Number(p.get('n')) || 0);
  if (!img) return new Response('No hay imagen', { status: 404 });
  return new Response(new Uint8Array(img.data), { headers: { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400' } });
}
