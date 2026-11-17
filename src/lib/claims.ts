import prisma from './prisma';

// Registra una reclamación más en las facturas (correo enviado o marca manual).
// claimCount cuenta las reclamaciones; las facturas reclamadas antes de existir el contador
// (claimCount 0 con lastReminderDate) pasan directamente a la 2ª.
// level: recordatorio con nivel elegido (1º/2º/3º, Recobros y Cashflow): las facturas quedan exactamente en ese nº.
export async function registerClaim(invoiceIds: number[], date = new Date(), level?: number) {
  if (level && level > 0) {
    await prisma.invoice.updateMany({ where: { id: { in: invoiceIds } }, data: { claimCount: level, lastReminderDate: date } });
    return;
  }
  await prisma.$transaction([
    prisma.invoice.updateMany({
      where: { id: { in: invoiceIds }, OR: [{ claimCount: { gt: 0 } }, { lastReminderDate: null }] },
      data: { claimCount: { increment: 1 }, lastReminderDate: date },
    }),
    prisma.invoice.updateMany({
      where: { id: { in: invoiceIds }, claimCount: 0, lastReminderDate: { not: null } },
      data: { claimCount: 2, lastReminderDate: date },
    }),
  ]);
}
