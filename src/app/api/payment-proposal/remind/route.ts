import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { approvers, sendApprovalReminder, type ReminderDoc } from '@/lib/approvalReminders';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';
import { serverLang } from '@/lib/i18nServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Envía un recordatorio por aprobador: body { reminders: [{ user, docs: ReminderDoc[] }], note? }. Devuelve el
// resultado de cada uno (enviado o error) sin cortar los demás.
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Select a specific company.' }, { status: 400 });
    const body = await req.json();
    const reminders: { user: string; docs: ReminderDoc[] }[] = Array.isArray(body.reminders) ? body.reminders.filter((r: any) => r?.user && Array.isArray(r.docs) && r.docs.length) : [];
    if (!reminders.length) return NextResponse.json({ error: 'No approver or document selected.' }, { status: 400 });
    if (reminders.length > 30) return NextResponse.json({ error: 'At most 30 approvers at a time.' }, { status: 400 });
    const ctx = await getBcContext(company);
    const list = await approvers(ctx, company);
    const lang = await serverLang();
    const by = (await getSession())?.username as string || '';
    const results: { user: string; ok: boolean; email?: string; error?: string }[] = [];
    for (const r of reminders) {
      const user = String(r.user).toUpperCase();
      const approver = list[user] || { user, name: user, email: '' };
      try {
        const sent = await sendApprovalReminder(company, ctx.companyName, approver, r.docs.slice(0, 300), String(body.note || ''), lang, by);
        results.push({ user, ok: true, email: sent.email });
        await logAction('Payment Proposal: approval reminder sent', `${user} <${sent.email}> · ${r.docs.length} documents (${r.docs.map(d => d.docNo).join(', ')})`);
      } catch (e: any) {
        results.push({ user, ok: false, error: e.message });
      }
    }
    return NextResponse.json({ results });
  } catch (error: any) {
    console.error('Approval reminders:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
