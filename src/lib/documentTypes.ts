// Tipos de documento de los movimientos de cliente/proveedor sincronizados desde BC.
// La sync trae todos los movimientos abiertos (cualquier Document Type) para las carteras;
// Recobros, Pagos a proveedores y Cashflow siguen trabajando solo con facturas, abonos y reembolsos.

// Valores guardados en Invoice.type (las facturas se guardan como 'invoice' por compatibilidad)
export const CUSTOMER_INVOICE_TYPES = ['invoice', 'Invoice', 'Credit Memo', 'Refund'];

// Valores guardados en PurchaseInvoice.type
export const VENDOR_INVOICE_TYPES = ['Invoice', 'Credit Memo'];

const CLASSIC_DOC_TYPES = ['Invoice', 'Credit Memo', 'Refund'];

// Clave única (bcId) de un movimiento. Facturas, abonos y reembolsos siguen usando el nº de documento
// (como hasta ahora, para no perder fechas de cashflow, archivados o recordatorios). El resto de tipos
// (pagos, etc.) puede repetir nº de documento, así que se añade el tipo y el nº de movimiento.
export function ledgerKey(documentType: string | null | undefined, documentNo: string, entryNo?: number | string | null): string {
  const type = (documentType || '').trim();
  if (CLASSIC_DOC_TYPES.includes(type)) return String(documentNo);
  return `${documentNo}|${type || 'Sin tipo'}|${entryNo ?? ''}`;
}

export function customerDocType(documentType: string | null | undefined): string {
  const type = (documentType || '').trim();
  if (type === 'Invoice') return 'invoice';
  return type || 'Sin tipo';
}

export function vendorDocType(documentType: string | null | undefined): string {
  return (documentType || '').trim() || 'Sin tipo';
}
