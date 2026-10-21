import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { getBcContext } from '@/lib/bcClient';
import { payablesReport } from '@/lib/reporting/ledgers';
import { currentMonth } from '@/lib/reporting/period';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
    let totalConfirmadoMarkant = 0;
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
      // Confirmado = con Confirmed Payment Date; Pendiente de confirmar = el resto (Confirmado + Pendiente = Total)
      if (pMethod.includes('markant')) {
        totalMarkant += amt;
        if (inv.confirmedPaymentDate) totalConfirmadoMarkant += amt;
      }

      // Check for Amazon
      const cName = (inv.customer.name || '').toLowerCase();
      if (cName.includes('amazon') || pMethod.includes('amazon')) {
        totalAmazon += amt;
      }
    }

    // Markant: todas las partidas abiertas con forma de pago MARKANT (abiertas y vencidas: en BC todas están "Open")
    const totalPendienteMarkant = totalMarkant - totalConfirmadoMarkant;

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

    // China: en directo de BC (movimientos de proveedor abiertos con forma de pago CHINA TRF del propio movimiento,
    // importe pendiente en divisa local; confirmado = con Scheduled Payment Date), igual que el Reporting.
    // Se guarda 1 h y se renueva en segundo plano. Si BC falla, se queda el cálculo con los datos sincronizados.
    let chinaSource: 'bc' | 'sync' = 'sync';
    if (companyId !== 'ALL') {
      try {
        const ctx = await getBcContext(companyId);
        const { china } = await payablesReport(ctx, companyId, currentMonth());
        totalChina = -china.total;
        totalConfirmadoChina = -china.conf;
        totalPendienteChina = -china.unconf;
        chinaSource = 'bc';
      } catch (e) {
        console.error('Dashboard China desde BC:', e);
      }
    }

    return NextResponse.json({
      chinaSource,
      // Cobros
      totalCarteraClientes,
      totalEnMarkant: totalMarkant,
      totalConfirmadoMarkant,
      totalPendienteMarkant,
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
