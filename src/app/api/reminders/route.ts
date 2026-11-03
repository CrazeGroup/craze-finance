import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { registerClaim } from '@/lib/claims';
import nodemailer from 'nodemailer';

export async function POST(request: Request) {
  try {
    const { customerId, customerName, email, invoices } = await request.json();
    
    if (!email) {
      return NextResponse.json({ error: 'No email provided for this customer' }, { status: 400 });
    }
    if (!invoices || invoices.length === 0) {
      return NextResponse.json({ error: 'No invoices provided' }, { status: 400 });
    }

    let transporter;
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
    } else {
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: "smtp.ethereal.email",
        port: 587,
        secure: false, 
        auth: {
          user: testAccount.user, 
          pass: testAccount.pass, 
        },
      });
    }

    // Build the invoice list for the email
    const invoiceListText = invoices.map((inv: any) => 
      `- Factura ${inv.bcId}: €${inv.amount.toLocaleString()} (Vencimiento: ${new Date(inv.dueDate).toLocaleDateString('es-ES')})`
    ).join('\n');

    const totalAmount = invoices.reduce((sum: number, inv: any) => sum + inv.amount, 0);

    const messageContent = `Estimado ${customerName},\n\nLe informamos que las siguientes facturas por un importe total de €${totalAmount.toLocaleString()} se encuentran pendientes de pago:\n\n${invoiceListText}\n\nLe rogamos proceda a su regularización a la mayor brevedad posible.\n\nAtentamente,\nCraze Finanzas`;

    const info = await transporter.sendMail({
      from: '"Craze Finanzas" <noreply@crazetoys.com>',
      to: email,
      subject: `Recordatorio de Pago Pendiente - ${customerName}`,
      text: messageContent,
    });

    console.log("Message sent: %s", info.messageId);

    // Save reminder in database for each invoice
    const now = new Date();
    for (const inv of invoices) {
      await prisma.reminder.create({
        data: {
          invoiceId: inv.id,
          messageContent,
          sentAt: now
        }
      });
    }
    // lastReminderDate + una reclamación más
    await registerClaim(invoices.map((inv: any) => inv.id), now);

    return NextResponse.json({ 
      success: true, 
      previewUrl: nodemailer.getTestMessageUrl(info) || null 
    });

  } catch (error: any) {
    console.error('Failed to send grouped reminder:', error);
    return NextResponse.json({ error: 'Failed to send grouped reminder', details: error.message }, { status: 500 });
  }
}
