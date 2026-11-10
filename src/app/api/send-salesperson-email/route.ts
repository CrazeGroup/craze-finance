import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import prisma from '@/lib/prisma';

export async function POST(request: Request) {
  try {
    const { customerId, invoiceIds, to, subject, message, pdfBase64 } = await request.json();

    if (!customerId || !invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0 || !to || !subject || !message || !pdfBase64) {
      return NextResponse.json({ error: 'Faltan campos requeridos' }, { status: 400 });
    }

    // Check if we have DB config, else use ethereal
    let transporter;
    let isEthereal = false;
    
    const emailConfig = await prisma.emailConfig.findUnique({ where: { id: 1 } });
    
    if (emailConfig && emailConfig.host && emailConfig.user && emailConfig.password) {
      transporter = nodemailer.createTransport({
        host: emailConfig.host,
        port: emailConfig.port,
        secure: emailConfig.secure,
        auth: {
          user: emailConfig.user,
          pass: emailConfig.password,
        },
      });
    } else {
      isEthereal = true;
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
    }

    const fromAddress = emailConfig?.fromName && emailConfig?.fromEmail 
      ? `"${emailConfig.fromName}" <${emailConfig.fromEmail}>` 
      : process.env.SMTP_FROM || '"Craze Gmbh" <no-reply@craze.com>';

    const signature = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px;">
        <p>Thanks and regards,</p>
        <p style="margin-bottom: 5px;"><b>CRAZE FINANCIAL DEPARTMENT</b></p>
        <p style="margin: 0;">E-Mail <a href="mailto:invoice@craze-group.com" style="color: #3b82f6; text-decoration: none;">invoice@craze-group.com</a></p>
        <p style="margin: 0;">Web <a href="https://www.craze-group.com" style="color: #3b82f6; text-decoration: none;">www.craze-group.com</a></p>
        <br/>
        <img src="cid:crazelogo" alt="Craze Group" width="130" style="margin-top: 10px; display: block;" />
      </div>
    `;

    const formattedMessage = message.split('\n\n').map((p: string) => `<p style="margin-top: 0; margin-bottom: 16px;">${p.replace(/\n/g, '<br/>')}</p>`).join('');

    // Get PDF buffer from base64 string
    const base64Data = pdfBase64.split('base64,')[1] || pdfBase64.replace(/^data:application\/pdf.*?;base64,/, "");
    const pdfBuffer = Buffer.from(base64Data, 'base64');

    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject,
      text: message, // plain text
      html: `<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
              ${formattedMessage}
              ${signature}
             </div>`, 
      attachments: [
        {
          filename: 'Facturas_Vencidas.pdf',
          content: Buffer.from(pdfBuffer),
          contentType: 'application/pdf'
        },
        {
          filename: 'logo.png',
          path: 'https://craze-finance-iota.vercel.app/logo.png',
          cid: 'crazelogo'
        }
      ]
    });
    
    let previewUrl = null;
    if (isEthereal) {
      previewUrl = nodemailer.getTestMessageUrl(info);
    }

    // Update Salesperson reminders metrics on the Customer
    const customer = await prisma.customer.update({
      where: { id: customerId },
      data: {
        salespersonReminderCount: { increment: 1 },
        salespersonLastReminderDate: new Date(),
      }
    });

    if (customer) {
      await prisma.actionLog.create({
        data: {
          user: 'Sistema',
          action: 'Correo a comercial',
          details: `Cliente: ${customer.name} | Comercial: ${to} | ${invoiceIds.length} factura(s)`,
          companyId: customer.companyId
        }
      });
    }

    return NextResponse.json({ 
      success: true, 
      messageId: info.messageId, 
      previewUrl: previewUrl || null
    });

  } catch (error: any) {
    console.error('Error sending salesperson email:', error);
    return NextResponse.json({ error: 'Failed to send email', details: error.message }, { status: 500 });
  }
}
