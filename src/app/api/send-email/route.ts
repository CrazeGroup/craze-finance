import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import prisma from '@/lib/prisma';
import { registerClaim } from '@/lib/claims';
import { salesDocumentPdfs } from '@/lib/invoicePdfs';

// Con los PDF de las facturas de BC puede tardar
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const { customerId, invoiceIds, to, cc, subject, message, pdfBase64, level, insurance, attachInvoices } = await request.json();
    // PDF impreso de cada factura de venta (opcional)
    const invoicePdfs = attachInvoices ? await salesDocumentPdfs(invoiceIds.map(Number)) : { files: [], missing: [] as string[] };

    if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0 || !to || !subject || !message || !customerId || !pdfBase64) {
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
      console.log('Using Ethereal account:', testAccount.user);
    }

    // Get PDF buffer from base64 string
    const base64Data = pdfBase64.split('base64,')[1] || pdfBase64.replace(/^data:application\/pdf.*?;base64,/, "");
    const pdfBuffer = Buffer.from(base64Data, 'base64');

    const fromAddress = emailConfig?.fromName && emailConfig?.fromEmail 
      ? `"${emailConfig.fromName}" <${emailConfig.fromEmail}>` 
      : process.env.SMTP_FROM || '"Craze Finance" <no-reply@craze.com>';

    const signature = `
      <div style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px; font-size: 14px; color: #555;">
        <p style="margin: 0; font-weight: bold; color: #111;">CRAZE GmbH Finance Team</p>
        <p style="margin: 5px 0;">Haynauer Str. 72 a | 12249 Berlin | Germany</p>
        <p style="margin: 0;">Email <a href="mailto:invoice@craze-group.com" style="color: #3b82f6; text-decoration: none;">invoice@craze-group.com</a></p>
        <p style="margin: 0;">Web <a href="https://www.craze-group.com" style="color: #3b82f6; text-decoration: none;">www.craze-group.com</a></p>
        <br/>
        <img src="cid:crazelogo" alt="Craze Group" width="130" style="margin-top: 10px; display: block;" />
      </div>
    `;

    const formattedMessage = message.split('\n\n').map((p: string) => `<p style="margin-top: 0; margin-bottom: 16px;">${p.replace(/\n/g, '<br/>')}</p>`).join('');

    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      ...(cc ? { cc } : {}),
      subject,
      text: message, // plain text
      html: `<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
              ${formattedMessage}
              ${signature}
             </div>`, 
      attachments: [
        ...invoicePdfs.files,
        {
          filename: 'Overdue_Invoices.pdf',
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

    console.log('Message sent: %s', info.messageId);
    
    let previewUrl = null;
    if (isEthereal) {
      previewUrl = nodemailer.getTestMessageUrl(info);
      console.log('Preview URL: %s', previewUrl);
    }

    // Save to database for all selected invoices
    for (const invoiceId of invoiceIds) {
      await prisma.reminder.create({
        data: {
          invoiceId,
          messageContent: level ? `[${level}º recordatorio${cc ? ` · CC ${cc}` : ''}${insurance ? ' · aviso aseguradora' : ''}]\n${message}` : message,
        }
      });

    }
    // Cada factura suma su propia reclamación (en un mismo correo puede ir el 1er recordatorio de una y el 2º de otra)
    await registerClaim(invoiceIds.map(Number), new Date());
    // Comercial en copia: cuenta como aviso al comercial
    if (cc) await prisma.customer.update({ where: { id: customerId }, data: { salespersonReminderCount: { increment: 1 }, salespersonLastReminderDate: new Date() } }).catch(() => {});

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (customer) {
      await prisma.actionLog.create({
        data: {
          user: 'Sistema',
          action: level ? `Recordatorio ${level} a cliente` : 'Correo a cliente (Recordatorio)',
          details: `Cliente: ${customer.name} | Enviado a ${to}${cc ? ` (CC ${cc})` : ''} para ${invoiceIds.length} factura(s)${insurance ? ' · aviso aseguradora' : ''}`,
          companyId: customer.companyId
        }
      });
    }

    return NextResponse.json({ 
      success: true, 
      messageId: info.messageId, 
      previewUrl: previewUrl || null,
      invoicePdfs: invoicePdfs.files.length,
      missingPdfs: invoicePdfs.missing
    });

  } catch (error: any) {
    console.error('Error sending email:', error);
    return NextResponse.json({ error: 'Failed to send email', details: error.message }, { status: 500 });
  }
}
