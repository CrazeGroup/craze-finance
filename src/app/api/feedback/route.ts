import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/auth';
import { getFeedback, listFeedback, saveFeedback, savePdf, type Feedback, type FeedbackStatus } from '@/lib/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const user = async () => ((await getSession().catch(() => null)) as any)?.username || '';

// GET: todos los casos (?status=pending para los pendientes; ?area=ocr|banco)
export async function GET(req: Request) {
  try {
    const p = new URL(req.url).searchParams;
    let items = await listFeedback();
    if (p.get('status')) items = items.filter(f => f.status === p.get('status'));
    if (p.get('area')) items = items.filter(f => f.area === p.get('area'));
    return NextResponse.json({ items });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST multipart: data = { area, kind, title, message, changes, context }, pdf = el PDF (opcional, ≤ 4 MB)
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const data = JSON.parse(String(form.get('data') || '{}'));
    const area = data.area === 'banco' ? 'banco' : data.area === 'ocr' ? 'ocr' : null;
    if (!area) return NextResponse.json({ error: 'Área no válida' }, { status: 400 });
    const kind = data.kind === 'auto' ? 'auto' : 'manual';
    const message = String(data.message || '').trim().slice(0, 4000);
    if (kind === 'manual' && !message) return NextResponse.json({ error: 'Escribe qué está mal.' }, { status: 400 });
    const pdf = form.get('pdf');
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const hasPdf = pdf instanceof File && pdf.size > 0 && pdf.size <= 4 * 1024 * 1024;
    if (hasPdf) await savePdf(id, Buffer.from(await (pdf as File).arrayBuffer()));
    const f: Feedback = {
      id, at: new Date().toISOString(), by: await user(), company: (await cookies()).get('craze_selected_company')?.value || 'CRAZE',
      area, kind, title: String(data.title || '').slice(0, 300), message,
      changes: Array.isArray(data.changes) ? data.changes.map(String).slice(0, 50) : [],
      context: data.context ?? null, hasPdf, pdfName: hasPdf ? (pdf as File).name : undefined, status: 'pending',
    };
    await saveFeedback(f);
    return NextResponse.json({ ok: true, id });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// PATCH { id, status?, resolution? }: estado del caso y nota de lo que se ha corregido
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const f = await getFeedback(String(body?.id || ''));
    if (!f) return NextResponse.json({ error: 'No existe' }, { status: 404 });
    if (['pending', 'applied', 'dismissed'].includes(body.status)) {
      f.status = body.status as FeedbackStatus;
      if (f.status === 'pending') { delete f.resolvedBy; delete f.resolvedAt; }
      else { f.resolvedBy = String(body.by || (await user()) || ''); f.resolvedAt = new Date().toISOString(); }
    }
    if (typeof body.resolution === 'string') f.resolution = body.resolution.slice(0, 4000);
    await saveFeedback(f);
    return NextResponse.json({ item: f });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE ?id=: borra un caso y su PDF (pruebas)
export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id') || '';
    const prisma = (await import('@/lib/prisma')).default;
    await prisma.apiConfig.deleteMany({ where: { key: { in: [`feedback:${id}`, `feedback-pdf:${id}`] } } });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
