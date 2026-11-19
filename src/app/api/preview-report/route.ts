import { NextRequest, NextResponse } from 'next/server';
import { generateReportHtml } from '@/lib/reportBuilder';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const customerIdStr = searchParams.get('customerId');
    const invoiceIdsStr = searchParams.get('invoices');
    const customMessage = searchParams.get('message') || undefined;

    if (!customerIdStr || !invoiceIdsStr) {
      return new NextResponse('Missing parameters customerId or invoices', { status: 400 });
    }

    const customerId = parseInt(customerIdStr, 10);
    const invoiceIds = invoiceIdsStr.split(',').map(id => parseInt(id, 10));

    // Call the shared report builder function
    const htmlContent = await generateReportHtml(customerId, invoiceIds, customMessage);

    return new NextResponse(htmlContent, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });

  } catch (error: any) {
    console.error('Error generating preview:', error);
    return new NextResponse(error.message || 'Internal Server Error', { status: 500 });
  }
}
