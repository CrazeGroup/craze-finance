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

  try {
    async function copyModel<T>(name: string, fetchFn: () => Promise<T[]>, insertFn: (data: T[]) => Promise<any>, chunkSize = 500) {
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
    }

    // 1. Configuraciones y usuarios
    await copyModel('User', () => sourcePrisma.user.findMany(), data => targetPrisma.user.createMany({ data, skipDuplicates: true }));
    await copyModel('BusinessCentralConfig', () => sourcePrisma.businessCentralConfig.findMany(), data => targetPrisma.businessCentralConfig.createMany({ data, skipDuplicates: true }));
    await copyModel('EmailConfig', () => sourcePrisma.emailConfig.findMany(), data => targetPrisma.emailConfig.createMany({ data, skipDuplicates: true }));
    await copyModel('ApiConfig', () => sourcePrisma.apiConfig.findMany(), data => targetPrisma.apiConfig.createMany({ data, skipDuplicates: true }));
    await copyModel('CashflowConfig', () => sourcePrisma.cashflowConfig.findMany(), data => targetPrisma.cashflowConfig.createMany({ data, skipDuplicates: true }));
    await copyModel('RecurringPayment', () => sourcePrisma.recurringPayment.findMany(), data => targetPrisma.recurringPayment.createMany({ data, skipDuplicates: true }));
    await copyModel('CashflowManualEntry', () => sourcePrisma.cashflowManualEntry.findMany(), data => targetPrisma.cashflowManualEntry.createMany({ data, skipDuplicates: true }));
    await copyModel('InsurancePolicy', () => sourcePrisma.insurancePolicy.findMany(), data => targetPrisma.insurancePolicy.createMany({ data: data as any, skipDuplicates: true }));
    await copyModel('CustomerContract', () => sourcePrisma.customerContract.findMany(), data => targetPrisma.customerContract.createMany({ data: data as any, skipDuplicates: true }));
    await copyModel('InventoryValuation', () => sourcePrisma.inventoryValuation.findMany(), data => targetPrisma.inventoryValuation.createMany({ data, skipDuplicates: true }));
    await copyModel('BwaReport', () => sourcePrisma.bwaReport.findMany(), data => targetPrisma.bwaReport.createMany({ data, skipDuplicates: true }));
    await copyModel('ActionLog', () => sourcePrisma.actionLog.findMany(), data => targetPrisma.actionLog.createMany({ data, skipDuplicates: true }));

    // 2. Clientes y Facturas
    await copyModel('Customer', () => sourcePrisma.customer.findMany(), data => targetPrisma.customer.createMany({ data, skipDuplicates: true }));
    await copyModel('Invoice', () => sourcePrisma.invoice.findMany(), data => targetPrisma.invoice.createMany({ data, skipDuplicates: true }));
    await copyModel('Reminder', () => sourcePrisma.reminder.findMany(), data => targetPrisma.reminder.createMany({ data, skipDuplicates: true }));

    // 3. Proveedores y Facturas de compra
    await copyModel('Vendor', () => sourcePrisma.vendor.findMany(), data => targetPrisma.vendor.createMany({ data, skipDuplicates: true }));
    await copyModel('PurchaseInvoice', () => sourcePrisma.purchaseInvoice.findMany(), data => targetPrisma.purchaseInvoice.createMany({ data, skipDuplicates: true }));
    await copyModel('ApprovalEntry', () => sourcePrisma.approvalEntry.findMany(), data => targetPrisma.approvalEntry.createMany({ data, skipDuplicates: true }));

    // 4. Actualizar las secuencias de IDs para evitar colisiones
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
      success: true,
      message: 'Base de datos migrada con éxito de Prisma Postgres a Neon!',
      copiedRecords: stats
    });
  } catch (error: any) {
    console.error('Migration error:', error);
    return NextResponse.json({
      success: false,
      error: error.message,
      partialStats: stats
    }, { status: 500 });
  } finally {
    await sourcePrisma.$disconnect();
    await targetPrisma.$disconnect();
  }
}
