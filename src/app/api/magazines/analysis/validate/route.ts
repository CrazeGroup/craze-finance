import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';
import { setValidated } from '@/lib/magazineAnalysis';

export const dynamic = 'force-dynamic';

// Da por buenas (o quita la validación de) líneas sin revista de Magazine Profitability.
// Body: { lines: [{ key, doc, description }], validated: boolean }
export async function POST(req: Request) {
  try {
    const { lines, validated } = await req.json();
    if (!Array.isArray(lines) || !lines.length) return NextResponse.json({ error: 'Sin líneas' }, { status: 400 });
    const session: any = await getSession();
    const all = await setValidated(lines.map((l: any) => ({ key: String(l.key), doc: String(l.doc || ''), description: String(l.description || '') })), !!validated, session?.username || '');
    await logAction(validated ? 'Magazine Profitability: líneas sin revista validadas' : 'Magazine Profitability: validación quitada',
      lines.map((l: any) => `${l.doc} ${l.description}`).join('; ').substring(0, 900), 'Craze Entertainment');
    return NextResponse.json({ validated: all });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
