import { bcFetchAll, bcFetchByEntryRanges, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from './cache';
import { analysisDates, indexer, palletSizes } from './inventoryAnalysis';

// KPIs de Análisis Inventario (además del valor): valor destruido en M+F, nº de palets y Average Days in Stock (FIFO).
// Se guardan en caché y se renuevan una vez al día (o con el botón de actualizar), para que carguen al momento.
// - Destruido: la location DESTR-M+F recibe por traspaso lo que se va a destruir y se vacía con ajustes negativos
//   (a fin de mes queda a 0); el valor destruido es el coste de esos ajustes negativos (movimientos de valor).
// - Palets: por artículo, uds en stock / uds de su unidad PAL (Item_Units_of_Measure_Excel), redondeado hacia
//   arriba; cada artículo cuenta por separado.
// - ADS: Item Ledger Entries de artículos tipo Inventory, sin traspasos (entran y salen de la empresa, no de una
//   location). Cada salida consume las entradas más antiguas (FIFO); días = fecha de salida − fecha de entrada,
//   ponderado por uds. ADS de un mes = media de las salidas de ese mes.

const DESTR_LOCATION = 'DESTR-M+F';
const DAY = 86400000;

export async function inventoryKpis(ctx: BcContext, company: string, month: string, force = false) {
  return cached(`invKpis2:${company}:${month}`, 24 * HOUR, async () => {
    const { year, cur, prev } = analysisDates(month);
    const date = cur[cur.length - 1];
    const from = `${year - 1}-01-01`;
    const [destr, ile, uoms, items, idx] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/ValueEntries`, {
        $filter: `Location_Code eq '${DESTR_LOCATION}' and Item_Ledger_Entry_Type eq 'Negative Adjmt.' and Posting_Date ge ${from} and Posting_Date le ${date}`,
        $select: 'Posting_Date,Item_Ledger_Entry_Quantity,Cost_Amount_Actual',
      }), ctx.token),
      bcFetchByEntryRanges(`${ctx.odataCompanyBase}/Item_Ledger_Entries_Excel`, ctx.token, 'Entry_No',
        'Entry_No,Posting_Date,Entry_Type,Item_No,Item_Description,Location_Code,Quantity', `Posting_Date le ${date}`),
      palletSizes(ctx),
      bcFetchAll(odataUrl(`${ctx.apiBase}/items`, { $select: 'number,type' }), ctx.token),
      indexer(force),
    ]);

    // Índice de mes: año anterior (0-11) y año del informe (12-)
    const monthIdx = (d: string) => {
      const y = Number(d.substring(0, 4)), m = Number(d.substring(5, 7)) - 1;
      return y === year - 1 ? (m < prev.length ? m : -1) : y === year ? (m < cur.length ? prev.length + m : -1) : -1;
    };
    const nMonths = prev.length + cur.length;

    // Destruido por mes (valor positivo) y uds
    const destroyed = Array.from({ length: nMonths }, () => ({ value: 0, qty: 0 }));
    for (const e of destr) {
      const mi = monthIdx(String(e.Posting_Date));
      if (mi < 0) continue;
      destroyed[mi].value -= e.Cost_Amount_Actual || 0;
      destroyed[mi].qty -= e.Item_Ledger_Entry_Quantity || 0;
    }

    // Stock por artículo a la fecha (todas las locations) y palets
    const inventoryItems = new Set(items.filter((i: any) => i.type === 'Inventory').map((i: any) => i.number));
    const stock = new Map<string, number>();
    for (const e of ile) stock.set(e.Item_No, (stock.get(e.Item_No) || 0) + (e.Quantity || 0));
    const perPallet = new Map<string, number>(Object.entries(uoms));
    let pallets = 0;
    const noPallet: string[] = [];
    for (const [no, qty] of stock) {
      if (qty <= 0.0001 || !inventoryItems.has(no)) continue;
      const per = perPallet.get(no);
      if (per) pallets += Math.ceil(qty / per - 1e-9);
      else noPallet.push(no);
    }

    // ADS por FIFO: entradas pendientes por artículo; cada salida consume las más antiguas
    const byItem = new Map<string, any[]>();
    for (const e of ile) {
      if (e.Entry_Type === 'Transfer' || !e.Quantity || !inventoryItems.has(e.Item_No)) continue;
      const list = byItem.get(e.Item_No) || [];
      list.push(e);
      byItem.set(e.Item_No, list);
    }
    const ads = Array.from({ length: nMonths }, () => ({ qtyDays: 0, qty: 0 }));
    for (const [no, list] of byItem) {
      list.sort((a, b) => a.Posting_Date.localeCompare(b.Posting_Date) || a.Entry_No - b.Entry_No);
      const lots: { t: number; qty: number }[] = [];
      let head = 0;
      for (const e of list) {
        const t = Date.parse(e.Posting_Date);
        if (e.Quantity > 0) { lots.push({ t, qty: e.Quantity }); continue; }
        let out = -e.Quantity;
        const mi = monthIdx(String(e.Posting_Date));
        let qtyDays = 0, qty = 0;
        while (out > 0.0001 && head < lots.length) {
          const lot = lots[head];
          const take = Math.min(lot.qty, out);
          qtyDays += take * Math.max(0, (t - lot.t) / DAY);
          qty += take;
          lot.qty -= take;
          out -= take;
          if (lot.qty <= 0.0001) head++;
        }
        // Salida sin entrada previa (stock negativo): no tiene antigüedad y no cuenta
        if (mi < 0 || !qty) continue;
        ads[mi].qtyDays += qtyDays;
        ads[mi].qty += qty;
        idx.add(mi, no, e.Item_Description || '', e.Location_Code || '(sin location)', qtyDays, qty);
      }
    }

    return {
      year, month, dates: [...prev, ...cur], curDates: cur, prevDates: prev,
      destroyed, pallets, noPallet: noPallet.length,
      ads: ads.map(a => ({ days: a.qty ? a.qtyDays / a.qty : null, qty: a.qty })),
      // Desglose del ADS: filas [mes, artículo, location de salida, uds × días, uds]
      totals: ads.map((a, i) => ({ date: [...prev, ...cur][i], value: a.qtyDays, qty: a.qty, skus: 0 })),
      items: idx.items, locs: idx.locs, rows: idx.rows, rawDesc: idx.rawDescs(),
    };
  }, force, { refreshAfterMs: 24 * HOUR });
}
