import { NextResponse } from 'next/server';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { bcRequest } from '@/lib/bcWrite';
import { DFORCE_COMPANY } from '@/lib/dforce';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Añade líneas de ajuste (sin registrar) al Item Journal de Craze Entertainment (OData Item_Journals_Excel, por defecto
// plantilla ITEM, lote DEFAULT), p. ej. ajustes negativos del stock duplicado en SEVEROTISK por abonos de compra que no
// sacaron las unidades. Body: { template?, batch?, lines: [{ date, documentNo, itemNo, location, quantity, appliesToEntry?,
// entryType? ('Negative Adjmt.' por defecto), unitCost? (coste unitario de un Positive Adjmt.; si no, el de la ficha),
// description? }] }. Una línea igual (documento, artículo, location, tipo, cantidad y Applies-to Entry) que ya esté en el lote
// no se vuelve a añadir.
type Line = { date: string; documentNo: string; itemNo: string; location: string; quantity: number; appliesToEntry?: number; entryType?: string; unitCost?: number; description?: string };
const TYPES = ['Negative Adjmt.', 'Positive Adjmt.'];
const q = (v: string) => v.replace(/'/g, "''");

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const template = String(body.template || 'ITEM');
    const batch = String(body.batch || 'DEFAULT');
    const lines: Line[] = Array.isArray(body.lines) ? body.lines : [];
    if (!lines.length || lines.length > 200) return NextResponse.json({ error: 'Between 1 and 200 lines.' }, { status: 400 });
    for (const l of lines) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date || '') || !l.itemNo || !l.location || !(l.quantity > 0) || !TYPES.includes(l.entryType || 'Negative Adjmt.')
        || (l.unitCost !== undefined && !(l.unitCost >= 0))) {
        return NextResponse.json({ error: `Invalid line: ${JSON.stringify(l)}` }, { status: 400 });
      }
    }
    const ctx = await getBcContext(DFORCE_COMPANY);
    const base = `${ctx.odataCompanyBase}/Item_Journals_Excel`;
    const existing = await bcFetchAll(odataUrl(base, {
      $filter: `Journal_Template_Name eq '${q(template)}' and Journal_Batch_Name eq '${q(batch)}'`,
      $select: 'Line_No,Item_No,Applies_to_Entry,Quantity,Location_Code,Entry_Type,Document_No',
    }), ctx.token);
    let lineNo = existing.reduce((m: number, x: any) => Math.max(m, Number(x.Line_No) || 0), 0);
    const keyOf = (doc: string, item: string, loc: string, type: string, qty: number, applies: number) => [doc, item, loc, type, Number(qty), applies || 0].join('|');
    const done = new Set(existing.filter((x: any) => x.Item_No).map((x: any) => keyOf(x.Document_No, x.Item_No, x.Location_Code, x.Entry_Type, x.Quantity, x.Applies_to_Entry)));
    const created: any[] = [], skipped: any[] = [];
    for (const l of lines) {
      const k = keyOf(l.documentNo, l.itemNo, l.location, l.entryType || 'Negative Adjmt.', l.quantity, l.appliesToEntry || 0);
      if (done.has(k)) { skipped.push(l); continue; }
      done.add(k);
      lineNo += 10000;
      // Primero la línea con artículo y fecha (BC rellena location, unidad y coste); después cantidad y Applies-to Entry
      const row = await bcRequest('POST', base, ctx.token, {
        Journal_Template_Name: template, Journal_Batch_Name: batch, Line_No: lineNo,
        Posting_Date: l.date, Document_Date: l.date, Entry_Type: l.entryType || 'Negative Adjmt.', Document_No: l.documentNo, Item_No: l.itemNo,
      });
      const key = `Journal_Template_Name='${encodeURIComponent(q(template))}',Journal_Batch_Name='${encodeURIComponent(q(batch))}',Line_No=${lineNo}`;
      await bcRequest('PATCH', `${base}(${key})`, ctx.token, {
        Location_Code: l.location, Quantity: l.quantity, ...(l.appliesToEntry ? { Applies_to_Entry: l.appliesToEntry } : {}),
      });
      // Coste unitario y descripción después de la cantidad (al validar la cantidad BC recalcula el importe)
      if (l.unitCost !== undefined || l.description) {
        await bcRequest('PATCH', `${base}(${key})`, ctx.token, {
          ...(l.unitCost !== undefined ? { Unit_Amount: l.unitCost } : {}), ...(l.description ? { Description: l.description.substring(0, 100) } : {}),
        });
      }
      created.push({ lineNo, ...l, description: l.description || row?.Description });
    }
    if (created.length) {
      await logAction('Item Journal: adjustment lines added', `${template}/${batch}: ${created.map(c => `${c.itemNo} ${c.location} ${c.entryType || 'Negative Adjmt.'} ${c.quantity}${c.unitCost !== undefined ? ` @ ${c.unitCost}` : ''}${c.appliesToEntry ? ` (entry ${c.appliesToEntry})` : ''}`).join('; ')}`, DFORCE_COMPANY);
    }
    return NextResponse.json({ template, batch, created, skipped });
  } catch (error: any) {
    console.error('Item journal:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
