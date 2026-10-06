import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { deleteUpload, listUploads, saveUpload, UploadKind } from '@/lib/reporting';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const KINDS: UploadKind[] = ['inventory'];
const LABELS: Record<UploadKind, string> = { inventory: 'Valor de inventario' };

async function context(req: Request) {
  const cookieStore = await cookies();
  const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
  const kind = new URL(req.url).searchParams.get('kind') as UploadKind;
  if (!KINDS.includes(kind)) throw new Error('Tipo de Excel no válido.');
  if (companyId === 'ALL') throw new Error('Selecciona una empresa concreta para subir el Excel.');
  return { companyId, kind };
}

// Meses con Excel subido
export async function GET(req: Request) {
  try {
    const { companyId, kind } = await context(req);
    return NextResponse.json({ uploads: await listUploads(kind, companyId) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

// Guarda el Excel ya leído en el navegador ({ month, data })
export async function POST(req: Request) {
  try {
    const { companyId, kind } = await context(req);
    const { month, data } = await req.json();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') || !data) {
      return NextResponse.json({ error: 'Faltan el mes o los datos del Excel.' }, { status: 400 });
    }
    await saveUpload(kind, companyId, month, data);
    await logAction('Subir Excel Reporting', `${LABELS[kind]} ${month}`, companyId);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error saving reporting upload:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { companyId, kind } = await context(req);
    const month = new URL(req.url).searchParams.get('month') || '';
    await deleteUpload(kind, companyId, month);
    await logAction('Eliminar Excel Reporting', `${LABELS[kind]} ${month}`, companyId);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
