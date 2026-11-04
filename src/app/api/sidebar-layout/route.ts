import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// Secciones de la barra lateral, comunes a todos los usuarios (ApiConfig sidebar:layout):
// { sections: [{ id, name, items: [href…] }] }. Los apartados que no están en ninguna sección van arriba. Qué secciones
// están plegadas lo guarda cada navegador. Si aún no hay menú global, se parte del último que organizó un usuario
// (antes era por usuario: sidebar:layout:<usuario>)
const KEY = 'sidebar:layout';

export async function GET() {
  const row = (await prisma.apiConfig.findUnique({ where: { key: KEY } }))
    ?? (await prisma.apiConfig.findFirst({ where: { key: { startsWith: `${KEY}:` } }, orderBy: { updatedAt: 'desc' } }));
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
      items: Array.isArray(s.items) ? s.items.map(String).slice(0, 60) : [],
    }));
    const config = JSON.stringify({ sections });
    await prisma.apiConfig.upsert({ where: { key: KEY }, update: { config }, create: { key: KEY, url: '', config } });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
