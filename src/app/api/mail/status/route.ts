import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getSession } from '@/lib/auth';
import { mailStatus, disconnectMail } from '@/lib/graphMail';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Desde qué cuenta saldrán los correos del usuario: su buzón (Graph, si lo conectó) o la cuenta SMTP común
export async function GET() {
  const session = await getSession();
  const username = session?.username || '';
  const [own, smtp] = await Promise.all([mailStatus(username), prisma.emailConfig.findUnique({ where: { id: 1 } })]);
  return NextResponse.json({ ...own, username, smtpFrom: smtp?.fromEmail || smtp?.user || '' });
}

export async function DELETE() {
  const session = await getSession();
  if (!session?.username) return NextResponse.json({ error: 'Sin sesión' }, { status: 401 });
  await disconnectMail(session.username);
  await logAction('Correo desconectado', 'Los recordatorios vuelven a salir por la cuenta SMTP común');
  return NextResponse.json({ ok: true });
}
