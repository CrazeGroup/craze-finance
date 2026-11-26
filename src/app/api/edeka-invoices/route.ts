import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { listEdekaInvoices, buildEdekaInvoice, sendEdekaInvoice } from '@/lib/edekaInvoice';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const company = async () => {
  const c = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
  return c === 'ALL' ? 'CRAZE' : c;
};

// GET ?from=&to=            facturas a EDEKA del periodo (con su estado de envío)
// GET ?no=<factura>[&test=1] mensaje TRANSUSXML de esa factura (vista previa, nada se envía)
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const co = await company();
    const no = sp.get('no');
    if (no) return NextResponse.json(await buildEdekaInvoice(co, no, { test: sp.get('test') === '1' }));
    const today = new Date().toISOString().substring(0, 10);
    const from = sp.get('from') || `${today.substring(0, 8)}01`;
    const to = sp.get('to') || today;
    return NextResponse.json({ company: co, from, to, invoices: await listEdekaInvoices(co, from, to) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}

// POST {no, test, confirm: true}: envía el mensaje a Transus (WebConnect M10100). Sin confirm no hace nada.
export async function POST(req: Request) {
  try {
    const { no, test, confirm } = await req.json();
    if (!no || confirm !== true) return NextResponse.json({ error: 'Missing invoice or confirmation' }, { status: 400 });
    const co = await company();
    const by = (await getSession())?.username || '';
    const result = await sendEdekaInvoice(co, no, !!test, by);
    await logAction('EDEKA invoice sent to Transus', `${no}${test ? ' (test message)' : ''} · TransactionID ${result.transactionId}`);
    return NextResponse.json(result);
  } catch (e: any) {
    await logAction('EDEKA invoice NOT sent to Transus', String(e.message || e).substring(0, 500));
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}
