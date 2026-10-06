import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';
import { syncBusinessCentral } from '@/lib/bcSync';
import { getCashflow } from '@/lib/cashflow';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const { searchParams } = new URL(req.url);
    const showArchived = searchParams.get('archived') === 'true';
    const currency = searchParams.get('currency') || 'EUR';

    return NextResponse.json(await getCashflow(companyId, currency, showArchived));
  } catch (error) {
    console.error('Error in cashflow GET:', error);
    return NextResponse.json({ error: 'Failed to get cashflow' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const body = await req.json();

    if (Array.isArray(body)) {
      const currency = body[0]?.currency || 'EUR';
      // It's an import from Excel
      const manualEntries = body.map(row => ({
        companyId,
        currencyCode: currency,
        date: new Date(row.date),
        description: row.description,
        amount: parseFloat(row.amount)
      }));
      await prisma.cashflowManualEntry.createMany({ data: manualEntries });
      return NextResponse.json({ success: true, count: manualEntries.length });
    }

    const { date, description, amount, currency } = body;
    if (!date || !description || amount === undefined) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const entry = await prisma.cashflowManualEntry.create({
      data: {
        companyId,
        currencyCode: currency || 'EUR',
        date: new Date(date),
        description,
        amount: parseFloat(amount)
      }
    });

    await logAction('Crear Cashflow Manual', `Importe: ${amount}, Desc: ${description}`, companyId);
    return NextResponse.json(entry);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create manual entry' }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const body = await req.json();
    const { id, type, action, date, description, amount, invoiceIds, isArchived } = body;

    if (type === 'config') {
      const currencyCode = body.currency || 'EUR';
      await prisma.cashflowConfig.upsert({
        where: { companyId_currencyCode: { companyId, currencyCode } },
        update: { initialBalance: parseFloat(amount), updatedAt: new Date() },
        create: { companyId, currencyCode, initialBalance: parseFloat(amount) }
      });
      return NextResponse.json({ success: true });
    }
    
    // Si la acción es 'archive_multiple', archivamos múltiples registros a la vez
    if (action === 'archive_multiple') {
      const { manualIds, invoiceIds: batchInvoiceIds } = body;
      const targetArchivedState = isArchived !== undefined ? isArchived : true;
      
      if (manualIds && Array.isArray(manualIds) && manualIds.length > 0) {
        await prisma.cashflowManualEntry.updateMany({
          where: { id: { in: manualIds } },
          data: { isArchived: targetArchivedState }
        });
      }
      
      if (batchInvoiceIds && Array.isArray(batchInvoiceIds) && batchInvoiceIds.length > 0) {
        await prisma.invoice.updateMany({
          where: { id: { in: batchInvoiceIds } },
          data: { isArchived: targetArchivedState }
        });
      }
      return NextResponse.json({ success: true });
    }

    // Si la acción es 'archive', archivamos/desarchivamos
    if (action === 'archive') {
      const targetArchivedState = isArchived !== undefined ? isArchived : true;
      if (type === 'manual') {
        const entry = await prisma.cashflowManualEntry.update({
          where: { id: parseInt(id) },
          data: { isArchived: targetArchivedState }
        });
        return NextResponse.json(entry);
      } else {
        // Archivar todo el grupo de facturas
        if (!invoiceIds || !Array.isArray(invoiceIds)) return NextResponse.json({ error: 'Missing invoiceIds' }, { status: 400 });
        await prisma.invoice.updateMany({
          where: { id: { in: invoiceIds } },
          data: { isArchived: targetArchivedState }
        });
        return NextResponse.json({ success: true });
      }
    }

    // Si type = 'invoice-date', actualizamos el cashflowDate de una o varias facturas
    if (type === 'invoice-date') {
      if (!invoiceIds || !Array.isArray(invoiceIds)) return NextResponse.json({ error: 'Missing invoiceIds' }, { status: 400 });
      await prisma.invoice.updateMany({
        where: { id: { in: invoiceIds } },
        data: { cashflowDate: new Date(date) }
      });
      await logAction('Mover Fechas Cashflow', `Se movieron ${invoiceIds.length} facturas a ${date}`, companyId);
      return NextResponse.json({ success: true });
    }
    
    // Si no, es una línea manual
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const entry = await prisma.cashflowManualEntry.update({
      where: { id: parseInt(id) },
      data: {
        date: date ? new Date(date) : undefined,
        description,
        amount: amount !== undefined ? parseFloat(amount) : undefined
      }
    });

    await logAction('Editar Cashflow Manual', `ID: ${id}, Nuevo Importe: ${amount}`, companyId);
    return NextResponse.json(entry);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const clearAll = searchParams.get('clearAll');
    const idsParam = searchParams.get('ids');
    
    if (clearAll === 'true') {
      await prisma.cashflowManualEntry.deleteMany({
        where: { companyId }
      });
      await logAction('Eliminar Todo Cashflow Manual', `Se eliminaron todos los registros manuales`, companyId);
      return NextResponse.json({ success: true, message: 'All manual entries deleted' });
    }

    if (idsParam) {
      const ids = idsParam.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
      if (ids.length > 0) {
        await prisma.cashflowManualEntry.deleteMany({
          where: { id: { in: ids } }
        });
        return NextResponse.json({ success: true, count: ids.length });
      }
    }

    if (req.body) {
      try {
        const body = await req.json();
        if (body.ids && Array.isArray(body.ids)) {
          await prisma.cashflowManualEntry.deleteMany({
            where: { id: { in: body.ids } }
          });
          return NextResponse.json({ success: true, count: body.ids.length });
        }
      } catch(e) {
        // body might be empty, fallback to query param
      }
    }

    if (!id) return NextResponse.json({ error: 'Missing id or ids' }, { status: 400 });

    await prisma.cashflowManualEntry.delete({
      where: { id: parseInt(id) }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete manual entry' }, { status: 500 });
  }
}
