import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Mínimo del saldo consolidado por empresa (ApiConfig cashflow:minBalance:<empresa> = { amount, currency })
const key = async () => `cashflow:minBalance:${(await cookies()).get('craze_selected_company')?.value || 'CRAZE'}`;

export async function GET() {
  const row = await prisma.apiConfig.findUnique({ where: { key: await key() } });
  try { return NextResponse.json(JSON.parse(row?.config || 'null')); } catch { return NextResponse.json(null); }
}

export async function PUT(req: Request) {
  try {
    const { amount, currency } = await req.json();
    const k = await key();
    if (amount === null || amount === '' || amount === undefined) {
      await prisma.apiConfig.deleteMany({ where: { key: k } });
      await logAction('Cashflow: mínimo de saldo consolidado eliminado');
      return NextResponse.json(null);
    }
    const value = { amount: Number(amount), currency: String(currency || 'EUR') };
    if (!isFinite(value.amount)) return NextResponse.json({ error: 'Importe no válido' }, { status: 400 });
    const config = JSON.stringify(value);
    await prisma.apiConfig.upsert({ where: { key: k }, update: { config }, create: { key: k, url: '', config } });
    await logAction('Cashflow: mínimo de saldo consolidado', `${value.amount} ${value.currency}`);
    return NextResponse.json(value);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
