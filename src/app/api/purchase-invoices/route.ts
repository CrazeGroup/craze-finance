import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { VENDOR_INVOICE_TYPES } from '@/lib/documentTypes';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';

    const invoices = await prisma.purchaseInvoice.findMany({
      where: { companyId, type: { in: VENDOR_INVOICE_TYPES } },
      include: {
        vendor: true,
        approvals: true,
      },
    });

    const enrichedInvoices = invoices.map(inv => {
      const isOverdue = inv.status === 'Overdue';
      const daysOverdue = isOverdue ? Math.floor((new Date().getTime() - new Date(inv.dueDate).getTime()) / (1000 * 60 * 60 * 24)) : 0;
      
      // Calculate approvals logic
      const totalApprovals = inv.approvals.length;
      const approvedCount = inv.approvals.filter(a => a.status === 'Approved').length;
      const rejectedCount = inv.approvals.filter(a => a.status === 'Rejected' || a.status === 'Canceled').length;
      
      return {
        ...inv,
        isOverdue,
        daysOverdue,
        totalApprovals,
        approvedCount,
        rejectedCount
      };
    });

    return NextResponse.json(enrichedInvoices);
  } catch (error) {
    console.error('Error fetching purchase invoices:', error);
    return NextResponse.json({ error: 'Failed to fetch purchase invoices' }, { status: 500 });
  }
}
