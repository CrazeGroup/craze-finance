import prisma from '@/lib/prisma';
import { CUSTOMER_INVOICE_TYPES } from '@/lib/documentTypes';

export async function generateReportHtml(customerId: number, invoiceIds: number[], customMessage?: string) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });

  const invoices = await prisma.invoice.findMany({
    where: {
      id: { in: invoiceIds }
    }
  });

  if (!customer) {
    throw new Error('Cliente no encontrado');
  }

  const companyId = invoices.length > 0 ? invoices[0].companyId : customer.companyId;

  // Company details mapping
  let companyDetails = {
    name: 'Craze Gmbh',
    address: 'Moltkestrasse 49<br>Karlsruhe, 76133',
    vat: 'DE281461152',
    phone: '+49 (0) 721 381 347-0',
    email: 'info@craze.toys',
    bank: '',
    iban: '',
    swift: '',
    website: 'www.craze.toys'
  };

  if (companyId === 'Craze UK') {
    companyDetails = {
      name: 'CRAZE TOYS LIMITED',
      address: 'Oceana House 39-49 Commercial Rd<br>Southampton, SO15 1GA<br>Großbritannien',
      vat: 'GB447605971',
      phone: '+49 (0) 721 381 347-0',
      email: 'info@craze.toys',
      bank: 'HSBC UK Bank plc.',
      iban: 'GB84 HBUK 4035 0464 2418 51',
      swift: 'MIDLGB22',
      website: 'www.craze.toys'
    };
  } else if (companyId === 'Craze Entertainment') {
    companyDetails = {
      name: 'Craze Entertainment GmbH',
      address: 'Moltkestr. 49<br>76133 Karlsruhe<br>Deutschland',
      vat: 'DE356726180',
      phone: '+49 (0) 721 381 347-0',
      email: 'info@craze.toys',
      bank: 'Sparkasse Karlsruhe',
      iban: 'DE29 6605 0101 0108 3582 50',
      swift: 'KARSDE66XXX',
      website: 'www.craze.toys'
    };
  } else if (companyId === 'CRAZE Group AG') {
    companyDetails = {
      name: 'CRAZE Group AG',
      address: 'Oberallmendstrasse 18<br>6300 Zug<br>Schweiz',
      vat: 'CHE-219.645.588',
      phone: '+41 (0) 78 329 2717',
      email: 'info@craze-group.com',
      bank: 'Acrevis Bank',
      iban: 'CH17 0690 0063 8751 1030 7',
      swift: 'ACRGCH22XXX',
      website: 'www.craze-group.com'
    };
  } else if (companyId === 'Craze Iberia SL') {
    companyDetails = {
      name: 'Craze Iberia S.L.',
      address: 'Av. Francesc Macià, 60, Planta 11<br>08208 Sabadell, Barcelona<br>España',
      vat: 'B10737070',
      phone: '+49 (0) 721 381 347-0',
      email: 'info@craze.toys',
      bank: 'Banco Sabadell',
      iban: 'ES90 0081 0900 8100 0516 5726',
      swift: 'BSABESBBXXX',
      website: 'www.craze.toys'
    };
  }

  const footerDetailsHtml = `
    <div style="font-size: 11px; color: #475569; display: flex; justify-content: space-between; border-top: 1px solid #cbd5e1; padding-top: 15px; margin-top: 30px; text-align: left;">
      <div style="flex: 1;">
        <strong>VAT Registration No.</strong><br>${companyDetails.vat}<br><br>
        ${companyDetails.bank ? `<strong>Bank</strong><br>${companyDetails.bank}` : ''}
      </div>
      <div style="flex: 1;">
        <strong>Home Page</strong><br>${companyDetails.website}<br><br>
        ${companyDetails.iban ? `<strong>IBAN</strong><br>${companyDetails.iban}` : ''}
      </div>
      <div style="flex: 1;">
        <strong>Phone No.</strong><br>${companyDetails.phone}<br><br>
        ${companyDetails.swift ? `<strong>SWIFT Code</strong><br>${companyDetails.swift}` : ''}
      </div>
      <div style="flex: 1;">
        <strong>Email</strong><br>${companyDetails.email}
      </div>
    </div>
  `;

  let invoiceRows = invoices.map(inv => {
    const dueDate = new Date(inv.dueDate);
    const today = new Date();
    const diffTime = Math.abs(today.getTime() - dueDate.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #eee; color: #333;">${inv.bcId}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee; color: #333;">${dueDate.toLocaleDateString()}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee; color: #d97706; font-weight: bold;">${diffDays} days</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee; color: #333; text-align: right; font-weight: bold;">€${inv.amount.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
      </tr>
    `;
  }).join('');

  const totalAmount = invoices.reduce((acc, inv) => acc + inv.amount, 0);

  const balanceAggr = await prisma.invoice.aggregate({
    where: { customerId, status: { in: ['Open', 'Overdue', 'open', 'overdue'] }, type: { in: CUSTOMER_INVOICE_TYPES } },
    _sum: { amount: true }
  });
  const customerBalance = balanceAggr._sum.amount || 0;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Overdue Report - ${customer.name}</title>
      <style>
        @media print {
          .no-print { display: none !important; }
          body { background-color: #fff !important; }
          .container { box-shadow: none !important; margin: 0 !important; padding: 0 !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 40px; background-color: #f1f5f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
      
      <div class="no-print" style="text-align: center; margin-bottom: 20px;">
        <button onclick="window.print()" style="background-color: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 16px; box-shadow: 0 4px 6px rgba(59,130,246,0.3);">
          🖨 Print to PDF / Save
        </button>
      </div>

      <div class="container" style="max-width: 800px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); color: #333;">
        <!-- Header -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 40px;">
          <tr>
            <td style="vertical-align: top;">
              <div style="font-family: Arial, Helvetica, sans-serif; color: #000;">
                <h1 style="margin: 0; font-size: 56px; font-weight: 900; line-height: 0.9; letter-spacing: -2px;">craze</h1>
                <h2 style="margin: 0; font-size: 32px; font-weight: 500; line-height: 1; letter-spacing: -1px; margin-left: 64px;">group</h2>
              </div>
            </td>
            <td style="vertical-align: top; text-align: right; font-size: 13px; color: #64748b; line-height: 1.6;">
              <strong>${companyDetails.name}</strong><br>
              ${companyDetails.address}<br>
              VAT: ${companyDetails.vat}
            </td>
          </tr>
        </table>

        <!-- Message Body -->
        <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 20px; margin-bottom: 40px; border-radius: 0 8px 8px 0;">
          <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #334155;">
            ${customMessage ? customMessage.replace(/\n/g, '<br/>') : `Dear ${customer.name},<br><br>We are contacting you to remind you that there are overdue invoices pending payment on your account.<br>We would appreciate it if you could settle this matter as soon as possible.`}
          </p>
        </div>

        <!-- Details Section -->
        <h2 style="font-size: 18px; color: #0f172a; margin-bottom: 15px; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">
          Overdue Invoices Details - Customer: <span style="color: #3b82f6;">${customer.name} (${customer.bcId})</span>
        </h2>

        <!-- Risk Data Boxes -->
        <div style="display: flex; gap: 20px; margin-bottom: 30px;">
          <div style="flex: 1; background-color: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0;">
            <p style="margin: 0; font-size: 13px; color: #64748b; font-weight: 600; text-transform: uppercase;">Total Balance</p>
            <p style="margin: 5px 0 0 0; font-size: 20px; font-weight: 700; color: #0f172a;">€${customerBalance.toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
          </div>

          <div style="flex: 1; background-color: #fff1f2; padding: 15px; border-radius: 8px; border: 1px solid #fecdd3;">
            <p style="margin: 0; font-size: 13px; color: #be123c; font-weight: 600; text-transform: uppercase;">Selected Overdue</p>
            <p style="margin: 5px 0 0 0; font-size: 20px; font-weight: 700; color: #e11d48;">€${totalAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
          </div>
        </div>

        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin-bottom: 30px; font-size: 14px;">
          <thead>
            <tr style="background-color: #f1f5f9;">
              <th style="padding: 12px; text-align: left; color: #475569; font-weight: 600; border-bottom: 2px solid #cbd5e1;">Invoice No.</th>
              <th style="padding: 12px; text-align: left; color: #475569; font-weight: 600; border-bottom: 2px solid #cbd5e1;">Due Date</th>
              <th style="padding: 12px; text-align: left; color: #475569; font-weight: 600; border-bottom: 2px solid #cbd5e1;">Overdue By</th>
              <th style="padding: 12px; text-align: right; color: #475569; font-weight: 600; border-bottom: 2px solid #cbd5e1;">Remaining Amount</th>
            </tr>
          </thead>
          <tbody>
            ${invoiceRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="padding: 15px 12px; text-align: right; font-weight: 700; color: #0f172a; font-size: 16px;">Total Overdue:</td>
              <td style="padding: 15px 12px; text-align: right; font-weight: 900; color: #10b981; font-size: 18px;">€${totalAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
            </tr>
          </tfoot>
        </table>

        ${footerDetailsHtml}

        <!-- Footer Note -->
        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
          <p style="margin: 0; font-size: 12px; color: #94a3b8;">
            This is an automatically generated confidential report by the <strong>${companyDetails.name}</strong> system.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}
