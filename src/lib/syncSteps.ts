// Empresas y pasos de la sincronización con BC (mismo listado que bcSync.ts y CompanyContext).
// Cada paso es una llamada a POST /api/sync-bc para no pasar del límite de 60 s de Vercel.
export const SYNC_COMPANIES = ['CRAZE', 'Craze Iberia SL', 'Craze UK', 'CRAZE Group AG', 'Craze Entertainment'];

export const SYNC_STEPS = [
  { key: 'customers', label: 'Customers' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'vendorInvoices', label: 'Vendor invoices' },
  { key: 'recurring', label: 'Recurring payments' },
] as const;
