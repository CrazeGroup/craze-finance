// Lectura de los Excels exportados de BC que alimentan el Reporting (temporalmente, en vez de la API).
// Código puro: se usa en el navegador al subir el fichero y en el servidor al calcular.

export type InventoryItem = {
  no: string;
  desc: string;
  type: string;
  qty: number;
  value: number;
  loc: Record<string, number>;   // Cantidad por almacén (solo almacenes con cantidad)
};

export type InventoryUpload = {
  month: string;      // "YYYY-MM" del To Date Filter
  toDate: string;     // "YYYY-MM-DD"
  total: number;      // Suma de Inventory Value
  locations: string[];
  items: InventoryItem[];
};

// Fecha de Excel (número de serie o texto) a "YYYY-MM-DD"
export function excelDate(value: any): string | null {
  if (typeof value === 'number') {
    return new Date(Math.round((value - 25569) * 864e5)).toISOString().substring(0, 10);
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  }
  return null;
}

const num = (v: any) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')) || 0);

// Informe "Inventory Value" de BC: una fila por producto con cantidad, valor y una columna de
// cantidad por almacén (las columnas que siguen a "Inventory Value").
export function parseInventoryValueSheet(rows: any[][]): InventoryUpload {
  const header = (rows[0] || []).map(h => String(h ?? '').trim());
  const col = (name: string) => header.indexOf(name);
  const iDate = col('To Date Filter');
  const iNo = col('Item No.');
  const iDesc = col('Description');
  const iType = col('Type');
  const iQty = col('Inventory');
  const iValue = col('Inventory Value');
  if ([iDate, iNo, iQty, iValue].some(i => i < 0)) {
    throw new Error('El Excel no tiene el formato del informe "Inventory Value" de BC (faltan las columnas To Date Filter, Item No., Inventory o Inventory Value).');
  }

  const locations = header.slice(iValue + 1).filter(Boolean);
  const dataRows = rows.slice(1).filter(r => r && r[iNo] !== null && r[iNo] !== undefined && r[iNo] !== '');
  if (dataRows.length === 0) throw new Error('El Excel no tiene productos.');

  const toDate = excelDate(dataRows[0][iDate]);
  if (!toDate) throw new Error('No se pudo leer la fecha (To Date Filter) del Excel.');

  const items: InventoryItem[] = [];
  let total = 0;
  for (const r of dataRows) {
    const qty = num(r[iQty]);
    const value = num(r[iValue]);
    total += value;
    if (qty === 0 && value === 0) continue;
    const loc: Record<string, number> = {};
    locations.forEach((name, i) => {
      const q = num(r[iValue + 1 + i]);
      if (q !== 0) loc[name] = q;
    });
    items.push({ no: String(r[iNo]).trim(), desc: String(r[iDesc] ?? '').trim(), type: String(r[iType] ?? '').trim(), qty, value, loc });
  }

  return { month: toDate.substring(0, 7), toDate, total, locations, items };
}

export const ADJUSTMENT_LABEL = '(Ajuste de valor sin stock)';

// Valor por almacén: cantidad del almacén x coste unitario del producto (valor / cantidad).
// Lo que no se puede repartir (valor sin cantidad) va a una línea de ajuste para que cuadre el total.
export function valueByLocation(upload: InventoryUpload): Record<string, number> {
  const values: Record<string, number> = {};
  let allocated = 0;
  for (const item of upload.items) {
    if (item.qty === 0) continue;
    const unitCost = item.value / item.qty;
    for (const [loc, qty] of Object.entries(item.loc)) {
      values[loc] = (values[loc] || 0) + qty * unitCost;
      allocated += qty * unitCost;
    }
  }
  const adjustment = upload.total - allocated;
  if (Math.abs(adjustment) >= 0.5) values[ADJUSTMENT_LABEL] = adjustment;
  return values;
}

// Variación por producto y coste medio entre dos cierres
export function compareInventory(start: InventoryUpload, end: InventoryUpload) {
  const startItems = new Map(start.items.map(i => [i.no, i]));
  const endItems = new Map(end.items.map(i => [i.no, i]));
  const itemNos = new Set([...startItems.keys(), ...endItems.keys()]);

  const changes = Array.from(itemNos).map(no => {
    const s = startItems.get(no);
    const e = endItems.get(no);
    return {
      itemNo: no,
      description: e?.desc || s?.desc || '',
      type: e?.type || s?.type || '',
      startValue: s?.value || 0,
      endValue: e?.value || 0,
      diff: (e?.value || 0) - (s?.value || 0),
      startQty: s?.qty || 0,
      endQty: e?.qty || 0,
    };
  });

  const avgCostItems = changes
    .filter(c => c.type === 'Inventory' && c.startQty > 0 && c.endQty > 0)
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

  return {
    topUp: changes.filter(c => c.diff > 0.01).sort((a, b) => b.diff - a.diff).slice(0, 10),
    topDown: changes.filter(c => c.diff < -0.01).sort((a, b) => a.diff - b.diff).slice(0, 10),
    avgCost: {
      increased: avgCostItems.filter(i => i.variationPct > 0).length,
      decreased: avgCostItems.filter(i => i.variationPct < 0).length,
      items: avgCostItems.sort((a, b) => Math.abs(b.variationPct) - Math.abs(a.variationPct)).slice(0, 25),
    },
  };
}
