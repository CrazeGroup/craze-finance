import { NextResponse } from 'next/server';
import { getBcContext } from '@/lib/bcClient';
import { DFORCE_COMPANY } from '@/lib/dforce';
import { createDocument, createJournalLines, existingDocs, existingJournalLines, KIND_LABEL, type DForceKind } from '@/lib/dforceBc';
import { logAction } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una línea de BC por llamada (más el proyecto por OData): una factura de D-FORCE puede tener cien líneas
export const maxDuration = 300;

const KINDS: DForceKind[] = ['invoice', 'credit', 'purchase', 'journal'];
const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

// Crea en BC (sin registrar) un documento de la Gutschrift de D-FORCE, o envía las provisiones al lote D-FORCE.
// Multipart: data = { kind, ref (nº de Gutschrift), date, lines, force }, pdf y excel (se adjuntan).
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const body = JSON.parse(String(form.get('data') || '{}')) as { kind: DForceKind; ref: string; date: string; lines: any[]; force?: boolean };
    if (!KINDS.includes(body.kind)) return NextResponse.json({ error: 'Tipo de documento no válido.' }, { status: 400 });
    if (!body.ref?.trim()) return NextResponse.json({ error: 'Falta el nº de la Gutschrift.' }, { status: 400 });
    if (!isDate(body.date || '')) return NextResponse.json({ error: 'Indica la fecha de registro.' }, { status: 400 });
    if (!Array.isArray(body.lines) || !body.lines.length) return NextResponse.json({ error: 'No hay líneas que enviar.' }, { status: 400 });
    const files = (await Promise.all(['pdf', 'excel'].map(async k => {
      const f = form.get(k);
      return f instanceof File ? { name: f.name, data: new Uint8Array(await f.arrayBuffer()) } : null;
    }))).filter(f => f !== null);

    const ctx = await getBcContext(DFORCE_COMPANY);
    const ref = body.ref.trim();
    const label = KIND_LABEL[body.kind];

    // No duplicar: documentos con ese nº de Gutschrift, o líneas del diario con los mismos documentos y fecha
    if (!body.force) {
      const existing = body.kind === 'journal'
        ? (await existingJournalLines(ctx, body.lines)).map(no => ({ no, posted: false }))
        : await existingDocs(ctx, body.kind, ref);
      if (existing.length) {
        const what = body.kind === 'journal' ? `El lote D-FORCE ya tiene líneas de ${existing.map(e => e.no).join(', ')} con esa fecha` : `Ya existe en BC para ${ref}: ${existing.map(e => `${e.no}${e.posted ? ' (registrada)' : ''}`).join(', ')}`;
        return NextResponse.json({ error: what, existing }, { status: 409 });
      }
    }

    const result = body.kind === 'journal'
      ? await createJournalLines(ctx, body.lines.map(l => ({ ...l, postingDate: body.date })), files)
      : await createDocument(ctx, { kind: body.kind, ref, date: body.date, lines: body.lines }, files);
    await logAction(`D-FORCE: ${label} creada en BC`, `${result.no} · Gutschrift ${ref} · ${result.lines} líneas${result.net != null ? ` · ${result.net}` : ''}${body.force ? ' (ya existía)' : ''}`, DFORCE_COMPANY);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('D-FORCE create:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
