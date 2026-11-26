import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext, bcFetchAll } from '@/lib/bcClient';
import { bcRequest } from '@/lib/bcWrite';
import { journalByCode } from '@/lib/banco';
import { logAction } from '@/lib/logger';
import { getSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Line = { date: string; documentNo: string; accountNo: string; balAccountNo: string; amount: number; description: string };
const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const r2 = (n: number) => Math.round(n * 100) / 100;

// Reclasificaciones cuenta contable → cuenta contable: añade líneas SIN registrar al lote del diario general.
// { journalCode, lines: [{ date, documentNo, accountNo, balAccountNo, amount, description }], force? }
// Rechaza (409) si el lote ya tiene líneas con el mismo nº de documento y fecha, salvo force.
export async function POST(req: Request) {
  try {
    const session: any = await getSession();
    const perms: string[] = session?.permissions ? JSON.parse(session.permissions) : [];
    if (!perms.includes('admin') && !perms.includes('banco')) return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
    const companyId = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (companyId === 'ALL') return NextResponse.json({ error: 'Select a specific company.' }, { status: 400 });
    const body = await req.json() as { journalCode: string; lines: Line[]; force?: boolean };
    if (!body.journalCode) return NextResponse.json({ error: 'Choose the batch.' }, { status: 400 });
    if (!Array.isArray(body.lines) || !body.lines.length) return NextResponse.json({ error: 'There are no lines to send.' }, { status: 400 });
    const bad = body.lines.find(l => !isDate(l.date || '') || !String(l.documentNo || '').trim() || !String(l.accountNo || '').trim()
      || !String(l.balAccountNo || '').trim() || !Number.isFinite(l.amount) || !l.amount);
    if (bad) return NextResponse.json({ error: `Incomplete line: ${JSON.stringify(bad)}` }, { status: 400 });

    const ctx = await getBcContext(companyId);
    const journal = await journalByCode(ctx, body.journalCode);
    const base = `${ctx.apiBase}/journals(${journal.id})/journalLines`;
    if (!body.force) {
      const existing = await bcFetchAll(`${base}?$select=documentNumber,postingDate`, ctx.token);
      const ours = new Set(body.lines.map(l => `${l.documentNo}|${l.date}`));
      const dup = Array.from(new Set(existing.filter((r: any) => ours.has(`${r.documentNumber}|${r.postingDate}`)).map((r: any) => String(r.documentNumber))));
      if (dup.length) return NextResponse.json({ error: `The batch already has lines for: ${dup.join(', ')}`, duplicates: dup }, { status: 409 });
    }
    const created: string[] = [];
    try {
      for (const l of body.lines) {
        const r = await bcRequest('POST', base, ctx.token, {
          accountType: 'G/L Account', accountNumber: l.accountNo, postingDate: l.date, documentNumber: l.documentNo.trim(),
          amount: r2(l.amount), description: String(l.description || '').substring(0, 100),
          balanceAccountType: 'G/L Account', balancingAccountNumber: l.balAccountNo,
        });
        created.push(r.id);
      }
    } catch (e) {
      // No dejar el envío a medias
      for (const id of created) await bcRequest('DELETE', `${base}(${id})`, ctx.token).catch(() => {});
      throw e;
    }
    const total = r2(body.lines.reduce((s, l) => s + l.amount, 0));
    await logAction('G/L journal: reclassification lines sent', `${journal.code} · lines: ${created.length} · total ${total}`, companyId);
    return NextResponse.json({ batch: journal.code, lines: created.length, total });
  } catch (error: any) {
    console.error('G/L journal:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
