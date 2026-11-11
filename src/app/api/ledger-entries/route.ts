import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Movimientos abiertos de cliente y proveedor que no son facturas (pagos, abonos, reembolsos y sin tipo),
// en directo de BC (API custom custLedgerEntries / vendorLedgerEntries) para la empresa seleccionada.
const VALID_DOCUMENT_TYPES = ['refund', 'credit memo', 'payment', ''];

const str = (v: any) => (v == null ? '' : String(v).trim());
const num = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const pick = (r: any, keys: string[]) => keys.map(k => r[k]).find(v => v !== undefined && v !== null && v !== '');
const docType = (v: any) => str(v).replace(/_x0020_/g, ' ');
const realDate = (d: any) => { const s = str(d).substring(0, 10); return s && !s.startsWith('0001') ? s : null; };

function mapEntry(type: 'Customer' | 'Vendor', r: any) {
  const t = docType(r.documentType);
  return {
    type,
    entryNo: num(r.entryNo),
    entityNo: str(type === 'Customer' ? r.customerNo : r.vendorNo),
    entityName: str(type === 'Customer' ? r.customerName : r.vendorName) || 'Unknown',
    postingDate: realDate(r.postingDate),
    dueDate: realDate(r.dueDate),
    documentType: t || 'Empty',
    documentNo: str(r.documentNo),
    externalDocumentNo: str(pick(r, ['externalDocumentNo', 'documentNoReceived', 'yourReference'])),
    currencyCode: str(r.currencyCode),
    originalAmount: num(pick(r, ['originalAmount', 'amount'])),
    remainingAmount: num(r.remainingAmount),
    description: str(r.description),
    paymentMethodCode: str(r.paymentMethodCode),
    messageToRecipient: str(r.messageToRecipient),
    salesReturnOrderNo: '',
  };
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const ctx = await getBcContext(company);

    const [customers, vendors] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.customApiBase}/custLedgerEntries`, { $filter: 'open eq true' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, { $filter: 'open eq true' }), ctx.token),
    ]);
    const keep = (r: any) => VALID_DOCUMENT_TYPES.includes(docType(r.documentType).toLowerCase());
    // Sales Return Order No. (campo de extensión, solo en la página OData de movimientos de cliente); si la empresa no
    // lo tiene, se queda vacío
    const returnOrders = new Map<number, string>();
    await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Customer_Ledger_Entries_Excel`, {
      $filter: 'Open eq true', $select: 'Entry_No,Sales_Return_Order_No_BCT',
    }), ctx.token).then(rows => rows.forEach((x: any) => { if (str(x.Sales_Return_Order_No_BCT)) returnOrders.set(num(x.Entry_No), str(x.Sales_Return_Order_No_BCT)); })).catch(() => {});
    const entries = [
      ...customers.filter(keep).map(r => ({ ...mapEntry('Customer', r), salesReturnOrderNo: returnOrders.get(num(r.entryNo)) || '' })),
      ...vendors.filter(keep).map(r => mapEntry('Vendor', r)),
    ].sort((a, b) => (a.postingDate || '').localeCompare(b.postingDate || ''));
    return NextResponse.json(entries);
  } catch (error: any) {
    console.error('Error fetching ledger entries:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
