import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 segundos

export async function GET(req: NextRequest) {
  const sourceUrl = req.nextUrl.searchParams.get('source') || 
    process.env.SOURCE_DATABASE_URL || 
    "postgres://dd26cacd1f1d1e4c4f5f3293547808f26d0d8455d82e1f379039a5aedfdf7e17:sk_L92c_OjN_n9ZGuqjbZ63L@db.prisma.io:5432/postgres?sslmode=require";

  const targetUrl = req.nextUrl.searchParams.get('target') || 
    process.env.TARGET_DATABASE_URL || 
    process.env.DATABASE_URL || 
    "postgresql://neondb_owner:npg_BYNIj9PdEra3@ep-hidden-heart-b1k43hnb-pooler.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require";

  const sourcePrisma = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
  const targetPrisma = new PrismaClient({ datasources: { db: { url: targetUrl } } });

  const stats: Record<string, number> = {};
  const errors: Record<string, string> = {};

  async function safeCopy<T>(
    name: string, 
    fetchFn: () => Promise<T[]>, 
    insertFn: (data: T[]) => Promise<any>, 
    chunkSize = 500
  ) {
    try {
      const items = await fetchFn();
      if (!items || items.length === 0) {
        stats[name] = 0;
        return;
      }
      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        await insertFn(chunk);
      }
      stats[name] = items.length;
    } catch (err: any) {
      console.error(`Error copying ${name}:`, err.message);
      errors[name] = err.message;
    }
  }

  try {
    // 1. Configuraciones y usuarios
    await safeCopy('User', () => sourcePrisma.user.findMany(), data => targetPrisma.user.createMany({ data, skipDuplicates: true }));
    await safeCopy('BusinessCentralConfig', () => sourcePrisma.businessCentralConfig.findMany(), data => targetPrisma.businessCentralConfig.createMany({ data, skipDuplicates: true }));
    await safeCopy('EmailConfig', () => sourcePrisma.emailConfig.findMany(), data => targetPrisma.emailConfig.createMany({ data, skipDuplicates: true }));
    await safeCopy('ApiConfig', () => sourcePrisma.apiConfig.findMany(), data => targetPrisma.apiConfig.createMany({ data, skipDuplicates: true }));

    // CashflowConfig con soporte de SQL directo por si no tiene columna id en origen
    await safeCopy('CashflowConfig', async () => {
      try {
        return await sourcePrisma.cashflowConfig.findMany();
      } catch {
        const raw: any[] = await sourcePrisma.$queryRawUnsafe('SELECT * FROM "CashflowConfig"');
        return raw.map(r => ({
          companyId: r.companyId || 'CRAZE',
          currencyCode: r.currencyCode || 'EUR',
          initialBalance: parseFloat(r.initialBalance || 0),
          updatedAt: r.updatedAt ? new Date(r.updatedAt) : new Date()
        })) as any[];
      }
    }, data => targetPrisma.cashflowConfig.createMany({ data: data as any, skipDuplicates: true }));

    // RecurringPayment
    await safeCopy('RecurringPayment', async () => {
      try {
        return await sourcePrisma.recurringPayment.findMany();
      } catch {
        try {
          const raw: any[] = await sourcePrisma.$queryRawUnsafe('SELECT * FROM "RecurringPayment"');
          return raw;
        } catch {
          return [];
        }
      }
    }, data => targetPrisma.recurringPayment.createMany({ data: data as any, skipDuplicates: true }));

    await safeCopy('CashflowManualEntry', () => sourcePrisma.cashflowManualEntry.findMany(), data => targetPrisma.cashflowManualEntry.createMany({ data, skipDuplicates: true }));
    await safeCopy('InsurancePolicy', () => sourcePrisma.insurancePolicy.findMany(), data => targetPrisma.insurancePolicy.createMany({ data: data as any, skipDuplicates: true }));
    await safeCopy('CustomerContract', () => sourcePrisma.customerContract.findMany(), data => targetPrisma.customerContract.createMany({ data: data as any, skipDuplicates: true }));
    await safeCopy('InventoryValuation', () => sourcePrisma.inventoryValuation.findMany(), data => targetPrisma.inventoryValuation.createMany({ data, skipDuplicates: true }));
    await safeCopy('BwaReport', () => sourcePrisma.bwaReport.findMany(), data => targetPrisma.bwaReport.createMany({ data, skipDuplicates: true }));
    await safeCopy('ActionLog', () => sourcePrisma.actionLog.findMany(), data => targetPrisma.actionLog.createMany({ data, skipDuplicates: true }));

    // 2. Clientes y Facturas
    await safeCopy('Customer', () => sourcePrisma.customer.findMany(), data => targetPrisma.customer.createMany({ data, skipDuplicates: true }));
    await safeCopy('Invoice', () => sourcePrisma.invoice.findMany(), data => targetPrisma.invoice.createMany({ data, skipDuplicates: true }));
    await safeCopy('Reminder', () => sourcePrisma.reminder.findMany(), data => targetPrisma.reminder.createMany({ data, skipDuplicates: true }));

    // 3. Proveedores y Facturas de compra
    await safeCopy('Vendor', () => sourcePrisma.vendor.findMany(), data => targetPrisma.vendor.createMany({ data, skipDuplicates: true }));
    await safeCopy('PurchaseInvoice', () => sourcePrisma.purchaseInvoice.findMany(), data => targetPrisma.purchaseInvoice.createMany({ data, skipDuplicates: true }));
    await safeCopy('ApprovalEntry', () => sourcePrisma.approvalEntry.findMany(), data => targetPrisma.approvalEntry.createMany({ data, skipDuplicates: true }));

    // 4. Actualizar secuencias en la base de datos de Neon
    const sequenceTables = [
      'Customer', 'Invoice', 'Reminder', 'Vendor', 'PurchaseInvoice', 
      'ApprovalEntry', 'CashflowManualEntry', 'RecurringPayment', 
      'CashflowConfig', 'InsurancePolicy', 'CustomerContract', 
      'User', 'ActionLog', 'InventoryValuation', 'BwaReport'
    ];

    for (const table of sequenceTables) {
      try {
        await targetPrisma.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), coalesce(max(id), 1)) FROM "${table}";`
        );
      } catch (e) {}
    }

    return NextResponse.json({
      success: Object.keys(errors).length === 0,
      message: 'Proceso de migración ejecutado!',
      copiedRecords: stats,
      errors: Object.keys(errors).length > 0 ? errors : undefined
    });
  } catch (error: any) {
    console.error('Fatal migration error:', error);
    return NextResponse.json({
      success: false,
      error: error.message,
      partialStats: stats,
      errors
    }, { status: 500 });
  } finally {
    await sourcePrisma.$disconnect();
    await targetPrisma.$disconnect();
  }
}
