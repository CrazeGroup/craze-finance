import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Controlling · comparación de BWA: los dos Excel de Profit & Loss (ya leídos en el navegador) se guardan por
// empresa en ApiConfig, claves controlling:pl:<empresa>:<A|B>.
const SLOTS = ['A', 'B'] as const;
const key = (company: string, slot: string) => `controlling:pl:${company}:${slot}`;

async function company(req?: Request) {
  const cookieStore = await cookies();
  const param = req ? new URL(req.url).searchParams.get('company') : null;   // ?company= (selector del informe)
  return param || cookieStore.get('craze_selected_company')?.value || 'CRAZE';
}

export async function GET(req: Request) {
  const c = await company(req);
  const rows = await prisma.apiConfig.findMany({ where: { key: { in: SLOTS.map(s => key(c, s)) } } });
  const out: Record<string, unknown> = { A: null, B: null };
  for (const r of rows) {
    try { out[r.key.split(':').pop() as string] = JSON.parse(r.config || 'null'); } catch { /* ignorar */ }
  }
  return NextResponse.json(out);
}

export async function POST(req: Request) {
  try {
    const { slot, file } = await req.json();
    if (!SLOTS.includes(slot) || !file?.rows?.length) return NextResponse.json({ error: 'Datos no válidos' }, { status: 400 });
    const c = await company(req);
    const config = JSON.stringify(file);
    await prisma.apiConfig.upsert({ where: { key: key(c, slot) }, update: { config }, create: { key: key(c, slot), url: '', config } });
    await logAction('Controlling: Excel P&L cargado', `Periodo ${slot}: ${file.name} (${file.rows.length} filas)`);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const slot = new URL(req.url).searchParams.get('slot') || '';
  if (!SLOTS.includes(slot as any)) return NextResponse.json({ error: 'Periodo no válido' }, { status: 400 });
  const c = await company(req);
  await prisma.apiConfig.deleteMany({ where: { key: key(c, slot) } });
  await logAction('Controlling: Excel P&L eliminado', `Periodo ${slot}`);
  return NextResponse.json({ ok: true });
}
