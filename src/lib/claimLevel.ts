// Nº de reclamaciones de una factura (Cashflow y Recobros comparten Invoice.claimCount / lastReminderDate);
// las reclamadas antes de existir el contador cuentan como 1.
export const claimCountOf = (inv: { lastReminderDate?: string | Date | null; claimCount?: number | null }) =>
  inv.lastReminderDate ? Math.max(inv.claimCount || 0, 1) : 0;
