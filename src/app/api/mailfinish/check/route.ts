import { NextResponse } from 'next/server';
import { getBcContext } from '@/lib/bcClient';
import { DFORCE_COMPANY } from '@/lib/dforce';
import { checkOrders } from '@/lib/mailfinish';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Estado en BC (abierta / registrada / no encontrada, con cabecera y líneas) de Assembly Orders creadas desde la app.
// GET ?nos=CEN-AO26-00316,CEN-AO26-00317 o POST { nos: [...] }
async function run(nos: string[]) {
  const list = Array.from(new Set(nos.map(n => n.trim()).filter(Boolean))).slice(0, 300);
  if (!list.length) return NextResponse.json({ error: 'No order numbers.' }, { status: 400 });
  try {
    const ctx = await getBcContext(DFORCE_COMPANY);
    return NextResponse.json({ orders: await checkOrders(ctx, list) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
export async function GET(req: Request) {
  return run((new URL(req.url).searchParams.get('nos') || '').split(','));
}
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return run(Array.isArray(body.nos) ? body.nos : []);
}
