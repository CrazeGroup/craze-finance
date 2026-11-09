import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';
import { importClosingWorkbook } from '@/lib/closing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Importa el Excel de tareas (multipart file, year): una pestaña por empresa; sustituye las tareas de ese año
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    const year = parseInt(String(form.get('year') || ''), 10);
    if (!(file instanceof File)) return NextResponse.json({ error: 'Sube el Excel de tareas.' }, { status: 400 });
    if (!year) return NextResponse.json({ error: 'Indica el año.' }, { status: 400 });
    const result = await importClosingWorkbook(new Uint8Array(await file.arrayBuffer()), year, ((await getSession())?.username as string) || null);
    await logAction('Cierre mensual: Excel importado', `${file.name} · ${year} · ${result.summary.map(s => `${s.company} ${s.tasks}`).join(', ')}`);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Cierre mensual importación:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
