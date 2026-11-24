import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Comentario de la app en una Sales Return Order (CashflowComment, clave "sro:<no>", empresa de la SRO).
// Se borran con DELETE /api/cashflow/comments?id=
export async function POST(request: Request) {
  try {
    const { company, no, text } = await request.json();
    if (!company || !no || !String(text || '').trim()) return NextResponse.json({ error: 'The comment is missing' }, { status: 400 });
    const session = await getSession();
    const c = await prisma.cashflowComment.create({
      data: { companyId: String(company), targetKey: `sro:${no}`, text: String(text).trim(), author: session?.username || null },
    });
    await logAction('Sales Return Order comment', `${no}: ${c.text}`, String(company));
    return NextResponse.json({ source: 'app', id: c.id, date: c.createdAt.toISOString(), text: c.text, author: c.author || '' });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
