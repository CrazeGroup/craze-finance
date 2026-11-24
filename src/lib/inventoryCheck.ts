import { bcFetchAll, bcFetchByEntryRanges, BcContext, odataUrl } from '@/lib/bcClient';

// Revisión del valor de inventario a una fecha (Craze Entertainment): por artículo, cantidad y valor según los Value
// Entries (Cost Amount Actual + Expected, como la página Inventory Value) por location, frente a cantidad × Unit Cost
// de la ficha. Solo lectura; sirve para preparar los ajustes en el Item Journal.
export type InvCheckItem = {
  no: string; desc: string; type: string; unitCost: number; costing?: string; residue?: number;
  qty: number; value: number; actual: number; expected: number; target: number; diff: number;
  locs: { location: string; qty: number; value: number }[];
  open: { entryNo: number; location: string; remaining: number; quantity: number; date: string; type: string; value: number; remainingValue: number }[];
  byEntry?: Record<string, number>;
};

export async function inventoryCheck(ctx: BcContext, date: string, onlyItems?: string[]) {
  const itemFilter = onlyItems?.length ? ` and (${onlyItems.map(i => `Item_No eq '${i.replace(/'/g, "''")}'`).join(' or ')})` : '';
  const [entries, items] = await Promise.all([
    bcFetchByEntryRanges(`${ctx.odataCompanyBase}/ValueEntries`, ctx.token, 'Entry_No',
      'Entry_No,Item_No,Item_Ledger_Entry_No,Location_Code,Posting_Date,Cost_Amount_Actual,Cost_Amount_Expected,Item_Ledger_Entry_Quantity',
      `Posting_Date le ${date}${itemFilter}`, 8, 120_000),
    bcFetchAll(odataUrl(`${ctx.apiBase}/items`, { $select: 'number,displayName,type,unitCost' }), ctx.token),
  ]);
  const byEntry = new Map<string, Record<string, number>>();
  const info = new Map(items.map((i: any) => [String(i.number), i]));
  const by = new Map<string, InvCheckItem & { loc: Map<string, { qty: number; value: number }> }>();
  for (const e of entries) {
    if (!e.Item_No) continue;
    let it = by.get(e.Item_No);
    if (!it) {
      const i: any = info.get(e.Item_No) || {};
      it = { no: e.Item_No, desc: i.displayName || '', type: i.type || '', unitCost: Number(i.unitCost) || 0, qty: 0, value: 0, actual: 0, expected: 0, target: 0, diff: 0, locs: [], open: [], loc: new Map() };
      by.set(e.Item_No, it);
    }
    const a = Number(e.Cost_Amount_Actual) || 0, x = Number(e.Cost_Amount_Expected) || 0, q = Number(e.Item_Ledger_Entry_Quantity) || 0;
    it.actual += a; it.expected += x; it.qty += q;
    const be = byEntry.get(e.Item_No) || {};
    be[e.Item_Ledger_Entry_No] = (be[e.Item_Ledger_Entry_No] || 0) + a + x;
    byEntry.set(e.Item_No, be);
    const l = it.loc.get(e.Location_Code || '') || { qty: 0, value: 0 };
    l.qty += q; l.value += a + x;
    it.loc.set(e.Location_Code || '', l);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const list = Array.from(by.values()).map(({ loc, ...it }) => {
    const value = it.actual + it.expected;
    const target = it.qty * it.unitCost;
    return {
      ...it, byEntry: byEntry.get(it.no), qty: r2(it.qty), actual: r2(it.actual), expected: r2(it.expected), value: r2(value), target: r2(target), diff: r2(target - value),
      locs: Array.from(loc.entries()).filter(([, v]) => Math.abs(v.qty) > 0.0001 || Math.abs(v.value) >= 0.01)
        .map(([location, v]) => ({ location, qty: r2(v.qty), value: r2(v.value) })),
    };
  }).filter(i => Math.abs(i.qty) > 0.0001 || Math.abs(i.value) >= 0.01);
  return list;
}

// Movimientos de producto abiertos (Remaining Quantity) a hoy de unos artículos, para aplicar los ajustes
export async function openEntries(ctx: BcContext, itemNos: string[]) {
  const out: any[] = [];
  for (let i = 0; i < itemNos.length; i += 20) {
    const part = itemNos.slice(i, i + 20);
    out.push(...await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Item_Ledger_Entries_Excel`, {
      $filter: `Open eq true and (${part.map(n => `Item_No eq '${n.replace(/'/g, "''")}'`).join(' or ')})`,
      $select: 'Entry_No,Item_No,Location_Code,Posting_Date,Entry_Type,Remaining_Quantity,Quantity',
    }), ctx.token));
  }
  return out;
}

// Método de coste de la ficha (Item_Card_Excel por nº, la lista completa es lenta)
export async function costingMethods(ctx: BcContext, itemNos: string[]) {
  const map: Record<string, string> = {};
  for (let i = 0; i < itemNos.length; i += 20) {
    const part = itemNos.slice(i, i + 20);
    const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Item_Card_Excel`, {
      $filter: part.map(n => `No eq '${n.replace(/'/g, "''")}'`).join(' or '), $select: 'No,Costing_Method,Unit_Cost',
    }), ctx.token).catch(() => []);
    for (const r of rows) map[r.No] = r.Costing_Method;
  }
  return map;
}
