import { NextResponse } from 'next/server';
import { runIc } from '@/lib/icRebill';
import { logAction } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Refacturación intercompany en CRAZE Entertainment: POST { purchaseInvoice, gmbhCreditMemo, gmbhInvoice, dryRun }
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const input = { purchaseInvoice: String(b?.purchaseInvoice || ''), gmbhCreditMemo: String(b?.gmbhCreditMemo || ''), gmbhInvoice: String(b?.gmbhInvoice || '') };
    if (!input.purchaseInvoice || !input.gmbhCreditMemo || !input.gmbhInvoice) return NextResponse.json({ error: 'Parámetros no válidos' }, { status: 400 });
    const result = await runIc(input, !!b.dryRun);
    if (!b.dryRun) await logAction('Refacturación intercompany (compras)', `${input.purchaseInvoice}: abono ${result.creditMemo?.no || '—'} (${input.gmbhCreditMemo}) · factura ${result.invoice?.no || '—'} (${input.gmbhInvoice})`, 'Craze Entertainment');
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Refacturación intercompany:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
