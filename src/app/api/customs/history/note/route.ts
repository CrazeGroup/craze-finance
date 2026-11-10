import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/auth';
import { setHistoryNote } from '@/lib/customsHistory';

export const dynamic = 'force-dynamic';

// POST { key: 'AT/C|posición|artículo', ignored, comment }: descarta la línea (error de la declaración) o le pone un
// comentario; sin los dos, se borra la nota
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const body = await req.json();
    if (!body?.key) return NextResponse.json({ error: 'Falta la línea.' }, { status: 400 });
    const session: any = await getSession().catch(() => null);
    const notes = await setHistoryNote(company, String(body.key), { ignored: !!body.ignored, comment: String(body.comment || ''), by: session?.username });
    return NextResponse.json({ notes });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
