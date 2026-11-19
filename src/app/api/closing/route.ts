import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';
import { CLOSING_COMPANIES } from '@/lib/closing';

export const dynamic = 'force-dynamic';

const params = (req: Request) => {
  const { searchParams } = new URL(req.url);
  const company = searchParams.get('company') || '';
  const year = parseInt(searchParams.get('year') || '', 10);
  if (!CLOSING_COMPANIES.includes(company)) throw new Error('Invalid company.');
  if (!year) throw new Error('Invalid year.');
  return { company, year };
};

// Tareas del cierre de una empresa y año (?company=&year=), con sus meses, y los usuarios de la web para asignarlas
export async function GET(req: Request) {
  try {
    const { company, year } = params(req);
    const [tasks, users, previous] = await Promise.all([
      prisma.closingTask.findMany({ where: { companyId: company, year }, include: { cells: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
      prisma.user.findMany({ select: { username: true }, orderBy: { username: 'asc' } }),
      prisma.closingTask.count({ where: { companyId: company, year: year - 1 } }),
    ]);
    return NextResponse.json({ tasks, users: users.map(u => u.username).filter(u => u !== 'admin'), previousYearTasks: previous });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Nueva tarea { description, assignee, notes, group } o, con { copyFrom: año }, las tareas de ese año (sin los meses)
export async function POST(req: Request) {
  try {
    const { company, year } = params(req);
    const body = await req.json();
    const last = await prisma.closingTask.findFirst({ where: { companyId: company, year }, orderBy: [{ sortOrder: 'desc' }] });
    if (body.copyFrom) {
      const from = await prisma.closingTask.findMany({ where: { companyId: company, year: Number(body.copyFrom) }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
      await prisma.closingTask.createMany({
        data: from.map((t, i) => ({ companyId: company, year, group: t.group, number: t.number, sortOrder: (last?.sortOrder ?? -1) + 1 + i, description: t.description, assignee: t.assignee, notes: t.notes })),
      });
      await logAction('Monthly closing: tasks copied', `${company}: tasks of ${body.copyFrom} copied to ${year} (${from.length})`, company);
      return NextResponse.json({ copied: from.length });
    }
    const description = String(body.description || '').trim();
    if (!description) return NextResponse.json({ error: 'The description is missing.' }, { status: 400 });
    const group = String(body.group || '').trim() || null;
    const maxNumber = await prisma.closingTask.aggregate({ where: { companyId: company, year, group }, _max: { number: true } });
    const task = await prisma.closingTask.create({
      data: {
        companyId: company, year, group, description, assignee: body.assignee || null, notes: body.notes || null,
        number: (maxNumber._max.number || 0) + 1, sortOrder: (last?.sortOrder ?? -1) + 1,
      },
      include: { cells: true },
    });
    await logAction('Monthly closing: task created', `${company}${group ? ` / ${group}` : ''} ${year} · ${task.number}. ${description}`, company);
    return NextResponse.json(task);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Renombra una subempresa del año: { from, to }
export async function PATCH(req: Request) {
  try {
    const { company, year } = params(req);
    const { from, to } = await req.json();
    const name = String(to || '').trim();
    if (!from || !name) return NextResponse.json({ error: 'Enter the name of the sub-company.' }, { status: 400 });
    const r = await prisma.closingTask.updateMany({ where: { companyId: company, year, group: from }, data: { group: name } });
    await logAction('Monthly closing: sub-company renamed', `${company} ${year} · ${from} → ${name} (${r.count} tasks)`, company);
    return NextResponse.json({ updated: r.count });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Elimina una subempresa del año con sus tareas: ?group=
export async function DELETE(req: Request) {
  try {
    const { company, year } = params(req);
    const group = new URL(req.url).searchParams.get('group') || '';
    if (!group) return NextResponse.json({ error: 'The sub-company is missing.' }, { status: 400 });
    const r = await prisma.closingTask.deleteMany({ where: { companyId: company, year, group } });
    await logAction('Monthly closing: sub-company deleted', `${company} ${year} · ${group} (${r.count} tasks)`, company);
    return NextResponse.json({ deleted: r.count });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
