import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const today = new Date();
    
    // -- CASHFLOW AVAILABLE CALCULATION --
    const cashflowConfigs = await prisma.cashflowConfig.findMany({ where: { companyId } });
    
    const cashflowAvailable: Record<string, number> = {};
    for (const conf of cashflowConfigs) {
      cashflowAvailable[conf.currencyCode] = conf.initialBalance;
    }
    // -- END CASHFLOW CALCULATION --

    // 1. CARTERA CLIENTES (Cobros)
    const openInvoices = await prisma.invoice.findMany({
      where: {
        companyId,
        status: { in: ['open', 'Open', 'Overdue', 'overdue'] },
      },
      include: {
        customer: true
      }
    });

    let totalCarteraClientes = 0;
    let totalVencido = 0;
    let totalMarkant = 0;
    let totalAmazon = 0;
    let totalRefundsCliente = 0;

    for (const inv of openInvoices) {
      const amt = inv.amount || 0;
      totalCarteraClientes += amt;

      const isOverdue = inv.dueDate < today;
      if (isOverdue) totalVencido += amt;

      if (inv.type === 'Refund') {
        totalRefundsCliente += amt;
      }

      // Check for Markant — based exclusively on paymentMethod code
      const pMethod = (inv.paymentMethod || '').toLowerCase();
      if (pMethod.includes('markant')) {
        totalMarkant += amt;
      }

      // Check for Amazon
      const cName = (inv.customer.name || '').toLowerCase();
      if (cName.includes('amazon') || pMethod.includes('amazon')) {
        totalAmazon += amt;
      }
    }

    // Confirmado Markant: facturas (Document Type Invoice) abiertas con paymentMethod MARKANT + confirmedPaymentDate informed
    // Includes both Open AND Overdue, because in Business Central there is no "Overdue" status —
    // all outstanding invoices are "Open" in BC regardless of whether they are past due.
    const confirmadoMarkantInvoices = await prisma.invoice.aggregate({
      where: {
        companyId,
        status: { in: ['open', 'Open', 'Overdue', 'overdue'] },
        type: { in: ['invoice', 'Invoice'] },
        paymentMethod: 'MARKANT',
        confirmedPaymentDate: { not: null },
      },
      _sum: { amount: true },
    });
    const totalConfirmadoMarkant = confirmadoMarkantInvoices._sum.amount || 0;

    // 2. CARTERA PROVEEDORES (Pagos)
    const openPurchases = await prisma.purchaseInvoice.findMany({
      where: {
        companyId,
        status: { in: ['open', 'Open', 'Overdue', 'overdue'] },
      },
      include: {
        approvals: true
      }
    });

    let totalCarteraProveedores = 0;
    let totalCarteraVencidaNoAprobada = 0;
    let totalCarteraVencidaAprobada = 0;
    let totalRefundsProveedor = 0;

    // We'll leave China empty for now until user clarification
    let totalChina = 0;
    let totalConfirmadoChina = 0;
    let totalPendienteChina = 0;

    for (const pinv of openPurchases) {
      const amt = pinv.amount || 0;
      totalCarteraProveedores += amt;

      if (pinv.type === 'Credit Memo') {
        totalRefundsProveedor += amt;
      }

      const isOverdue = pinv.dueDate < today;
      
      // Evaluate approvals
      const totalApps = pinv.approvals ? pinv.approvals.length : 0;
      const approvedCount = pinv.approvals ? pinv.approvals.filter(a => a.status === 'Approved').length : 0;
      const rejectedCount = pinv.approvals ? pinv.approvals.filter(a => a.status === 'Rejected').length : 0;
      const isFullyApproved = totalApps > 0 && approvedCount === totalApps && rejectedCount === 0;

      if (isOverdue) {
        if (isFullyApproved) {
          totalCarteraVencidaAprobada += amt;
        } else {
          totalCarteraVencidaNoAprobada += amt;
        }
      }

      // Check for China TRF
      if ((pinv.paymentMethod || '').toLowerCase() === 'china trf') {
        totalChina += amt;
        if (pinv.schedulePaymentDate) {
          totalConfirmadoChina += amt;
        } else {
          totalPendienteChina += amt;
        }
      }
    }

    // -- INVENTORY VALUATION --
    const latestValuation = await prisma.inventoryValuation.findFirst({
      where: { companyId },
      orderBy: { month: 'desc' }
    });

    return NextResponse.json({
      // Cobros
      totalCarteraClientes,
      totalEnMarkant: totalMarkant,
      totalConfirmadoMarkant,
      totalVencido,
      totalAmazon,

      // Pagos
      totalCarteraProveedores,
      totalCarteraVencidaNoAprobada,
      totalCarteraVencidaAprobada,

      // China
      totalChina,
      totalConfirmadoChina,
      totalPendienteChina,

      // Refunds & Returns
      totalRefundsAbiertosCliente: totalRefundsCliente,
      totalRefundsAbiertoProveedor: totalRefundsProveedor,
      salesReturnOrdersAbiertas: 0, // Placeholder

      // Cashflow (Total per currency)
      cashflowAvailable,

      // Inventory
      latestValuation
    });

  } catch (error: any) {
    console.error('Error fetching dashboard KPIs:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
