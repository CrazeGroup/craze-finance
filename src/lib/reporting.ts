import prisma from '@/lib/prisma';

// ---- Periodos ----
// Los meses se manejan como "YYYY-MM". Las fechas de corte son el último día del mes.

export function parseMonths(param: string | null): string[] {
  const months = (param || '')
    .split(',')
    .map(m => m.trim())
    .filter(m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m));
  return Array.from(new Set(months)).sort();
}

export function currentMonth(): string {
  return new Date().toISOString().substring(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().substring(0, 7);
}

// Primer día del mes ("YYYY-MM-DD")
export function monthStart(month: string): string {
  return `${month}-01`;
}

// Último día del mes ("YYYY-MM-DD")
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().substring(0, 10);
}

// Todas las empresas cuando en la app está seleccionada "ALL"
export async function resolveCompanies(companyId: string): Promise<string[]> {
  if (companyId !== 'ALL') return [companyId];
  const rows = await prisma.customer.findMany({ distinct: ['companyId'], select: { companyId: true } });
  return rows.map(r => r.companyId);
}

// ---- Configuración del reporting (guardada en ApiConfig, clave 'reporting') ----

export type ReportingConfig = {
  provisionAccounts: string[];   // Cuentas contables de provisiones en BC
  valueEntriesService: string;   // Nombre del servicio web OData de la página "Value Entries" (5802)
};

const DEFAULT_CONFIG: ReportingConfig = {
  provisionAccounts: [],
  valueEntriesService: 'ValueEntries',
};

export async function getReportingConfig(): Promise<ReportingConfig> {
  const row = await prisma.apiConfig.findUnique({ where: { key: 'reporting' } });
  if (!row?.config) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(row.config) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveReportingConfig(config: ReportingConfig) {
  const clean: ReportingConfig = {
    provisionAccounts: (config.provisionAccounts || []).map(a => String(a).trim()).filter(Boolean),
    valueEntriesService: String(config.valueEntriesService || DEFAULT_CONFIG.valueEntriesService).trim(),
  };
  await prisma.apiConfig.upsert({
    where: { key: 'reporting' },
    update: { config: JSON.stringify(clean) },
    create: { key: 'reporting', url: '', config: JSON.stringify(clean) },
  });
  return clean;
}

// ---- Cartera (clientes y proveedores) ----

const OPEN_STATUSES = ['open', 'Open', 'Overdue', 'overdue'];
export const KEY_ACCOUNTS = ['AMAZON', 'ALDI', 'LIDL'];

export type ConfirmedSplit = { total: number; confirmed: number; unconfirmed: number };

export type Portfolio = {
  customers: {
    total: number;
    byPaymentMethod: Record<string, number>;
    keyAccounts: Record<string, number>;   // Clientes sin seguro: AMAZON, ALDI, LIDL
    markant: ConfirmedSplit;
  };
  vendors: {
    total: number;
    byPaymentMethod: Record<string, number>;
    chinaInv: ConfirmedSplit;
  };
};

const add = (map: Record<string, number>, key: string, amount: number) => {
  map[key] = (map[key] || 0) + amount;
};

// Cartera abierta en este momento, calculada desde la base de datos (última sincronización con BC)
export async function computePortfolio(companyId: string): Promise<Portfolio> {
  const companies = await resolveCompanies(companyId);

  const invoices = await prisma.invoice.findMany({
    where: { companyId: { in: companies }, status: { in: OPEN_STATUSES } },
    select: { amount: true, paymentMethod: true, confirmedPaymentDate: true, customer: { select: { name: true, paymentMethod: true } } }
  });

  const customers: Portfolio['customers'] = {
    total: 0,
    byPaymentMethod: {},
    keyAccounts: Object.fromEntries(KEY_ACCOUNTS.map(k => [k, 0])),
    markant: { total: 0, confirmed: 0, unconfirmed: 0 },
  };

  for (const inv of invoices) {
    const amount = inv.amount || 0;
    const method = (inv.paymentMethod || inv.customer?.paymentMethod || 'Sin forma de pago').toUpperCase();
    customers.total += amount;
    add(customers.byPaymentMethod, method, amount);

    const name = (inv.customer?.name || '').toUpperCase();
    const keyAccount = KEY_ACCOUNTS.find(k => name.includes(k));
    if (keyAccount) customers.keyAccounts[keyAccount] += amount;

    // Mismo criterio que el Dashboard: forma de pago MARKANT + fecha de pago confirmada informada
    if (method === 'MARKANT') {
      customers.markant.total += amount;
      if (inv.confirmedPaymentDate) customers.markant.confirmed += amount;
      else customers.markant.unconfirmed += amount;
    }
  }

  const purchaseInvoices = await prisma.purchaseInvoice.findMany({
    where: { companyId: { in: companies }, status: { in: OPEN_STATUSES } },
    select: { amount: true, paymentMethod: true, confirmedPaymentDate: true }
  });

  const vendors: Portfolio['vendors'] = {
    total: 0,
    byPaymentMethod: {},
    chinaInv: { total: 0, confirmed: 0, unconfirmed: 0 },
  };

  for (const pinv of purchaseInvoices) {
    const amount = pinv.amount || 0;
    const method = (pinv.paymentMethod || 'Sin forma de pago').toUpperCase();
    vendors.total += amount;
    add(vendors.byPaymentMethod, method, amount);

    if (method === 'CHINA INV') {
      vendors.chinaInv.total += amount;
      if (pinv.confirmedPaymentDate) vendors.chinaInv.confirmed += amount;
      else vendors.chinaInv.unconfirmed += amount;
    }
  }

  return { customers, vendors };
}

// Guarda la foto del mes en curso para todas las empresas. Se ejecuta a diario (cron),
// así la última ejecución del mes queda como la foto a cierre.
export async function saveSnapshots() {
  const month = currentMonth();
  const companies = await resolveCompanies('ALL');
  for (const companyId of companies) {
    const data = await computePortfolio(companyId);
    await prisma.reportingSnapshot.upsert({
      where: { companyId_month: { companyId, month } },
      update: { data },
      create: { companyId, month, data },
    });
  }
  return { month, companies };
}

// Suma varias carteras (vista "ALL" con fotos guardadas por empresa)
export function mergePortfolios(list: Portfolio[]): Portfolio {
  const merged: Portfolio = {
    customers: { total: 0, byPaymentMethod: {}, keyAccounts: Object.fromEntries(KEY_ACCOUNTS.map(k => [k, 0])), markant: { total: 0, confirmed: 0, unconfirmed: 0 } },
    vendors: { total: 0, byPaymentMethod: {}, chinaInv: { total: 0, confirmed: 0, unconfirmed: 0 } },
  };
  const addSplit = (a: ConfirmedSplit, b: ConfirmedSplit) => {
    a.total += b.total; a.confirmed += b.confirmed; a.unconfirmed += b.unconfirmed;
  };
  for (const p of list) {
    merged.customers.total += p.customers.total;
    merged.vendors.total += p.vendors.total;
    for (const [k, v] of Object.entries(p.customers.byPaymentMethod)) add(merged.customers.byPaymentMethod, k, v);
    for (const [k, v] of Object.entries(p.customers.keyAccounts)) add(merged.customers.keyAccounts, k, v);
    for (const [k, v] of Object.entries(p.vendors.byPaymentMethod)) add(merged.vendors.byPaymentMethod, k, v);
    addSplit(merged.customers.markant, p.customers.markant);
    addSplit(merged.vendors.chinaInv, p.vendors.chinaInv);
  }
  return merged;
}
