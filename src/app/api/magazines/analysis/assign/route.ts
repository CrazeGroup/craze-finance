import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';
import { setManual } from '@/lib/magazineAnalysis';

export const dynamic = 'force-dynamic';

// Asigna a mano una línea sin revista de Magazine Profitability, o quita la asignación.
// Body: { key, magazine, task, doc?, description? } o { key, remove: true }
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const key = String(b.key || '');
    if (!key) return NextResponse.json({ error: 'Falta la línea' }, { status: 400 });
    const remove = !!b.remove;
    if (!remove && (!/^0599\d_\d{4}$/.test(String(b.magazine || '')) || !/^\d{3}\.\d{3}$/.test(String(b.task || '')))) {
      return NextResponse.json({ error: 'Elige la revista y la tarea' }, { status: 400 });
    }
    const session: any = await getSession();
    await setManual(key, remove ? null : { magazine: String(b.magazine), task: String(b.task) }, session?.username || '');
    await logAction(remove ? 'Magazine Profitability: asignación a mano quitada' : 'Magazine Profitability: línea asignada a mano',
      `${b.doc || key} ${b.description || ''}${remove ? '' : ` → ${b.magazine} / ${b.task}`}`.substring(0, 900), 'Craze Entertainment');
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
