// Provisiones de devoluciones de revistas de D-FORCE (cuenta 3071 00), sin dependencias de servidor:
// la página las recalcula al cambiar un coste unitario.
// - Factura de venta: se espera que el 80 % de lo vendido se devuelva →
//     PROV.<revista><MM>/<AA>      4300 00 (ventas) al debe   = 80 % del importe vendido
//     INV.PROV.<revista><MM>/<AA>  5881 00 (existencias) al debe = 80 % de las unidades × coste unitario
// - Abono de venta: las devoluciones reales deshacen esas provisiones (en negativo, al 100 %):
//     PROV.…      4300 00 = − importe devuelto
//     INV.PROV.…  5881 00 = − unidades devueltas × coste unitario
// Todas con contrapartida 3071 00, como los asientos de agosto de 2026. Solo se provisionan los números entregados
// en el mes (anexos LI/LA, con sus diferencias de entrega); los que solo tienen diferencias de entrega no.

export const PROVISION_RATE = 0.8;
export const ACC_SALES = '4300 00';
export const ACC_INVENTORY = '5881 00';
export const ACC_PROVISION = '3071 00';

// Prefijo de artículo → código de revista en el nº de documento
const MAGAZINE_CODE: Record<string, string> = { '05995': 'GAL', '05993': 'INKE', '05994': 'GALSP' };

type Line = { no: string; quantity: number; amount: number; description2: string; appendix?: string };

export type ProvisionRow = {
  item: string; code: string; delivered: boolean;
  soldQty: number; soldAmount: number; returnedQty: number; returnedAmount: number; unitCost: number | null;
  salesProvision: number; inventoryProvision: number; salesRelease: number; inventoryRelease: number;
};
export type JournalLine = {
  postingDate: string; documentNo: string; accountNo: string; description: string; amount: number; balAccountNo: string;
};

const r2 = (v: number) => Math.round(v * 100) / 100;

// "05995_2606" → "GAL06/26"; "05994_2601_SPECIAL" → "GALSP01/26"
export function magazineCode(item: string) {
  const [base, yymm] = item.split('_');
  const code = MAGAZINE_CODE[base];
  return code && yymm ? `${code}${yymm.slice(2, 4)}/${yymm.slice(0, 2)}` : item;
}

// invoice: líneas de la factura; credit: líneas del abono (solo las devoluciones, sin las contrapartidas NON-REC)
export function buildProvisions(invoice: Line[], credit: Line[], unitCost: Record<string, number | null>) {
  const rows = new Map<string, ProvisionRow>();
  const row = (item: string) => {
    let r = rows.get(item);
    if (!r) {
      r = { item, code: magazineCode(item), delivered: false, soldQty: 0, soldAmount: 0, returnedQty: 0, returnedAmount: 0, unitCost: unitCost[item] ?? null,
        salesProvision: 0, inventoryProvision: 0, salesRelease: 0, inventoryRelease: 0 };
      rows.set(item, r);
    }
    return r;
  };
  invoice.forEach(l => {
    const r = row(l.no);
    r.soldQty += l.quantity;
    r.soldAmount += l.amount;
    if (l.appendix === 'LI' || l.appendix === 'LA') r.delivered = true;
  });
  credit.filter(l => l.description2).forEach(l => { const r = row(l.no); r.returnedQty += l.quantity; r.returnedAmount += l.amount; });
  for (const r of rows.values()) {
    const cost = r.unitCost ?? 0;
    r.salesProvision = r.delivered ? r2(r.soldAmount * PROVISION_RATE) : 0;
    r.inventoryProvision = r.delivered ? r2(r.soldQty * PROVISION_RATE * cost) : 0;
    r.salesRelease = r2(-r.returnedAmount);
    r.inventoryRelease = r2(-r.returnedQty * cost);
  }
  return Array.from(rows.values()).sort((a, b) => a.code.localeCompare(b.code));
}

// Líneas de diario (4300 00 / 5881 00 contra 3071 00): primero las provisiones de la factura, luego las cancelaciones
export function journalLines(rows: ProvisionRow[], postingDate: string, creditNo: string): JournalLine[] {
  const out: JournalLine[] = [];
  const add = (documentNo: string, accountNo: string, amount: number, description: string) => {
    if (Math.abs(amount) >= 0.005) out.push({ postingDate, documentNo, accountNo, description, amount, balAccountNo: ACC_PROVISION });
  };
  for (const r of rows) add(`PROV.${r.code}`, ACC_SALES, r.salesProvision, `Provisions for returns ${PROVISION_RATE * 100}%`);
  for (const r of rows) add(`INV.PROV.${r.code}`, ACC_INVENTORY, r.inventoryProvision, `Provisions for returns ${PROVISION_RATE * 100}%`);
  for (const r of rows) add(`PROV.${r.code}`, ACC_SALES, r.salesRelease, `Returns D-FORCE ${creditNo}`.trim());
  for (const r of rows) add(`INV.PROV.${r.code}`, ACC_INVENTORY, r.inventoryRelease, `Returns D-FORCE ${creditNo}`.trim());
  return out;
}
