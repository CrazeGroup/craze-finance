import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { cookies } from 'next/headers';

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

export async function PUT(request: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const body = await request.json();

    const { id, isActive, amount, dayOfMonth, activeFromDate, currencyCode, frequency } = body;

    if (!id) {
      return NextResponse.json({ error: 'Missing payment ID' }, { status: 400 });
    }

    const updated = await prisma.recurringPayment.update({
      where: { id: parseInt(id), companyId },
      data: {
        isActive,
        amount: amount !== undefined ? parseFloat(amount) : null,
        dayOfMonth: dayOfMonth !== undefined ? parseInt(dayOfMonth) : null,
        activeFromDate: activeFromDate ? new Date(activeFromDate) : null,
        currencyCode: currencyCode || null,
        frequency: frequency || null
      }
    });

    return NextResponse.json({ success: true, payment: updated });
  } catch (error) {
    console.error('Error updating recurring payment:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
