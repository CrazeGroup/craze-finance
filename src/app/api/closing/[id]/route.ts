import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Cambia número, descripción, responsable o notas de una tarea
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    const body = await req.json();
    const data: any = {};
    if (body.number !== undefined) data.number = parseInt(body.number, 10) || 0;
    if (body.description !== undefined) {
      data.description = String(body.description).trim();
      if (!data.description) return NextResponse.json({ error: 'La descripción no puede quedar vacía.' }, { status: 400 });
    }
    if (body.assignee !== undefined) data.assignee = body.assignee || null;
    if (body.notes !== undefined) data.notes = String(body.notes).trim() || null;
    const task = await prisma.closingTask.update({ where: { id }, data, include: { cells: true } });
    await logAction('Cierre mensual: tarea modificada', `${task.companyId} ${task.year} · ${task.number}. ${task.description}`, task.companyId);
    return NextResponse.json(task);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const task = await prisma.closingTask.delete({ where: { id: Number((await params).id) } });
    await logAction('Cierre mensual: tarea eliminada', `${task.companyId} ${task.year} · ${task.number}. ${task.description}`, task.companyId);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
