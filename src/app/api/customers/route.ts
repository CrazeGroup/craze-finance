import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const customers = await prisma.customer.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        invoices: true
      }
    });
    
    const enriched = customers.map(c => {
      let openBalance = 0;
      let overdueBalance = 0;
      const today = new Date();
      
      c.invoices.forEach(inv => {
        if (['open', 'Open', 'Overdue', 'overdue'].includes(inv.status)) {
          openBalance += (inv.amount || 0);
          if (inv.dueDate < today) {
            overdueBalance += (inv.amount || 0);
          }
        }
      });
      
      // Override balance with calculated one
      const finalBalance = openBalance;
      
      let calcRisk = c.calculatedRisk;
      let sugAction = c.suggestedAction;
      
      // Re-evaluate risk based on the real balance
      if (c.paymentMethod?.toLowerCase() !== 'transfer') {
        calcRisk = 'Sin riesgo';
        sugAction = 'N/A';
      } else {
        if (finalBalance > c.riskLimit) {
          calcRisk = 'Alto Riesgo';
          sugAction = 'Request a higher credit limit or ask for early payment of open invoices';
        } else {
          calcRisk = 'Riesgo Controlado';
          sugAction = 'Normal';
        }
      }
      
      if (c.riskLimit > 0 && finalBalance === 0) {
        const eightMonthsAgo = new Date();
        eightMonthsAgo.setMonth(eightMonthsAgo.getMonth() - 8);
        
        const hasRecentInvoice = c.invoices.some((inv: any) => new Date(inv.dueDate) >= eightMonthsAgo);
        
        if (!hasRecentInvoice) {
          calcRisk = 'Riesgo No Utilizado';
          sugAction = 'Review the credit limit (no invoicing in the last 8 months)';
        }
      }
      
      const { invoices, ...rest } = c;
      return { 
        ...rest, 
        balance: finalBalance,
        overdueBalance,
        calculatedRisk: calcRisk, 
        suggestedAction: sugAction 
      };
    });
    
    return NextResponse.json(enriched);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch customers' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const data = await request.json();
    
    if (!Array.isArray(data)) {
      return NextResponse.json({ error: 'Data must be an array' }, { status: 400 });
    }

    const processedData = data.map((customer: any) => {
      let calculatedRisk = 'Desconocido';
      let suggestedAction = 'None';

      const riskLimit = parseFloat(customer.riskLimit || 0);
      const balance = parseFloat(customer.balance || 0);

      if (customer.paymentMethod?.toLowerCase() !== 'transfer') {
        calculatedRisk = 'Sin riesgo';
        suggestedAction = 'N/A';
      } else {
        if (balance > riskLimit) {
          calculatedRisk = 'Alto Riesgo';
          suggestedAction = 'Request a higher credit limit or ask for early payment of open invoices';
        } else {
          calculatedRisk = 'Riesgo Controlado';
          suggestedAction = 'Normal';
        }
      }

      return {
        bcId: customer.bcId || null,
        name: customer.name,
        paymentMethod: customer.paymentMethod || 'Unknown',
        riskLimit,
        balance,
        calculatedRisk,
        suggestedAction,
        salespersonCode: customer.salespersonCode || null,
        salespersonName: customer.salespersonName || null
      };
    });

    // Clear existing
    await prisma.reminder.deleteMany();
    await prisma.invoice.deleteMany();
    await prisma.customer.deleteMany();
    
    await prisma.customer.createMany({
      data: processedData,
    });

    return NextResponse.json({ message: 'Customers imported successfully', count: processedData.length });
  } catch (error: any) {
    console.error('Error in POST /api/customers', error);
    return NextResponse.json({ error: 'Failed to process customers', details: error.message }, { status: 500 });
  }
}
