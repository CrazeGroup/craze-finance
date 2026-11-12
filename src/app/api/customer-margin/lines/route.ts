import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => Number(v) || 0;

// Customer Margin: líneas de una factura / abono (mismas filas de Documents LM Components que el informe, sin Main Item):
// /api/customer-margin/lines?doc=CRZ-SI26-03459 → { lines: [{ no, description, qty, unitPrice, discount, amount, unitCost, cost, main }] }
export async function GET(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const doc = new URL(req.url).searchParams.get('doc') || '';
    if (!doc) return NextResponse.json({ error: 'Falta el documento' }, { status: 400 });
    const lines = await cached(`customerMargin:lines:${company}:${doc}`, 24 * HOUR, async () => {
      const ctx = await getBcContext(company);
      const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Documents_LM_Components_Excel`, {
        $filter: `Document_No eq '${doc.replace(/'/g, "''")}'`,
        $select: 'Document_Line_No,Line_No,Type,No,Description,Quantity,Unit_Price,Line_Discount_Percent,Line_Amount_LCY,Total_Product_Cost,Main_Item_CRZ,Component',
      }), ctx.token);
      return rows.filter((r: any) => r.Main_Item_CRZ !== true && (n(r.Quantity) || n(r.Line_Amount_LCY) || n(r.Total_Product_Cost)))
        .sort((a: any, b: any) => n(a.Document_Line_No) - n(b.Document_Line_No) || n(a.Line_No) - n(b.Line_No))
        .map((r: any) => {
          const qty = n(r.Quantity), amount = n(r.Line_Amount_LCY), cost = n(r.Total_Product_Cost);
          return {
            no: s(r.No), description: s(r.Description), type: s(r.Type).replace(/_x0020_/g, ' '), component: r.Component === true,
            qty, unitPrice: qty ? amount / qty : 0, listPrice: n(r.Unit_Price), discount: n(r.Line_Discount_Percent), amount, unitCost: qty ? cost / qty : 0, cost,
          };
        });
    });
    return NextResponse.json({ lines });
  } catch (error: any) {
    console.error('Customer Margin lines:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
