import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Incidencias intercompañía validadas a mano (ApiConfig intercompany:validated), para todas las empresas:
// { 'CRAZE|CRZ-SI26-03458': { by, at } }. GET las devuelve; POST { key, validated } marca o quita la validación
type Validation = { by?: string; at: string };
const KEY = 'intercompany:validated';
async function read(): Promise<Record<string, Validation>> {
  const row = await prisma.apiConfig.findUnique({ where: { key: KEY } });
  try { return row?.config ? JSON.parse(row.config) : {}; } catch { return {}; }
}

export async function GET() {
  try {
    return NextResponse.json({ validated: await read() });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const rowKey = String(body?.key || '');
    if (!/^[^|]{1,60}\|[^|]{1,40}$/.test(rowKey)) return NextResponse.json({ error: 'Factura no válida' }, { status: 400 });
    const all = await read();
    const session: any = await getSession().catch(() => null);
    if (body.validated) all[rowKey] = { by: session?.username || undefined, at: new Date().toISOString() };
    else delete all[rowKey];
    const config = JSON.stringify(all);
    await prisma.apiConfig.upsert({ where: { key: KEY }, update: { config }, create: { key: KEY, url: '', config } });
    return NextResponse.json({ validated: all });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
