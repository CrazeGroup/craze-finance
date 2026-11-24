import { NextResponse } from 'next/server';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
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
    // ?detail=<artículo>: todos sus movimientos de producto con el valor de sus Value Entries hasta la fecha
    const detail = searchParams.get('detail');
    if (detail) {
      const [ile, ve] = await Promise.all([
        bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Item_Ledger_Entries_Excel`, { $filter: `Item_No eq '${detail.replace(/'/g, "''")}' and Posting_Date le ${date}` }), ctx.token),
        bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/ValueEntries`, { $filter: `Item_No eq '${detail.replace(/'/g, "''")}' and Posting_Date le ${date}` }), ctx.token),
      ]);
      const val: Record<string, number> = {}, n: Record<string, number> = {};
      for (const v of ve) { val[v.Item_Ledger_Entry_No] = (val[v.Item_Ledger_Entry_No] || 0) + (Number(v.Cost_Amount_Actual) || 0) + (Number(v.Cost_Amount_Expected) || 0); n[v.Item_Ledger_Entry_No] = (n[v.Item_Ledger_Entry_No] || 0) + 1; }
      return NextResponse.json({ entries: ile.map((e: any) => ({
        entryNo: e.Entry_No, date: e.Posting_Date, type: e.Entry_Type, doc: e.Document_No, docType: e.Document_Type, location: e.Location_Code,
        qty: e.Quantity, remaining: e.Remaining_Quantity, open: e.Open, value: Math.round((val[e.Entry_No] || 0) * 100) / 100, valueEntries: n[e.Entry_No] || 0,
        appliesTo: e.Applies_to_Entry, description: e.Description,
      })) });
    }
    let items = await inventoryCheck(ctx, date, only);
    const total = { value: 0, target: 0 };
    for (const i of items) { total.value += i.value; total.target += i.target; }
    if (searchParams.get('all') !== '1') items = items.filter(i => Math.abs(i.diff) >= 1 && (searchParams.get('types') === 'all' || i.type === 'Inventory'));
    items.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    const nos = items.map(i => i.no);
    const [methods, open] = await Promise.all([costingMethods(ctx, nos), openEntries(ctx, nos)]);
    for (const i of items) {
      i.costing = methods[i.no];
      i.open = open.filter((e: any) => e.Item_No === i.no)
        .map((e: any) => {
          const value = Math.round((i.byEntry?.[e.Entry_No] || 0) * 100) / 100;
          return { entryNo: e.Entry_No, location: e.Location_Code, remaining: e.Remaining_Quantity, quantity: e.Quantity, date: e.Posting_Date, type: e.Entry_Type, value,
            remainingValue: Math.round((e.Quantity ? value * e.Remaining_Quantity / e.Quantity : 0) * 100) / 100 };
        });
      // Valor que no está en los movimientos abiertos (queda en movimientos cerrados: coste sin ajustar)
      i.residue = Math.round((i.value - i.open.reduce((t, o) => t + o.remainingValue, 0)) * 100) / 100;
      delete i.byEntry;
    }
    return NextResponse.json({ company, date, total: { value: Math.round(total.value * 100) / 100, target: Math.round(total.target * 100) / 100 }, items });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
