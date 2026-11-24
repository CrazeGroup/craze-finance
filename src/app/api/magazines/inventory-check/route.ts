import { NextResponse } from 'next/server';
import { getBcContext } from '@/lib/bcClient';
import { DFORCE_COMPANY } from '@/lib/dforce';
import { costingMethods, inventoryCheck, openEntries } from '@/lib/inventoryCheck';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// GET ?date=YYYY-MM-DD[&company=][&items=a,b][&all=1]: valor de inventario por artículo (Value Entries) frente a
// cantidad × Unit Cost. Por defecto solo los artículos con diferencia ≥ 1 €, con método de coste y movimientos abiertos.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get('date') || new Date().toISOString().substring(0, 10);
    const company = searchParams.get('company') || DFORCE_COMPANY;
    const only = (searchParams.get('items') || '').split(',').map(s => s.trim()).filter(Boolean);
    const ctx = await getBcContext(company);
    let items = await inventoryCheck(ctx, date, only);
    const total = { value: 0, target: 0 };
    for (const i of items) { total.value += i.value; total.target += i.target; }
    if (searchParams.get('all') !== '1') items = items.filter(i => Math.abs(i.diff) >= 1);
    items.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    const nos = items.map(i => i.no);
    const [methods, open] = await Promise.all([costingMethods(ctx, nos), openEntries(ctx, nos)]);
    for (const i of items) {
      i.costing = methods[i.no];
      i.open = open.filter((e: any) => e.Item_No === i.no)
        .map((e: any) => ({ entryNo: e.Entry_No, location: e.Location_Code, remaining: e.Remaining_Quantity, date: e.Posting_Date, type: e.Entry_Type }));
    }
    return NextResponse.json({ company, date, total: { value: Math.round(total.value * 100) / 100, target: Math.round(total.target * 100) / 100 }, items });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
