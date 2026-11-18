import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { registerClaim } from '@/lib/claims';
import { salesDocumentPdfs } from '@/lib/invoicePdfs';
import { companyAddress, addressLines } from '@/lib/companyAddress';
import { logAction } from '@/lib/logger';
import { getSession } from '@/lib/auth';
import { SHARED_MAILBOX, sendAsMailbox } from '@/lib/graphMail';

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

    // Get PDF buffer from base64 string
    const base64Data = pdfBase64.split('base64,')[1] || pdfBase64.replace(/^data:application\/pdf.*?;base64,/, "");
    const pdfBuffer = Buffer.from(base64Data, 'base64');

    // Firma con la razón social y dirección fiscal (BC) de la empresa de las facturas
    const firstInv = await prisma.invoice.findFirst({ where: { id: { in: invoiceIds.map(Number) } }, select: { companyId: true } });
    const fiscal = await companyAddress(firstInv?.companyId || 'CRAZE');
    const signature = `
      <div style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px; font-size: 14px; color: #555;">
        <p style="margin: 0; font-weight: bold; color: #111;">${fiscal?.name || 'CRAZE GmbH'} Finance Team</p>
        ${fiscal ? `<p style="margin: 5px 0;">${addressLines(fiscal).join(' | ')}</p>` : ''}
        <p style="margin: 0;">Email <a href="mailto:invoice@craze-group.com" style="color: #3b82f6; text-decoration: none;">invoice@craze-group.com</a></p>
        <p style="margin: 0;">Web <a href="https://www.craze-group.com" style="color: #3b82f6; text-decoration: none;">www.craze-group.com</a></p>
        <br/>
        <img src="cid:crazelogo" alt="Craze Group" width="130" style="margin-top: 10px; display: block;" />
      </div>
    `;

    const formattedMessage = message.split('\n\n').map((p: string) => `<p style="margin-top: 0; margin-bottom: 16px;">${p.replace(/\n/g, '<br/>')}</p>`).join('');

    const html = `<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
              ${formattedMessage}
              ${signature}
             </div>`;
    const summaryPdf = { filename: 'Overdue_Invoices.pdf', content: Buffer.from(pdfBuffer), contentType: 'application/pdf' };
    const sender = (await getSession())?.username || '';

    // Siempre desde el buzón común invoice@ (Microsoft Graph, permiso de aplicación); sin alternativa por SMTP,
    // para que ningún recordatorio salga desde otra cuenta
    const via = 'graph' as const;
    const fromUsed = SHARED_MAILBOX;
    const logo = await fetch(new URL('/logo.png', request.url)).then(r => r.arrayBuffer()).then(b => Buffer.from(b)).catch(() => null);
    try {
      await sendAsMailbox({
        to, cc, subject, html,
        attachments: [
          ...[...invoicePdfs.files, summaryPdf].map(f => ({ name: f.filename, contentType: f.contentType, content: f.content })),
          ...(logo ? [{ name: 'logo.png', contentType: 'image/png', content: logo, contentId: 'crazelogo' }] : []),
        ],
      });
    } catch (e: any) {
      throw new Error(`No se pudo enviar desde ${SHARED_MAILBOX}: ${e.message}`);
    }
    // Save to database for all selected invoices
    for (const invoiceId of invoiceIds) {
      await prisma.reminder.create({
        data: {
          invoiceId,
          messageContent: level ? `[${sender ? `${sender} · ` : ''}${level}º recordatorio${cc ? ` · CC ${cc}` : ''}${insurance ? ' · aviso aseguradora' : ''}]\n${message}` : message,
        }
      });

    }
    // Cada factura suma su propia reclamación (en un mismo correo puede ir el 1er recordatorio de una y el 2º de otra)
    await registerClaim(invoiceIds.map(Number), new Date());
    // Comercial en copia: cuenta como aviso al comercial
    if (cc) await prisma.customer.update({ where: { id: customerId }, data: { salespersonReminderCount: { increment: 1 }, salespersonLastReminderDate: new Date() } }).catch(() => {});

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (customer) {
      // Quién envió (usuario de la sesión), aunque todos los correos salgan desde la misma cuenta
      const docs = await prisma.invoice.findMany({ where: { id: { in: invoiceIds.map(Number) } }, select: { bcId: true } });
      await logAction(
        level ? `Recordatorio ${level} a cliente` : 'Correo a cliente (Recordatorio)',
        `Cliente: ${customer.name} | Desde ${fromUsed} a ${to}${cc ? ` (CC ${cc})` : ''} | ${docs.map(d => d.bcId).join(', ')}${insurance ? ' · aviso aseguradora' : ''}${invoicePdfs.files.length ? ` · ${invoicePdfs.files.length} PDF de factura` : ''}`,
        customer.companyId,
      );
    }

    return NextResponse.json({ 
      success: true, 
      via,
      from: fromUsed,
      invoicePdfs: invoicePdfs.files.length,
      missingPdfs: invoicePdfs.missing
    });

  } catch (error: any) {
    console.error('Error sending email:', error);
    return NextResponse.json({ error: 'Failed to send email', details: error.message }, { status: 500 });
  }
}
