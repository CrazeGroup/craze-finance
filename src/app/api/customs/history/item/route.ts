import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { refreshHistoryItem } from '@/lib/customsHistory';

export const dynamic = 'force-dynamic';

// POST { no }: vuelve a leer la ficha del artículo en BC y lo actualiza en todas las declaraciones del histórico
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const { no } = await req.json();
    if (!no) return NextResponse.json({ error: 'Falta el artículo.' }, { status: 400 });
    return NextResponse.json(await refreshHistoryItem(await getBcContext(company), company, String(no)));
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
