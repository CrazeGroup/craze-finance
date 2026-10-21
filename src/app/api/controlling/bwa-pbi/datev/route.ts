import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// BWA (Power BI) · Annual vs DATEV: Jahresübersicht de DATEV (ya leída en el navegador) por empresa y año,
// en ApiConfig controlling:bwa-datev:<empresa>:<año>
const key = (company: string, year: string | number) => `controlling:bwa-datev:${company}:${year}`;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const row = await prisma.apiConfig.findUnique({ where: { key: key(searchParams.get('company') || 'CRAZE', searchParams.get('year') || '') } });
  let file = null;
  try { file = row?.config ? JSON.parse(row.config) : null; } catch { /* ignorar */ }
  return NextResponse.json({ file, updatedAt: row?.updatedAt ?? null });
}

export async function POST(req: Request) {
  try {
    const { company, file } = await req.json();
    if (!company || !file?.year || !Array.isArray(file.accounts) || !file.accounts.length) return NextResponse.json({ error: 'Datos no válidos' }, { status: 400 });
    const config = JSON.stringify(file);
    const k = key(company, file.year);
    await prisma.apiConfig.upsert({ where: { key: k }, update: { config }, create: { key: k, url: '', config } });
    await logAction('BWA (Power BI): Excel DATEV cargado', `${company} ${file.year}: ${file.name} (${file.accounts.length} cuentas, ${file.months} meses)`, company);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
