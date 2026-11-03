import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';
import { registerClaim } from '@/lib/claims';

// Marca manual de facturas reclamadas al cliente (cuando se ha reclamado por teléfono, por otro correo…).
// La marca es lastReminderDate: la misma fecha que ponen los recordatorios enviados desde Cashflow y Recobros.
// Cada marca suma una reclamación (claimCount: 1ª, 2ª…); quitarla deja la factura sin reclamar.
const MANUAL_CLAIM_MESSAGE = 'Marcada manualmente como reclamada';

export async function PATCH(request: Request) {
  try {
    const { invoiceIds, claimed } = await request.json();
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return NextResponse.json({ error: 'Faltan las facturas' }, { status: 400 });
    }
    const ids = invoiceIds.map(Number).filter(n => Number.isInteger(n));
    const invoices = await prisma.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, bcId: true } });

    if (claimed) {
      const now = new Date();
      await prisma.reminder.createMany({ data: invoices.map(i => ({ invoiceId: i.id, messageContent: MANUAL_CLAIM_MESSAGE, sentAt: now })) });
      await registerClaim(ids, now);
    } else {
      // Se quitan solo las marcas manuales; el historial de correos enviados se conserva
      await prisma.$transaction([
        prisma.reminder.deleteMany({ where: { invoiceId: { in: ids }, messageContent: MANUAL_CLAIM_MESSAGE } }),
        prisma.invoice.updateMany({ where: { id: { in: ids } }, data: { lastReminderDate: null, claimCount: 0 } }),
      ]);
    }

    await logAction(claimed ? 'Factura marcada como reclamada' : 'Factura desmarcada como reclamada', invoices.map(i => i.bcId).join(', '));
    const updated = await prisma.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, lastReminderDate: true, claimCount: true } });
    return NextResponse.json({ success: true, count: invoices.length, invoices: updated });
  } catch (error: any) {
    console.error('Failed to update claim mark:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
