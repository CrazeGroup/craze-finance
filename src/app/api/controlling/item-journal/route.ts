import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { bcRequest } from '@/lib/bcWrite';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Item Journal (Diario de productos) de BC por OData (Item_Journals_Excel). Solo crea líneas: nunca registra.
// GET ?template=ITEM&batch=DEFAULT → líneas del lote. POST { template, batch, lines: [{ Entry_Type, Item_No, … }] }
const q = (s: string) => s.replace(/'/g, "''");

async function ctxFor() {
  const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
  if (company === 'ALL') throw new Error('Selecciona una empresa concreta.');
  return getBcContext(company);
}

async function lines(ctx: Awaited<ReturnType<typeof getBcContext>>, template: string, batch: string) {
  return bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Item_Journals_Excel`, {
    $filter: `Journal_Template_Name eq '${q(template)}' and Journal_Batch_Name eq '${q(batch)}'`,
  }), ctx.token);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const ctx = await ctxFor();
    return NextResponse.json({ lines: await lines(ctx, searchParams.get('template') || 'ITEM', searchParams.get('batch') || 'DEFAULT') });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { template = 'ITEM', batch = 'DEFAULT', lines: input } = await req.json();
    if (!Array.isArray(input) || !input.length) return NextResponse.json({ error: 'Sin líneas.' }, { status: 400 });
    const ctx = await ctxFor();
    const existing = await lines(ctx, template, batch);
    let lineNo = existing.reduce((m: number, l: any) => Math.max(m, Number(l.Line_No) || 0), 0);
    const created = [];
    for (const l of input) {
      lineNo += 10000;
      created.push(await bcRequest('POST', `${ctx.odataCompanyBase}/Item_Journals_Excel`, ctx.token, {
        Journal_Template_Name: template, Journal_Batch_Name: batch, Line_No: lineNo, ...l,
      }));
    }
    return NextResponse.json({ created });
  } catch (error: any) {
    console.error('Item journal:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
