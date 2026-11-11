import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Comentarios de la app en los movimientos abiertos, por empresa (ApiConfig open-entries:comments:<empresa>):
// { 'Customer:387011': { text, by, at } }. GET los devuelve; POST { key, text } guarda (vacío = borra)
type Comment = { text: string; by?: string; at: string };
const keyOf = async () => `open-entries:comments:${(await cookies()).get('craze_selected_company')?.value || 'CRAZE'}`;
async function read(k: string): Promise<Record<string, Comment>> {
  const row = await prisma.apiConfig.findUnique({ where: { key: k } });
  try { return row?.config ? JSON.parse(row.config) : {}; } catch { return {}; }
}

export async function GET() {
  try {
    return NextResponse.json({ comments: await read(await keyOf()) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const lineKey = String(body?.key || '');
    if (!/^(Customer|Vendor):\d+$/.test(lineKey)) return NextResponse.json({ error: 'Línea no válida' }, { status: 400 });
    const k = await keyOf();
    const all = await read(k);
    const text = String(body.text || '').trim().slice(0, 1000);
    const session: any = await getSession().catch(() => null);
    if (text) all[lineKey] = { text, by: session?.username, at: new Date().toISOString() };
    else delete all[lineKey];
    const config = JSON.stringify(all);
    await prisma.apiConfig.upsert({ where: { key: k }, update: { config }, create: { key: k, url: '', config } });
    return NextResponse.json({ comments: all });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
