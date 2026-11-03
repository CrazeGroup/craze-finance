import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Comentarios de Cashflow por factura ("invoice:<id>") o por línea (id de la línea)
export async function GET() {
  try {
    const companyId = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const comments = await prisma.cashflowComment.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    return NextResponse.json(comments);
  } catch (error: any) {
    console.error('Failed to get cashflow comments:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const companyId = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const { targetKey, text, label } = await request.json();
    if (!targetKey || !String(text || '').trim()) {
      return NextResponse.json({ error: 'Falta el comentario' }, { status: 400 });
    }
    const session = await getSession();
    const comment = await prisma.cashflowComment.create({
      data: { companyId, targetKey: String(targetKey), text: String(text).trim(), author: session?.username || null }
    });
    await logAction('Comentario en Cashflow', `${label || targetKey}: ${comment.text}`, companyId);
    return NextResponse.json(comment);
  } catch (error: any) {
    console.error('Failed to create cashflow comment:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const id = Number(new URL(request.url).searchParams.get('id'));
    if (!Number.isInteger(id)) return NextResponse.json({ error: 'Falta el comentario' }, { status: 400 });
    await prisma.cashflowComment.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Failed to delete cashflow comment:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
