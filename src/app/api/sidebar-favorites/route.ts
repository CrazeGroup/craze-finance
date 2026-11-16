import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Apartados favoritos del menú, de cada usuario (ApiConfig sidebar:favorites:<usuario>): { items: [href…] } en el orden
// en que se marcaron. La barra lateral los muestra arriba del todo.
const keyFor = (s: any) => `sidebar:favorites:${String(s?.username || s?.id || 'anon').toLowerCase()}`;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ items: [] });
  const row = await prisma.apiConfig.findUnique({ where: { key: keyFor(session) } });
  try {
    const d = row?.config ? JSON.parse(row.config) : {};
    return NextResponse.json({ items: Array.isArray(d.items) ? d.items : [] });
  } catch {
    return NextResponse.json({ items: [] });
  }
}

export async function PUT(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = await req.json();
    if (!Array.isArray(body?.items)) return NextResponse.json({ error: 'Datos no válidos' }, { status: 400 });
    const items = [...new Set(body.items.map(String).filter((h: string) => h.startsWith('/')))].slice(0, 60);
    const key = keyFor(session), config = JSON.stringify({ items });
    await prisma.apiConfig.upsert({ where: { key }, update: { config }, create: { key, url: '', config } });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
