import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';
import { NotesNotPublished, purchaseNotes, setRead } from '@/lib/purchaseNotes';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const company = async () => (await cookies()).get('craze_selected_company')?.value || 'CRAZE';

// Notas (Record Links) de facturas/abonos de compra de la empresa activa, de la más reciente a la más antigua
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  try {
    const ctx = await getBcContext(await company());
    return NextResponse.json({ notes: await purchaseNotes(ctx, force) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message, notPublished: error instanceof NotesNotPublished }, { status: error instanceof NotesNotPublished ? 200 : 500 });
  }
}

// Marcar como leídas / no leídas: { linkIds: string[], read: boolean }
export async function PATCH(req: Request) {
  try {
    const { linkIds, read } = await req.json();
    if (!Array.isArray(linkIds) || !linkIds.length) return NextResponse.json({ error: 'Sin notas' }, { status: 400 });
    const session = await getSession();
    await setRead(await company(), linkIds.map(String), read !== false, session?.username || 'Sistema');
    await logAction(read !== false ? 'Notas de compra marcadas como leídas' : 'Notas de compra marcadas como no leídas', `${linkIds.length} nota(s)`);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
