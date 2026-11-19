import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';

// Marca "Llamado": el cliente se ha llamado por teléfono para reclamar el cobro (Cashflow; se ve también en Recobros).
// Independiente de las reclamaciones por correo: lastCallDate = última llamada, callCount = nº de llamadas.
export async function PATCH(request: Request) {
  try {
    const { invoiceIds, called } = await request.json();
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return NextResponse.json({ error: 'The invoices are missing' }, { status: 400 });
    }
    const ids = invoiceIds.map(Number).filter(n => Number.isInteger(n));
    const invoices = await prisma.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, bcId: true } });

    await prisma.invoice.updateMany({
      where: { id: { in: ids } },
      data: called ? { lastCallDate: new Date(), callCount: { increment: 1 } } : { lastCallDate: null, callCount: 0 },
    });

    await logAction(called ? 'Customer called (payment chase)' : 'Called mark removed', invoices.map(i => i.bcId).join(', '));
    const updated = await prisma.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, lastCallDate: true, callCount: true } });
    return NextResponse.json({ success: true, count: invoices.length, invoices: updated });
  } catch (error: any) {
    console.error('Failed to update call mark:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
