import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Secciones de la barra lateral de cada usuario (ApiConfig sidebar:layout:<usuario>):
// { sections: [{ id, name, items: [href…], collapsed }] }. Los apartados que no están en ninguna sección van arriba.
async function key() {
  const session: any = await getSession();
  return `sidebar:layout:${session?.username || 'default'}`;
}

export async function GET() {
  const row = await prisma.apiConfig.findUnique({ where: { key: await key() } });
  try {
    return NextResponse.json(row?.config ? JSON.parse(row.config) : { sections: [] });
  } catch {
    return NextResponse.json({ sections: [] });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    if (!Array.isArray(body?.sections)) return NextResponse.json({ error: 'Datos no válidos' }, { status: 400 });
    const sections = body.sections.slice(0, 30).map((s: any) => ({
      id: String(s.id).slice(0, 40), name: String(s.name || 'Sección').slice(0, 60),
      items: Array.isArray(s.items) ? s.items.map(String).slice(0, 60) : [], collapsed: !!s.collapsed,
    }));
    const k = await key();
    const config = JSON.stringify({ sections });
    await prisma.apiConfig.upsert({ where: { key: k }, update: { config }, create: { key: k, url: '', config } });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
