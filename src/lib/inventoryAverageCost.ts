import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { snapshotsAt } from '@/lib/reporting/inventory';
import { cutoffDate } from '@/lib/reporting/period';

// Inventario (Cierre): valoración a coste medio ponderado frente a la valoración de BC, por producto, a fin de mes.
// - Cantidad y valor de BC a la fecha: movimientos de valor (como Inventory Value CRZ / el Reporting).
// - Coste unitario de BC: ficha del producto.
// - Coste medio: movimientos de producto de compra y de ensamblado hasta la fecha, con su coste real
//   (incluye los cargos de producto); sin compras se usa el coste de la ficha.
// Solo productos de tipo Inventario con cantidad o valor a la fecha.

const AVERAGE_ENTRY_TYPES = ['Purchase', 'Assembly_x0020_Output', 'Assembly Output'];

export async function averageCostValuation(ctx: BcContext, company: string, month: string, force = false) {
  const date = cutoffDate(month);
  const [snaps, items, ...ileGroups] = await Promise.all([
    snapshotsAt(ctx, company, [date], force),
    bcFetchAll(odataUrl(`${ctx.apiBase}/items`, { $select: 'number,displayName,type,unitCost' }), ctx.token),
    // Un filtro por tipo (BC no admite "or" con enums en todas las versiones); los que fallen se ignoran
    ...AVERAGE_ENTRY_TYPES.map(t => bcFetchAll(odataUrl(`${ctx.apiBase}/itemLedgerEntries`, {
      $filter: `entryType eq '${t}' and postingDate le ${date}`,
      $select: 'itemNumber,entryType,quantity,costAmountActual',
    }), ctx.token).catch(() => [] as any[])),
  ]);
  const info = new Map(items.map((i: any) => [i.number, i]));
  const isInventory = (no: string) => /^inventory|inventario$/i.test(String(info.get(no)?.type || ''));

  const purchases = new Map<string, { qty: number; cost: number; n: number }>();
  for (const e of ileGroups.flat()) {
    if (!e.itemNumber || !e.quantity) continue;
    const p = purchases.get(e.itemNumber) || { qty: 0, cost: 0, n: 0 };
    p.qty += e.quantity;
    p.cost += e.costAmountActual || 0;
    p.n++;
    purchases.set(e.itemNumber, p);
  }

  const rows = snaps[date].items
    .filter(i => isInventory(i.no) && (Math.abs(i.qty) > 0.0001 || Math.abs(i.value) >= 0.01))
    .map(i => {
      const card = info.get(i.no);
      const systemUnitCost = Number(card?.unitCost) || 0;
      const p = purchases.get(i.no);
      const calculatedMeanCost = p && p.qty ? p.cost / p.qty : systemUnitCost;
      const invActual = i.value;
      const invNuevo = i.qty * calculatedMeanCost;
      return {
        itemNo: i.no, description: card?.displayName || i.desc, inventory: i.qty, systemUnitCost, calculatedMeanCost,
        purchasedQty: p?.qty || 0, purchaseEntries: p?.n || 0, invActual, invNuevo, invDiff: invNuevo - invActual,
      };
    })
    .sort((a, b) => a.itemNo.localeCompare(b.itemNo));

  const totalSystemVal = rows.reduce((s, r) => s + r.invActual, 0);
  const totalNewVal = rows.reduce((s, r) => s + r.invNuevo, 0);
  return { date, month, rows, summary: { totalSystemVal, totalNewVal, difference: totalNewVal - totalSystemVal } };
}
