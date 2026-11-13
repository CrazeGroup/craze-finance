import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { planRebill, restorePrices, runRebill } from '@/lib/salesRebill';
import { logAction } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Refacturación por precio de una factura de venta: POST { invoice, markup (0.10 = +10 %), dryRun }
// dryRun = solo el plan (líneas con coste y precio nuevo); si no, crea el abono corrector y la factura nueva sin registrar.
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const body = await req.json();
    const invoice = String(body?.invoice || '').trim();
    const markup = Number(body?.markup);
    if (!invoice || !Number.isFinite(markup) || markup < 0 || markup > 5) return NextResponse.json({ error: 'Parámetros no válidos' }, { status: 400 });
    const ctx = await getBcContext(company);
    // Repara un abono ya creado: precio y descuento de la factura original
    if (body.fixCreditMemo) {
      const [inv] = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, { $filter: `number eq '${invoice.replace(/'/g, "''")}'`, $select: 'id' }), ctx.token);
      const [cm] = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesCreditMemos`, { $filter: `number eq '${String(body.fixCreditMemo).replace(/'/g, "''")}'`, $select: 'id,totalAmountExcludingTax' }), ctx.token);
      if (!inv || !cm) return NextResponse.json({ error: 'No encuentro la factura o el abono' }, { status: 404 });
      await restorePrices(ctx, inv.id, cm.id);
      const [after] = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesCreditMemos`, { $filter: `number eq '${String(body.fixCreditMemo).replace(/'/g, "''")}'`, $select: 'number,totalAmountExcludingTax' }), ctx.token);
      return NextResponse.json({ fixed: after });
    }
    if (body.dryRun) return NextResponse.json(await planRebill(ctx, company, invoice, markup));
    const result = await runRebill(ctx, company, invoice, markup);
    await logAction('Refacturación por precio', `${invoice} → abono ${result.done.creditMemo || '—'} · factura ${result.done.invoice || '—'} (precio = coste +${Math.round(markup * 100)} %)`, company);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Refacturación:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
