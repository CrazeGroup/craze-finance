import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext, bcFetchAll, BcContext } from '@/lib/bcClient';
import { getReportingConfig, monthEnd, parseMonths, shiftMonth } from '@/lib/reporting';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Campos de la página "Value Entries" (5802) publicada como servicio web OData en BC
const F = {
  date: 'Posting_Date',
  item: 'Item_No',
  location: 'Location_Code',
  cost: 'Cost_Amount_Actual',
  qty: 'Item_Ledger_Entry_Quantity',
};

type Totals = Map<string, { cost: number; qty: number }>;

// Valor y cantidad de inventario a una fecha, agrupado por almacén o por producto
type Aggregator = (date: string, groupField: string) => Promise<Totals>;

// Agrega en BC con $apply (rápido, BC devuelve una fila por grupo)
function bcAggregator(ctx: BcContext, service: string): Aggregator {
  return async (date, groupField) => {
    const apply = `filter(${F.date} le ${date})/groupby((${groupField}),aggregate(${F.cost} with sum as Cost,${F.qty} with sum as Qty))`;
    const rows = await bcFetchAll(`${ctx.odataCompanyBase}/${service}?$apply=${encodeURIComponent(apply)}`, ctx.token);
    const totals: Totals = new Map();
    for (const r of rows) totals.set(r[groupField] || '', { cost: r.Cost || 0, qty: r.Qty || 0 });
    return totals;
  };
}

// Alternativa si BC no admite $apply: descarga los movimientos hasta la última fecha y agrega aquí
async function rawAggregator(ctx: BcContext, service: string, lastDate: string): Promise<Aggregator> {
  const select = [F.date, F.item, F.location, F.cost, F.qty].join(',');
  const entries = await bcFetchAll(
    `${ctx.odataCompanyBase}/${service}?$filter=${encodeURIComponent(`${F.date} le ${lastDate}`)}&$select=${select}`,
    ctx.token
  );
  return async (date, groupField) => {
    const totals: Totals = new Map();
    for (const e of entries) {
      if (String(e[F.date]).substring(0, 10) > date) continue;
      const key = e[groupField] || '';
      const t = totals.get(key) || { cost: 0, qty: 0 };
      t.cost += e[F.cost] || 0;
      t.qty += e[F.qty] || 0;
      totals.set(key, t);
    }
    return totals;
  };
}

export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (companyId === 'ALL') {
      return NextResponse.json({ error: 'Selecciona una empresa concreta para ver el inventario.' }, { status: 400 });
    }
    const months = parseMonths(new URL(req.url).searchParams.get('months'));
    if (months.length === 0) return NextResponse.json({ error: 'Selecciona al menos un mes.' }, { status: 400 });

    const { valueEntriesService } = await getReportingConfig();
    const ctx = await getBcContext(companyId);

    // Comparativa: cierre del mes anterior al periodo vs cierre del último mes seleccionado
    const startMonth = shiftMonth(months[0], -1);
    const startDate = monthEnd(startMonth);
    const endDate = monthEnd(months[months.length - 1]);

    let aggregate: Aggregator = bcAggregator(ctx, valueEntriesService);
    let method: 'aggregate' | 'raw' = 'aggregate';
    let firstLocation: Totals;
    try {
      firstLocation = await aggregate(monthEnd(months[0]), F.location);
    } catch (applyError: any) {
      console.warn('BC $apply no disponible, se agregan los movimientos en la app:', applyError.message);
      try {
        aggregate = await rawAggregator(ctx, valueEntriesService, endDate);
        method = 'raw';
        firstLocation = await aggregate(monthEnd(months[0]), F.location);
      } catch (rawError: any) {
        throw new Error(
          `No se pudieron leer los movimientos de valor ("${valueEntriesService}") de BC. ` +
          `Comprueba que la página Value Entries (5802) está publicada como servicio web con ese nombre. Detalle: ${rawError.message}`
        );
      }
    }

    const [restLocations, startItems, endItems, items] = await Promise.all([
      Promise.all(months.slice(1).map(m => aggregate(monthEnd(m), F.location))),
      aggregate(startDate, F.item),
      aggregate(endDate, F.item),
      bcFetchAll(`${ctx.apiBase}/items?$select=number,displayName,type`, ctx.token),
    ]);
    const locationsByMonth = [firstLocation, ...restLocations];

    // Valor de inventario por almacén a cierre de cada mes seleccionado
    const locationCodes = new Set<string>();
    locationsByMonth.forEach(t => t.forEach((_, code) => locationCodes.add(code)));
    const byLocation = Array.from(locationCodes)
      .map(code => ({
        location: code || '(Sin almacén)',
        values: Object.fromEntries(months.map((m, i) => [m, locationsByMonth[i].get(code)?.cost || 0])),
      }))
      .filter(row => Object.values(row.values).some(v => Math.abs(v) >= 0.01))
      .sort((a, b) => a.location.localeCompare(b.location));
    const totals = Object.fromEntries(months.map((m, i) => [m, Array.from(locationsByMonth[i].values()).reduce((s, t) => s + t.cost, 0)]));

    // Variación por producto entre el cierre anterior y el final del periodo
    const itemInfo = new Map(items.map((i: any) => [i.number, { name: i.displayName, type: i.type }]));
    const itemNos = new Set([...startItems.keys(), ...endItems.keys()]);
    const changes = Array.from(itemNos).map(itemNo => {
      const start = startItems.get(itemNo) || { cost: 0, qty: 0 };
      const end = endItems.get(itemNo) || { cost: 0, qty: 0 };
      return {
        itemNo,
        description: itemInfo.get(itemNo)?.name || '',
        startValue: start.cost,
        endValue: end.cost,
        diff: end.cost - start.cost,
        startQty: start.qty,
        endQty: end.qty,
      };
    });
    const topUp = changes.filter(c => c.diff > 0.01).sort((a, b) => b.diff - a.diff).slice(0, 10);
    const topDown = changes.filter(c => c.diff < -0.01).sort((a, b) => a.diff - b.diff).slice(0, 10);

    // Coste medio (valor / cantidad) de productos de tipo Inventario
    const avgCostItems = changes
      .filter(c => itemInfo.get(c.itemNo)?.type === 'Inventory' && c.startQty > 0 && c.endQty > 0)
      .map(c => {
        const startUnitCost = c.startValue / c.startQty;
        const endUnitCost = c.endValue / c.endQty;
        return {
          itemNo: c.itemNo,
          description: c.description,
          startUnitCost,
          endUnitCost,
          variationPct: startUnitCost !== 0 ? ((endUnitCost - startUnitCost) / Math.abs(startUnitCost)) * 100 : 0,
          endQty: c.endQty,
        };
      })
      .filter(i => Math.abs(i.endUnitCost - i.startUnitCost) >= 0.0001);

    return NextResponse.json({
      method,
      startMonth,
      endMonth: months[months.length - 1],
      byLocation,
      totals,
      topUp,
      topDown,
      avgCost: {
        increased: avgCostItems.filter(i => i.variationPct > 0).length,
        decreased: avgCostItems.filter(i => i.variationPct < 0).length,
        items: avgCostItems.sort((a, b) => Math.abs(b.variationPct) - Math.abs(a.variationPct)).slice(0, 25),
      },
    });
  } catch (error: any) {
    console.error('Error in reporting inventory:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
