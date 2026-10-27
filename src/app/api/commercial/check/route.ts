import { NextResponse } from 'next/server';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Diagnóstico: Sell-in de CRAZE GmbH en un año según la app (pendiente de servir por Shipment Date) y según el
// Power BI (Line_Amount entero por Requested Delivery Date; devoluciones por la fecha de registro de la devolución)
const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const d10 = (v: any) => { const x = s(v).substring(0, 10); return x && x !== '0001-01-01' ? x : ''; };

export async function GET(req: Request) {
  const year = Number(new URL(req.url).searchParams.get('year') || new Date().getFullYear());
  try {

  const ctx = await getBcContext('CRAZE');
  const [items, lm, lines, custs, rets] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.customApiBase}/items`, { $select: 'no,line,businessUnit' }), ctx.token, 55000),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/documentsLMComponents`, {
      $filter: `postingDate ge ${year}-01-01 and postingDate le ${year}-12-31`,
      $select: 'postingDate,no,lineAmountEUR,component,mainItemCRZ,customerGroupCode,productLineCode',
    }), ctx.token, 55000),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Sales_Lines_Excel`, {
      $filter: `Document_Type ne 'Invoice'`,
      $select: 'Document_Type,Document_No,Type,Sell_to_Customer_No,No,Location_Code,Quantity,Outstanding_Quantity,Line_Amount,Shipment_Date,AIT_Requested_Delivery_Date,AITRequested_Delivery_Date',
    }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Customer_Card_Excel`, { $select: 'No,Customer_Group_Code_CRZ' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Sales_Return_Order_Excel`, { $select: 'No,Posting_Date' }), ctx.token).catch(() => []),
  ]);
  const itemOk = new Map(items.map((i: any) => [s(i.no), !!s(i.line) && s(i.businessUnit) !== 'PUBLISHING']));
  const grp = new Map(custs.map((c: any) => [s(c.No), s(c.Customer_Group_Code_CRZ)]));
  const retDate = new Map(rets.map((r: any) => [s(r.No), d10(r.Posting_Date)]));

  // Facturado (LM): componentes fuera, grupo 223 fuera, con línea de producto
  let invAll = 0, invItemOk = 0, invMain = 0;
  for (const l of lm) {
    if (l.component || !s(l.productLineCode) || s(l.customerGroupCode) === '223') continue;
    invAll += n(l.lineAmountEUR);
    if (itemOk.get(s(l.no))) invItemOk += n(l.lineAmountEUR);
    if (l.mainItemCRZ) invMain += n(l.lineAmountEUR);
  }
  // Pedidos abiertos
  const byType: Record<string, { pbi: number; app: number }> = {};
  let pbi = 0, app = 0, pbiOutstandingRdd = 0;
  for (const l of lines) {
    const type = s(l.Document_Type), cust = s(l.Sell_to_Customer_No), no = s(l.No);
    if (!cust || !itemOk.get(no) || grp.get(cust) === '223') continue;
    const rdd = d10(l.AIT_Requested_Delivery_Date) || d10(l.AITRequested_Delivery_Date);
    const pbiDate = type === 'Return Order' ? retDate.get(s(l.Document_No)) || '' : rdd;
    const t = (byType[type] ||= { pbi: 0, app: 0 });
    if (s(l.Location_Code) !== 'ASIA' && pbiDate.startsWith(String(year))) { pbi += n(l.Line_Amount); t.pbi += n(l.Line_Amount); }
    const qty = n(l.Quantity), out = n(l.Outstanding_Quantity);
    if (s(l.Type) === 'Item' && qty && out) {
      const sign = /return|credit/i.test(type) ? -1 : 1;
      const share = sign * n(l.Line_Amount) * (out / qty);
      if (d10(l.Shipment_Date).startsWith(String(year))) { app += share; t.app += share; }
      if (s(l.Location_Code) !== 'ASIA' && pbiDate.startsWith(String(year))) pbiOutstandingRdd += share;
    }
  }
  const f = (v: number) => Math.round(v * 100) / 100;
    return NextResponse.json({
      year, invAll: f(invAll), invItemOk: f(invItemOk), invMain: f(invMain), soPbi: f(pbi), soApp: f(app), soOutstandingByRdd: f(pbiOutstandingRdd),
      byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { pbi: f(v.pbi), app: f(v.app) }])),
      sellInPbi: f(invAll + pbi), sellInApp: f(invItemOk + app),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
