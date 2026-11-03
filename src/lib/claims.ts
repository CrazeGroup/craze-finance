import prisma from './prisma';

// Registra una reclamación más en las facturas (correo enviado o marca manual).
// claimCount cuenta las reclamaciones; las facturas reclamadas antes de existir el contador
// (claimCount 0 con lastReminderDate) pasan directamente a la 2ª.
export async function registerClaim(invoiceIds: number[], date = new Date()) {
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
