import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { syncBusinessCentral } from '@/lib/bcSync';

export const maxDuration = 60; // Max allowed duration on Vercel Hobby
export const dynamic = 'force-dynamic';

// Última sincronización por empresa (ApiConfig 'sync:last:<empresa>'), la escriben los pasos que terminan bien
const LAST = 'sync:last:';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const stats = await syncBusinessCentral(body.company, body.step || 'all');
    if (body.company) {
      const key = LAST + body.company;
      const config = JSON.stringify({ at: new Date().toISOString(), step: body.step || 'all' });
      await prisma.apiConfig.upsert({ where: { key }, update: { config }, create: { key, url: '', config } }).catch(() => {});
    }
    return NextResponse.json({ success: true, stats });
  } catch (error: any) {
    console.error('Error synchronizing with Business Central:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// GET: fecha de la última sincronización de cada empresa
export async function GET() {
  const rows = await prisma.apiConfig.findMany({ where: { key: { startsWith: LAST } } });
  return NextResponse.json(Object.fromEntries(rows.map(r => [r.key.substring(LAST.length), r.updatedAt.toISOString()])));
}
