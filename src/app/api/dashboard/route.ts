import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { getBcContext } from '@/lib/bcClient';
import { payablesReport } from '@/lib/reporting/ledgers';
import { currentMonth } from '@/lib/reporting/period';
import { purchaseNotes } from '@/lib/purchaseNotes';
import { companyCurrency, eurRate, GROUP_COMPANIES } from '@/lib/royalties';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Cliente o proveedor del grupo (forma de pago INTERGROUP o nombre "CRAZE …"): fuera del consolidado
const GROUP_NAME = /^craze\b/i;
const isIntergroup = (pm?: string | null, name?: string | null) => (pm || '').toUpperCase() === 'INTERGROUP' || GROUP_NAME.test(name || '');

// Cifras de una empresa. consolidated: importes en EUR (toEur según la divisa de cada partida) y sin intercompañía.
async function companyKpis(companyId: string, force: boolean, consolidated: boolean, toEur: (amt: number, currency: string) => number) {
  const today = new Date();
  const lcy = companyCurrency(companyId);

  // -- CASHFLOW AVAILABLE CALCULATION --
  const cashflowConfigs = await prisma.cashflowConfig.findMany({ where: { companyId } });

  const cashflowAvailable: Record<string, number> = {};
  for (const conf of cashflowConfigs) {
    cashflowAvailable[conf.currencyCode] = conf.initialBalance;
  }
  // -- END CASHFLOW CALCULATION --

  // 1. CARTERA CLIENTES (Cobros)
  const openInvoices = await prisma.invoice.findMany({
    where: {
      companyId,
      status: { in: ['open', 'Open', 'Overdue', 'overdue'] },
    },
    include: {
      customer: true
    }
  });

  let totalCarteraClientes = 0;
  let totalVencido = 0;
  let totalMarkant = 0;
  let totalConfirmadoMarkant = 0;
  let totalAmazon = 0;
  let totalRefundsCliente = 0;

  for (const inv of openInvoices) {
    if (consolidated && (isIntergroup(inv.paymentMethod, inv.customer.name) || isIntergroup(inv.customer.paymentMethod))) continue;
    // Sin divisa (o EUR por defecto de la sincronización) = divisa local de la empresa
    const amt = toEur(inv.amount || 0, inv.currencyCode && inv.currencyCode !== 'EUR' ? inv.currencyCode : lcy);
    totalCarteraClientes += amt;

    const isOverdue = inv.dueDate < today;
    if (isOverdue) totalVencido += amt;

    if (inv.type === 'Refund') {
      totalRefundsCliente += amt;
    }

    // Check for Markant — based exclusively on paymentMethod code
    const pMethod = (inv.paymentMethod || '').toLowerCase();
    // Confirmado = con Confirmed Payment Date; Pendiente de confirmar = el resto (Confirmado + Pendiente = Total)
    if (pMethod.includes('markant')) {
      totalMarkant += amt;
      if (inv.confirmedPaymentDate) totalConfirmadoMarkant += amt;
    }

    // Check for Amazon
    const cName = (inv.customer.name || '').toLowerCase();
    if (cName.includes('amazon') || pMethod.includes('amazon')) {
      totalAmazon += amt;
    }
  }

  // 2. CARTERA PROVEEDORES (Pagos)
  const openPurchases = await prisma.purchaseInvoice.findMany({
    where: {
      companyId,
      status: { in: ['open', 'Open', 'Overdue', 'overdue'] },
    },
    include: {
      approvals: true,
      vendor: { select: { name: true, paymentMethod: true } },
    }
  });

  let totalCarteraProveedores = 0;
  let totalCarteraVencidaNoAprobada = 0;
  let totalCarteraVencidaAprobada = 0;
  let totalRefundsProveedor = 0;

  let totalChina = 0;
  let totalConfirmadoChina = 0;
  let totalPendienteChina = 0;

  for (const pinv of openPurchases) {
    if (consolidated && isIntergroup(pinv.vendor?.paymentMethod, pinv.vendor?.name)) continue;
    const amt = toEur(pinv.amount || 0, lcy);
    totalCarteraProveedores += amt;

    if (pinv.type === 'Credit Memo') {
      totalRefundsProveedor += amt;
    }

    const isOverdue = pinv.dueDate < today;

    // Evaluate approvals
    const totalApps = pinv.approvals ? pinv.approvals.length : 0;
    const approvedCount = pinv.approvals ? pinv.approvals.filter(a => a.status === 'Approved').length : 0;
    const rejectedCount = pinv.approvals ? pinv.approvals.filter(a => a.status === 'Rejected').length : 0;
    const isFullyApproved = totalApps > 0 && approvedCount === totalApps && rejectedCount === 0;

    if (isOverdue) {
      if (isFullyApproved) {
        totalCarteraVencidaAprobada += amt;
      } else {
        totalCarteraVencidaNoAprobada += amt;
      }
    }

    // Check for China TRF
    if ((pinv.paymentMethod || '').toLowerCase() === 'china trf') {
      totalChina += amt;
      if (pinv.schedulePaymentDate) {
        totalConfirmadoChina += amt;
      } else {
        totalPendienteChina += amt;
      }
    }
  }

  // -- INVENTORY VALUATION --
  const latestValuation = await prisma.inventoryValuation.findFirst({
    where: { companyId },
    orderBy: { month: 'desc' }
  });

  // China: en directo de BC (movimientos de proveedor abiertos con forma de pago CHINA TRF del propio movimiento,
  // importe pendiente en divisa local; confirmado = con Scheduled Payment Date), igual que el Reporting.
  // Se guarda 1 h y se renueva en segundo plano. Si BC falla, se queda el cálculo con los datos sincronizados.
  let chinaSource: 'bc' | 'sync' = 'sync';
  try {
    const ctx = await getBcContext(companyId);
    const { china } = await payablesReport(ctx, companyId, currentMonth(), force);
    totalChina = toEur(-china.total, lcy);
    totalConfirmadoChina = toEur(-china.conf, lcy);
    totalPendienteChina = toEur(-china.unconf, lcy);
    chinaSource = 'bc';
  } catch (e) {
    console.error(`Dashboard China desde BC (${companyId}):`, e);
  }

  // Notas de compra sin leer (Notes de BC en facturas/abonos de compra; null si BC no las publica)
  let unreadPurchaseNotes: number | null = null;
  try {
    const notes = await purchaseNotes(await getBcContext(companyId));
    unreadPurchaseNotes = notes.filter(n => !n.read).length;
  } catch (e) {
    console.error(`Dashboard notas de compra (${companyId}):`, e);
  }

  // Markant: todas las partidas abiertas con forma de pago MARKANT (abiertas y vencidas: en BC todas están "Open")
  const totalPendienteMarkant = totalMarkant - totalConfirmadoMarkant;

  return {
    chinaSource,
    // Cobros
    totalCarteraClientes,
    totalEnMarkant: totalMarkant,
    totalConfirmadoMarkant,
    totalPendienteMarkant,
    totalVencido,
    totalAmazon,

    // Pagos
    totalCarteraProveedores,
    totalCarteraVencidaNoAprobada,
    totalCarteraVencidaAprobada,

    // China
    totalChina,
    totalConfirmadoChina,
    totalPendienteChina,

    // Notas de compra
    unreadPurchaseNotes,

    // Refunds & Returns
    totalRefundsAbiertosCliente: totalRefundsCliente,
    totalRefundsAbiertoProveedor: totalRefundsProveedor,
    salesReturnOrdersAbiertas: 0, // Placeholder

    // Cashflow (Total per currency)
    cashflowAvailable,

    // Inventory
    latestValuation: latestValuation && {
      month: latestValuation.month,
      totalSystemVal: toEur(latestValuation.totalSystemVal, lcy),
      totalNewVal: toEur(latestValuation.totalNewVal, lcy),
      difference: toEur(latestValuation.difference, lcy),
    },
  };
}

type Kpis = Awaited<ReturnType<typeof companyKpis>>;
const SUM_KEYS = [
  'totalCarteraClientes', 'totalEnMarkant', 'totalConfirmadoMarkant', 'totalPendienteMarkant', 'totalVencido', 'totalAmazon',
  'totalCarteraProveedores', 'totalCarteraVencidaNoAprobada', 'totalCarteraVencidaAprobada',
  'totalChina', 'totalConfirmadoChina', 'totalPendienteChina',
  'totalRefundsAbiertosCliente', 'totalRefundsAbiertoProveedor', 'salesReturnOrdersAbiertas',
] as const;

// CRAZE Consolidated: las empresas del grupo sumadas en EUR (tipo de cambio de CRAZE GmbH, como el BWA), sin
// cobros ni pagos intercompañía. El disponible de cashflow se suma por divisa.
async function consolidatedKpis(force: boolean) {
  const currencies = new Set(['GBP', 'CHF', 'USD']);
  for (const r of await prisma.invoice.findMany({ where: { status: { in: ['open', 'Open', 'Overdue', 'overdue'] } }, distinct: ['currencyCode'], select: { currencyCode: true } })) {
    if (r.currencyCode && r.currencyCode !== 'EUR') currencies.add(r.currencyCode);
  }
  const fx: Record<string, number> = { EUR: 1 };
  const fxErrors: string[] = [];
  await Promise.all(Array.from(currencies).map(async cur => {
    const r = await eurRate(null, cur, force);
    if (r.rate) fx[cur] = r.rate; else fxErrors.push(`${cur}: ${r.error}`);
  }));
  // Sin tipo de cambio, el importe se queda en su divisa (y se avisa)
  const toEur = (amt: number, cur: string) => amt * (fx[cur] ?? 1);

  const parts = await Promise.all(GROUP_COMPANIES.map(co => companyKpis(co, force, true, toEur)));
  const total = Object.fromEntries(SUM_KEYS.map(k => [k, parts.reduce((s, p) => s + p[k], 0)])) as Record<typeof SUM_KEYS[number], number>;
  const cashflowAvailable: Record<string, number> = {};
  for (const p of parts) for (const [cur, v] of Object.entries(p.cashflowAvailable)) cashflowAvailable[cur] = (cashflowAvailable[cur] || 0) + v;
  const valuations = parts.flatMap(p => (p.latestValuation ? [p.latestValuation] : []));
  const notes = parts.map(p => p.unreadPurchaseNotes).filter((n): n is number => n != null);

  return {
    ...total,
    consolidated: true,
    fxErrors,
    chinaSource: parts.every(p => p.chinaSource === 'bc') ? 'bc' : 'sync',
    unreadPurchaseNotes: notes.length ? notes.reduce((s, n) => s + n, 0) : null,
    cashflowAvailable,
    latestValuation: valuations.length ? {
      month: valuations.map(v => v.month).sort((a, b) => b.getTime() - a.getTime())[0],
      totalSystemVal: valuations.reduce((s, v) => s + v.totalSystemVal, 0),
      totalNewVal: valuations.reduce((s, v) => s + v.totalNewVal, 0),
      difference: valuations.reduce((s, v) => s + v.difference, 0),
    } : null,
  } satisfies Omit<Kpis, 'chinaSource'> & Record<string, unknown>;
}

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    return NextResponse.json(companyId === 'ALL' ? await consolidatedKpis(force) : await companyKpis(companyId, force, false, amt => amt));
  } catch (error: any) {
    console.error('Error fetching dashboard KPIs:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
