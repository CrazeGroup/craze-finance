import { bcFetchAll, bcFetchByEntryRanges, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR, readSetting } from './cache';
import { cutoffDate, monthEnd, shiftMonth, today } from './period';

// Inventario a una fecha a partir de los movimientos de valor de BC (servicio OData "ValueEntries"),
// igual que la página Inventory Value CRZ (80016): valor y cantidad por producto, cantidad por almacén.
// Los movimientos sin producto (Item_No vacío) no forman parte del inventario.

export type InvItem = { no: string; desc: string; type: string; qty: number; value: number; loc: Record<string, number> };
export type InvSnapshot = { date: string; items: InvItem[] };

// Depreciación 2023 por producto (% sobre el valor), fija desde el cierre de 2023
export const DEPRECIATION_2023_DEFAULT: Record<string, number> = {
  '19276': -0.1, '24058': -0.25, '24218': -0.25, '25123': -0.1, '26021': -0.25, '26069': -0.25,
  '28568': -0.5, '29640': -0.25, '29985': -0.25, '35009': -0.25, '35030': -0.5, '36501': -0.5,
  '36532': -0.5, '43622': -0.25, '43646': -0.25, '43677': -0.25, '43684': -0.25, '58467': -0.25,
};

const INVENTORY_ACCOUNT = '1140 00';

export async function fetchSnapshots(ctx: BcContext, dates: string[]): Promise<Record<string, InvSnapshot>> {
  const maxDate = dates.reduce((a, b) => (a > b ? a : b));
  const [entries, items] = await Promise.all([
    bcFetchByEntryRanges(
      `${ctx.odataCompanyBase}/ValueEntries`, ctx.token, 'Entry_No',
      'Entry_No,Item_No,Item_Description,Location_Code,Posting_Date,Cost_Amount_Actual,Item_Ledger_Entry_Quantity',
      `Posting_Date le ${maxDate}`
    ),
    bcFetchAll(odataUrl(`${ctx.apiBase}/items`, { $select: 'number,displayName,type' }), ctx.token),
  ]);
  const itemInfo = new Map(items.map((i: any) => [i.number, { name: i.displayName, type: i.type }]));

  const result: Record<string, InvSnapshot> = {};
  for (const date of dates) {
    const byItem = new Map<string, InvItem>();
    for (const e of entries) {
      if (!e.Item_No || e.Posting_Date > date) continue;
      let item = byItem.get(e.Item_No);
      if (!item) {
        const info = itemInfo.get(e.Item_No);
        item = { no: e.Item_No, desc: info?.name || e.Item_Description || '', type: info?.type || '', qty: 0, value: 0, loc: {} };
        byItem.set(e.Item_No, item);
      }
      item.value += e.Cost_Amount_Actual || 0;
      const qty = e.Item_Ledger_Entry_Quantity || 0;
      item.qty += qty;
      if (qty) item.loc[e.Location_Code || '(sin almacén)'] = (item.loc[e.Location_Code || '(sin almacén)'] || 0) + qty;
    }
    const list = Array.from(byItem.values())
      .map(i => ({
        ...i,
        value: Math.round(i.value * 100) / 100,
        loc: Object.fromEntries(Object.entries(i.loc).filter(([, q]) => Math.abs(q) > 0.0001)),
      }))
      .filter(i => Math.abs(i.qty) > 0.0001 || Math.abs(i.value) >= 0.01);
    result[date] = { date, items: list };
  }
  return result;
}

// Instantáneas en caché: las fechas pasadas 24 h, la de hoy 2 h
async function snapshotsAt(ctx: BcContext, company: string, dates: string[], force: boolean) {
  const t = today();
  const out: Record<string, InvSnapshot> = {};
  let fetched: Record<string, InvSnapshot> | null = null;
  for (const date of dates) {
    out[date] = await cached(`inv:${company}:${date}`, date < t ? 24 * HOUR : 2 * HOUR, async () => {
      fetched = fetched || (await fetchSnapshots(ctx, dates));
      return fetched[date];
    }, force);
  }
  return out;
}

export async function inventoryAccountBalance(ctx: BcContext, date: string): Promise<number> {
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/generalLedgerEntries`, {
    $filter: `accountNumber eq '${INVENTORY_ACCOUNT}' and postingDate le ${date}`,
    $select: 'debitAmount,creditAmount',
  }), ctx.token);
  return rows.reduce((s, r) => s + (r.debitAmount || 0) - (r.creditAmount || 0), 0);
}

// Valor por almacén = cantidad del almacén x coste unitario del producto (como la página 80016)
function valueByLocation(snap: InvSnapshot) {
  const values: Record<string, number> = {};
  for (const item of snap.items) {
    if (!item.qty) continue;
    const unit = item.value / item.qty;
    for (const [loc, qty] of Object.entries(item.loc)) values[loc] = (values[loc] || 0) + qty * unit;
  }
  return values;
}

const sum = (items: InvItem[], f: (i: InvItem) => number) => items.reduce((s, i) => s + f(i), 0);

export async function inventoryReport(ctx: BcContext, company: string, month: string, force = false) {
  const date = cutoffDate(month);
  const prevDate = monthEnd(shiftMonth(month, -1));
  const [snaps, gl, depreciation] = await Promise.all([
    snapshotsAt(ctx, company, [date, prevDate], force),
    inventoryAccountBalance(ctx, date),
    readSetting<Record<string, number>>('depreciation2023', DEPRECIATION_2023_DEFAULT),
  ]);
  return buildInventoryReport(snaps[date], snaps[prevDate], gl, depreciation);
}

export function buildInventoryReport(cur: InvSnapshot, prev: InvSnapshot, gl: number, depreciation: Record<string, number>) {
  const date = cur.date;
  const prevDate = prev.date;

  // Referencias que cambian de código entre meses (p. ej. 01318 -> 01318LIDL): se emparejan por descripción
  const curNos = new Set(cur.items.map(i => i.no));
  const prevNos = new Set(prev.items.map(i => i.no));
  const remap: Record<string, string> = {};
  for (const p of prev.items) {
    if (curNos.has(p.no) || !p.desc) continue;
    const match = cur.items.find(c => !prevNos.has(c.no) && c.desc === p.desc);
    if (match) remap[p.no] = match.no;
  }
  const prevByNo = new Map<string, InvItem>();
  for (const p of prev.items) prevByNo.set(remap[p.no] || p.no, p);
  const curByNo = new Map(cur.items.map(i => [i.no, i]));

  const total = sum(cur.items, i => i.value);
  const prevTotal = sum(prev.items, i => i.value);
  const totalDep = sum(cur.items, i => i.value * (1 + (depreciation[i.no] || 0)));
  const prevTotalDep = sum(prev.items, i => i.value * (1 + (depreciation[i.no] || 0)));

  const locCur = valueByLocation(cur);
  const locPrev = valueByLocation(prev);
  const locations = Array.from(new Set([...Object.keys(locCur), ...Object.keys(locPrev)]))
    .map(loc => ({ loc, value: locCur[loc] || 0, prevValue: locPrev[loc] || 0 }))
    .filter(l => Math.abs(l.value) >= 0.5 || Math.abs(l.prevValue) >= 0.5)
    .sort((a, b) => b.value - a.value);

  // Variación por producto
  const allNos = new Set([...curByNo.keys(), ...prevByNo.keys()]);
  const changes = Array.from(allNos).map(no => {
    const c = curByNo.get(no);
    const p = prevByNo.get(no);
    return {
      code: no, desc: c?.desc || p?.desc || '', type: c?.type || p?.type || '',
      qa: p?.qty || 0, qs: c?.qty || 0, va: p?.value || 0, vs: c?.value || 0, dv: (c?.value || 0) - (p?.value || 0),
    };
  });
  const up = changes.filter(c => c.dv > 0.5).sort((a, b) => b.dv - a.dv).slice(0, 10);
  const down = changes.filter(c => c.dv < -0.5).sort((a, b) => a.dv - b.dv).slice(0, 10);

  // Coste unitario: efecto precio (mismas unidades) vs volumen/mix
  const both = changes.filter(c => c.type === 'Inventory' && c.qa > 0 && c.qs > 0);
  const costItems = both.map(c => {
    const ca = c.va / c.qa;
    const cs = c.vs / c.qs;
    return { code: c.code, desc: c.desc, qs: c.qs, ca, cs, dcp: ca ? (cs - ca) / Math.abs(ca) * 100 : 0, eff: (cs - ca) * c.qs };
  });
  const priceEffect = costItems.reduce((s, i) => s + i.eff, 0);
  const changed = costItems.filter(i => Math.abs(i.dcp) > 0.5);
  const qtyCur = sum(cur.items, i => i.qty);
  const qtyPrev = sum(prev.items, i => i.qty);

  return {
    date, prevDate,
    total, prevTotal, totalDep, prevTotalDep,
    qty: qtyCur, prevQty: qtyPrev,
    // Referencias con stock y valor (como el informe Inventory Value)
    nItems: cur.items.filter(i => i.qty > 0 && i.value).length, prevNItems: prev.items.filter(i => i.qty > 0 && i.value).length,
    remap,
    locations,
    up, down,
    glAccount: INVENTORY_ACCOUNT, glBalance: gl,
    cost: {
      nBoth: costItems.length, nChanged: changed.length,
      nUp: changed.filter(i => i.dcp > 0).length, nDown: changed.filter(i => i.dcp < 0).length,
      priceEffect, volEffect: (total - prevTotal) - priceEffect,
      unitCostPrev: qtyPrev ? prevTotal / qtyPrev : 0, unitCostCur: qtyCur ? total / qtyCur : 0,
      items: changed.sort((a, b) => Math.abs(b.eff) - Math.abs(a.eff)).slice(0, 15),
    },
  };
}
