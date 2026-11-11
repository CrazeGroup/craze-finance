import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';
import { setProvision } from '@/lib/magazineAnalysis';

export const dynamic = 'force-dynamic';

// Provisión de devoluciones de Magazine Profitability.
// Body: { defaultPct: number|null } (todas las revistas) o { item, pct?: number|null, closed?: boolean } (una revista)
const pctOk = (v: any) => v === null || (typeof v === 'number' && v >= 0 && v <= 100);
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const change: any = {};
    if ('defaultPct' in b) { if (!pctOk(b.defaultPct)) return NextResponse.json({ error: '% no válido' }, { status: 400 }); change.defaultPct = b.defaultPct; }
    if (b.item) {
      if (!/^0599\d_\d{4}$/.test(String(b.item))) return NextResponse.json({ error: 'Revista no válida' }, { status: 400 });
      change.item = String(b.item);
      if ('pct' in b) { if (!pctOk(b.pct)) return NextResponse.json({ error: '% no válido' }, { status: 400 }); change.pct = b.pct; }
      if ('closed' in b) change.closed = !!b.closed;
    }
    const session: any = await getSession();
    const provisions = await setProvision(change, session?.username || '');
    await logAction('Magazine Profitability: provisión de devoluciones', JSON.stringify(b).substring(0, 900), 'Craze Entertainment');
    return NextResponse.json({ provisions });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
