import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import salespeopleMapData from '@/lib/salespeopleMap.json';
import { CUSTOMER_INVOICE_TYPES } from '@/lib/documentTypes';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const today = new Date();
    
    // Fetch all open invoices
    const openInvoices = await prisma.invoice.findMany({
      where: {
        companyId,
        status: { in: ['open', 'Open', 'Overdue', 'overdue'] },
        type: { in: CUSTOMER_INVOICE_TYPES },
      },
      include: {
        customer: true,
        reminders: {
          orderBy: { sentAt: 'desc' }
        }
      },
      orderBy: { dueDate: 'asc' }
    });

    const salespeopleMap = new Map<string, string>(Object.entries(salespeopleMapData));

    const enrichedInvoices = openInvoices.map(invoice => {
      const isOverdue = invoice.dueDate < today;
      let daysOverdue = 0;
      if (isOverdue) {
        const diffTime = Math.abs(today.getTime() - invoice.dueDate.getTime());
        daysOverdue = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      }

      if (invoice.customer) {
        const rawCode = invoice.customer.salespersonCode || invoice.customer.salespersonName;
        if (rawCode) {
          const mappedName = salespeopleMap.get(String(rawCode));
          if (mappedName) {
            invoice.customer.salespersonName = mappedName;
          }
        }
      }

      return {
        ...invoice,
        isOverdue,
        daysOverdue,
        reminderCount: invoice.reminders.length,
        // Using the field requested by user or fallback to relation
        lastReminderSentAt: invoice.lastReminderDate || invoice.reminders[0]?.sentAt || null,
      };
    });

    return NextResponse.json(enrichedInvoices);
  } catch (error) {
    console.error('Failed to fetch invoices:', error);
    return NextResponse.json({ error: 'Failed to fetch invoices' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const data = await request.json();
    if (!Array.isArray(data)) return NextResponse.json({ error: 'Array expected' }, { status: 400 });

    // Excel dates are number of days since Dec 30 1899. We convert them carefully or they might be strings.
    const excelToDate = (val: any) => {
      if (typeof val === 'number') {
        const d = new Date(Math.round((val - 25569) * 864e5));
        return isNaN(d.getTime()) ? new Date() : d;
      }
      return val ? new Date(val) : new Date();
    };

    let importedCount = 0;
    
    // Create customers if not exists and map them
    const allCustomers = await prisma.customer.findMany({ 
      where: { companyId },
      select: { id: true, bcId: true } 
    });
    const customerMap = new Map(allCustomers.filter(c => c.bcId).map(c => [c.bcId, c.id]));

    // Delete existing open invoices to replace them (naive approach for this example)
    await prisma.invoice.deleteMany({
      where: { companyId }
    });

    const validInvoices = data.map((row: any) => {
      const bcId = row['Document No.'] || row.bcId || `INV-${Math.random()}`;
      const customerBcId = row['Customer No.'] || row.customerBcId;
      const type = (row['Document Type'] || row.type || 'invoice').toLowerCase();
      
      const isOpen = row['Open'] === 1 || row['Open'] === '1' || row['Open'] === true || row.status === 'open' || row.status === 'Open';
      const status = isOpen ? 'open' : 'closed';
      
      const amount = parseFloat(row['Remaining Amount'] || row['Remaining Amt. (LCY)'] || row.amount || 0);
      const originalAmount = parseFloat(row['Original Amount'] || row['Original Amt. (LCY)'] || row.originalAmount || 0);
      const currencyCode = row['Currency Code'] || row.currencyCode || '';
      
      const rawPayment = row['Payment Method Code'] || row.paymentMethod;
      const paymentMethod = (typeof rawPayment === 'string' && rawPayment.trim() !== '') ? rawPayment : 'Empty';
      
      const dueDate = excelToDate(row['Due Date'] || row.dueDate);
      
      const confirmedPaymentDate = (row['Confirmed Payment Date'] || row.confirmedPaymentDate) ? excelToDate(row['Confirmed Payment Date'] || row.confirmedPaymentDate) : null;
      const customerId = customerMap.get(String(customerBcId));

      return { 
        bcId, 
        customerId: customerId as number, 
        type, 
        status, 
        amount, 
        originalAmount, 
        currencyCode, 
        paymentMethod, 
        dueDate, 
        confirmedPaymentDate,
        companyId 
      };
    }).filter(inv => inv.customerId && inv.type === 'invoice');
    
    await prisma.invoice.createMany({
      data: validInvoices,
    });
    
    return NextResponse.json({ message: 'Invoices imported successfully', count: validInvoices.length });
  } catch (error: any) {
    console.error('Error in POST /api/invoices', error);
    return NextResponse.json({ error: 'Failed to process invoices', details: error.message }, { status: 500 });
  }
}
