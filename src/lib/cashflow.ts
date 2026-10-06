import prisma from '@/lib/prisma';
import { CUSTOMER_INVOICE_TYPES } from '@/lib/documentTypes';

// Movimientos de cashflow (transferencias de clientes, manuales y recurrentes) con saldo acumulado.
// Compartido por la página de Cashflow y el Reporting.
export async function getCashflow(companyId: string, currency: string, showArchived = false) {
  // 1. Initial balance
  const config = await prisma.cashflowConfig.findUnique({ 
    where: { companyId_currencyCode: { companyId, currencyCode: currency } } 
  });
  const INITIAL_BALANCE = config ? config.initialBalance : 0;
  const INITIAL_BALANCE_DATE = config ? config.updatedAt : new Date('2026-07-29T00:00:00Z');

  // 2. Fetch Markant invoices (Grouped by confirmedPaymentDate)
  const markantInvoices = await prisma.invoice.findMany({
    where: {
      companyId,
      paymentMethod: 'MARKANT',
      status: { not: 'Closed' },
      type: { in: CUSTOMER_INVOICE_TYPES },
      isArchived: showArchived,
      confirmedPaymentDate: { not: null },
      currencyCode: currency
    }
  });

  const markantGroups = markantInvoices.reduce((acc: any, inv) => {
    const activeDate = inv.cashflowDate || inv.confirmedPaymentDate || inv.dueDate;
    const dateStr = activeDate.toISOString().split('T')[0];

    if (!acc[dateStr]) acc[dateStr] = { amount: 0, invoices: [] };
    acc[dateStr].amount += inv.amount;
    acc[dateStr].invoices.push(inv);
    return acc;
  }, {});

  const markantEntries = Object.keys(markantGroups).map(dateStr => ({
    id: `auto-markant-${dateStr}`,
    date: new Date(dateStr),
    description: 'Markant',
    amount: markantGroups[dateStr].amount,
    isManual: false,
    isGroup: true,
    invoices: markantGroups[dateStr].invoices
  }));

  // 3. Fetch Transfer invoices
  const transferInvoices = await prisma.invoice.findMany({
    where: {
      companyId,
      paymentMethod: 'TRANSFER',
      status: { not: 'Closed' },
      type: { in: CUSTOMER_INVOICE_TYPES },
      isArchived: showArchived,
      currencyCode: currency
    },
    include: { customer: true }
  });

  const groupCompanyNames = ['craze group', 'craze toys', 'craze iberia'];
  const validTransferInvoices = transferInvoices.filter(inv => {
    const name = (inv.customer?.name || '').toLowerCase();
    return !groupCompanyNames.some(gc => name.includes(gc));
  });

  const transferGroups = validTransferInvoices.reduce((acc: any, inv) => {
    const activeDate = inv.cashflowDate || inv.dueDate;
    const dateStr = activeDate.toISOString().split('T')[0];
    const customerName = inv.customer.name;
    const key = `${customerName}|${dateStr}`;

    if (!acc[key]) acc[key] = { amount: 0, date: activeDate, customerName, customer: inv.customer, invoices: [] };
    acc[key].amount += inv.amount;
    acc[key].invoices.push(inv);
    return acc;
  }, {});

  const transferEntries = Object.values(transferGroups).map((group: any) => ({
    id: `auto-transfer-${group.customerName}-${group.date.toISOString()}`,
    date: group.date,
    description: group.customerName,
    amount: group.amount,
    isManual: false,
    isGroup: true,
    customer: group.customer,
    invoices: group.invoices
  }));

  // 4. Fetch Manual Entries
  const manualEntriesFromDb = await prisma.cashflowManualEntry.findMany({
    where: { companyId, currencyCode: currency, isArchived: showArchived }
  });
  const manualEntries = manualEntriesFromDb.map(entry => ({
    id: `manual-${entry.id}`,
    dbId: entry.id,
    date: entry.date,
    description: entry.description,
    amount: entry.amount,
    isManual: true,
    isArchived: entry.isArchived
  }));

  // 4.5 Fetch Recurring Payments
  const recurringPayments = await prisma.recurringPayment.findMany({
    where: { companyId, currencyCode: currency, isActive: true }
  });
  
  const recurringEntries: any[] = [];
  const projectionMonths = 12; // Project 12 months into the future
  const today = new Date();
  
  for (const rec of recurringPayments) {
    if (!rec.activeFromDate || !rec.dayOfMonth) continue;
    
    let currentProjDate = new Date(rec.activeFromDate);
    
    // Make sure we start from the activeFromDate
    for (let i = 0; i < projectionMonths; i++) {
      const projDate = new Date(currentProjDate.getFullYear(), currentProjDate.getMonth() + i, rec.dayOfMonth);
      
      // If the projected date is past an endDate (if it exists), stop
      if (rec.endDate && projDate > rec.endDate) break;
      
      recurringEntries.push({
        id: `recurring-${rec.id}-${projDate.toISOString()}`,
        date: projDate,
        description: `(Recurrente) ${rec.description}`,
        amount: rec.amount || 0,
        isManual: false,
        isGroup: false,
        isRecurring: true
      });
    }
  }

  // 5. Combine and sort
  // NOTA: Markant excluido a petición del usuario.
  const allEntries = [...transferEntries, ...manualEntries, ...recurringEntries];
  
  // Sort oldest to newest
  allEntries.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Filter starting from 29/07/2026? The prompt said: "ha de empezar en 29/07/2026". 
  // We will filter out anything before this date.
  const START_DATE = new Date('2026-07-29T00:00:00Z');
  const filteredEntries = allEntries.filter(e => e.date >= START_DATE);

  // 6. Calculate running balance
  let currentBalance = INITIAL_BALANCE;
  const finalEntries = filteredEntries.map(entry => {
    currentBalance += entry.amount;
    return {
      ...entry,
      balance: currentBalance
    };
  });

  return {
    initialBalance: INITIAL_BALANCE,
    initialBalanceDate: INITIAL_BALANCE_DATE,
    entries: finalEntries
  };
}
