import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Un mes de una tarea: { taskId, month, done?: true|false|null, comment?: string }
export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const taskId = Number(body.taskId), month = Number(body.month);
    if (!taskId || month < 1 || month > 12) return NextResponse.json({ error: 'Celda no válida.' }, { status: 400 });
    const data: any = { updatedBy: (await getSession())?.username as string || null };
    if (body.done !== undefined) data.done = body.done === null ? null : !!body.done;
    if (body.comment !== undefined) data.comment = String(body.comment || '').trim() || null;
    const cell = await prisma.closingCell.upsert({
      where: { taskId_month: { taskId, month } },
      update: data,
      create: { taskId, month, ...data },
      include: { task: true },
    });
    const state = cell.done === true ? 'hecho' : cell.done === false ? 'pendiente' : 'vacío';
    await logAction('Cierre mensual: celda', `${cell.task.year} ${MONTHS[month - 1]} · ${cell.task.number}. ${cell.task.description}: ${state}${body.comment !== undefined ? ` · comentario: ${cell.comment || '(borrado)'}` : ''}`, cell.task.companyId);
    const { task, ...rest } = cell;
    return NextResponse.json(rest);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
