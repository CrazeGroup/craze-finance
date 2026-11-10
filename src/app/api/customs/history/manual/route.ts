import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/auth';
import { setHistoryManual } from '@/lib/customsHistory';

export const dynamic = 'force-dynamic';

// POST { atc, orders: [...], transport: [...] }: pedido / factura de China y contenedor indicados a mano para ese AT/C
// (vacíos = se vuelve a lo que trae el PDF). Después hay que volver a analizar el AT/C (history?recompute=<AT/C>)
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const body = await req.json();
    if (!body?.atc) return NextResponse.json({ error: 'Falta el AT/C.' }, { status: 400 });
    const list = (v: unknown) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)).map(String);
    const session: any = await getSession().catch(() => null);
    const manual = await setHistoryManual(company, String(body.atc), { orders: list(body.orders), transport: list(body.transport), by: session?.username });
    return NextResponse.json({ manual });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
