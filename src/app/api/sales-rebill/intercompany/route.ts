import { NextResponse } from 'next/server';
import { attachGmbhPdf, repairIc, runIc } from '@/lib/icRebill';
import { logAction } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Refacturación intercompany en CRAZE Entertainment: POST { purchaseInvoice, gmbhCreditMemo, gmbhInvoice, dryRun }
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (b?.attachPdf) {
      const r = await attachGmbhPdf(String(b.attachPdf));
      if (!r.existing) await logAction('Intercompany re-invoicing: PDF attached', `${r.file} → ${r.purchaseInvoice}`, 'Craze Entertainment');
      return NextResponse.json(r);
    }
    const input = { purchaseInvoice: String(b?.purchaseInvoice || ''), gmbhCreditMemo: String(b?.gmbhCreditMemo || ''), gmbhInvoice: String(b?.gmbhInvoice || ''), ...(b?.invoiceProject ? { invoiceProject: String(b.invoiceProject) } : {}) };
    if (!input.purchaseInvoice || !input.gmbhCreditMemo || !input.gmbhInvoice) return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
    if (b.repair) return NextResponse.json(await repairIc(input));
    const result = await runIc(input, !!b.dryRun);
    if (!b.dryRun) await logAction('Intercompany re-invoicing (purchases)', `${input.purchaseInvoice}: credit memo ${result.creditMemo?.no || '—'} (${input.gmbhCreditMemo}) · invoice ${result.invoice?.no || '—'} (${input.gmbhInvoice})`, 'Craze Entertainment');
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Refacturación intercompany:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
