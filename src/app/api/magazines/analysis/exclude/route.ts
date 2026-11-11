import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';
import { setExcluded } from '@/lib/magazineAnalysis';

export const dynamic = 'force-dynamic';

// Excluye del margen (o vuelve a incluir) líneas de Magazine Profitability. Body: { lines: [{ key, doc, description }], excluded }
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const lines = (Array.isArray(b.lines) ? b.lines : [])
      .map((l: any) => ({ key: String(l.key || ''), doc: String(l.doc || ''), description: String(l.description || '') }))
      .filter((l: any) => /^(sales|purch)\w+\|.+\|\d+$/.test(l.key));
    if (!lines.length) return NextResponse.json({ error: 'Falta la línea' }, { status: 400 });
    const session: any = await getSession();
    const excluded = await setExcluded(lines, !!b.excluded, session?.username || '');
    await logAction(b.excluded ? 'Magazine Profitability: línea excluida del margen' : 'Magazine Profitability: línea incluida de nuevo en el margen',
      lines.map((l: any) => `${l.doc} ${l.description}`).join('; ').substring(0, 900), 'Craze Entertainment');
    return NextResponse.json({ ok: true, excluded });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
