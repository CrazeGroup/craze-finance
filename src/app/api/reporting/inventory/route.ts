import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getUpload, parseMonths, shiftMonth } from '@/lib/reporting';
import { ADJUSTMENT_LABEL, compareInventory, InventoryUpload, valueByLocation } from '@/lib/reportingExcel';

export const dynamic = 'force-dynamic';

// Temporalmente, el inventario sale de los Excels "Inventory Value" de BC subidos por mes
// (en lugar de la API de Value Entries).

export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (companyId === 'ALL') {
      return NextResponse.json({ error: 'Selecciona una empresa concreta para ver el inventario.' }, { status: 400 });
    }
    const months = parseMonths(new URL(req.url).searchParams.get('months'));
    if (months.length === 0) return NextResponse.json({ error: 'Selecciona al menos un mes.' }, { status: 400 });

    // Comparativa: cierre del mes anterior al periodo vs cierre del último mes seleccionado
    const startMonth = shiftMonth(months[0], -1);
    const endMonth = months[months.length - 1];
    const neededMonths = Array.from(new Set([startMonth, ...months]));
    const uploads = new Map<string, InventoryUpload | null>(
      await Promise.all(neededMonths.map(async m => [m, await getUpload<InventoryUpload>('inventory', companyId, m)] as const))
    );

    // Valor por almacén de cada mes seleccionado (null si falta el Excel del mes)
    const valuesByMonth = new Map(months.map(m => {
      const upload = uploads.get(m);
      return [m, upload ? valueByLocation(upload) : null] as const;
    }));
    const locationNames = new Set<string>();
    valuesByMonth.forEach(v => v && Object.keys(v).forEach(l => locationNames.add(l)));
    const byLocation = Array.from(locationNames)
      .map(location => ({
        location,
        values: Object.fromEntries(months.map(m => [m, valuesByMonth.get(m) ? (valuesByMonth.get(m)![location] || 0) : null])),
      }))
      .filter(row => Object.values(row.values).some(v => v !== null && Math.abs(v) >= 0.01))
      // Almacenes de mayor a menor valor en el último mes; el ajuste al final
      .sort((a, b) => (a.location === ADJUSTMENT_LABEL ? 1 : b.location === ADJUSTMENT_LABEL ? -1 : (b.values[endMonth] || 0) - (a.values[endMonth] || 0)));
    const totals = Object.fromEntries(months.map(m => [m, uploads.get(m)?.total ?? null]));

    const start = uploads.get(startMonth);
    const end = uploads.get(endMonth);

    return NextResponse.json({
      source: 'excel',
      startMonth,
      endMonth,
      missingMonths: months.filter(m => !uploads.get(m)),
      byLocation,
      totals,
      comparison: start && end ? compareInventory(start, end) : null,
      comparisonMissing: [startMonth, endMonth].filter(m => !uploads.get(m)),
    });
  } catch (error: any) {
    console.error('Error in reporting inventory:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
