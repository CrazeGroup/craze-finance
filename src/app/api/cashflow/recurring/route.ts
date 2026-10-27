import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { cookies } from 'next/headers';
import { logAction } from '@/lib/logger';

// Pagos recurrentes creados en la app (no vienen de BC): código APP-…; la sincronización con BC no los toca
const MANUAL_PREFIX = 'APP-';

const configData = (body: any) => ({
  amount: body.amount !== undefined ? parseFloat(body.amount) : null,
  dayOfMonth: body.dayOfMonth !== undefined ? parseInt(body.dayOfMonth) : null,
  activeFromDate: body.activeFromDate ? new Date(body.activeFromDate) : null,
  currencyCode: body.currencyCode || null,
  frequency: body.frequency || null,
});

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';

    const payments = await prisma.recurringPayment.findMany({
      where: { companyId },
      orderBy: { bcCode: 'asc' }
    });

    return NextResponse.json(payments);
  } catch (error) {
    console.error('Error fetching recurring payments:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const body = await request.json();
    const description = String(body.description || '').trim();
    if (!description) return NextResponse.json({ error: 'Falta la descripción' }, { status: 400 });

    const created = await prisma.recurringPayment.create({
      data: { bcCode: `${MANUAL_PREFIX}${Date.now()}`, companyId, description, isActive: true, ...configData(body) }
    });
    await logAction('Cashflow: pago recurrente manual creado', `${description} · ${body.amount} ${body.currencyCode || ''} · ${body.frequency || 'monthly'}`);
    return NextResponse.json({ success: true, payment: created });
  } catch (error) {
    console.error('Error creating recurring payment:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// Borra un pago recurrente manual (los de BC solo se desactivan con PUT isActive: false)
export async function DELETE(request: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const id = parseInt(new URL(request.url).searchParams.get('id') || '');
    const rec = id ? await prisma.recurringPayment.findFirst({ where: { id, companyId } }) : null;
    if (!rec || !rec.bcCode.startsWith(MANUAL_PREFIX)) return NextResponse.json({ error: 'Solo se pueden borrar los pagos manuales' }, { status: 400 });
    await prisma.recurringPayment.delete({ where: { id } });
    await logAction('Cashflow: pago recurrente manual borrado', rec.description);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting recurring payment:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const body = await request.json();

    const { id, isActive } = body;

    if (!id) {
      return NextResponse.json({ error: 'Missing payment ID' }, { status: 400 });
    }

    const updated = await prisma.recurringPayment.update({
      where: { id: parseInt(id), companyId },
      data: {
        isActive,
        ...configData(body)
      }
    });

    return NextResponse.json({ success: true, payment: updated });
  } catch (error) {
    console.error('Error updating recurring payment:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
