import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { approvers } from '@/lib/approvalReminders';
import { salesReturns } from '@/lib/salesReturns';
import { buildSroReminder, sendSroReminder, sroReminderLog } from '@/lib/sroReminders';
import { SHARED_MAILBOX } from '@/lib/graphMail';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/logger';
import { serverLang } from '@/lib/i18nServer';
import type { Lang } from '@/i18n/translate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Los usuarios de BC son del tenant: sus correos se leen de la empresa del menú (CRAZE con ALL)
async function users(company: string) {
  const c = company === 'ALL' ? 'CRAZE' : company;
  return approvers(await getBcContext(c), c);
}

// GET: correos de los usuarios de BC y últimos recordatorios por usuario (de la empresa, o de todas con ALL)
export async function GET() {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const list = await users(company);
    const log = await sroReminderLog(company === 'ALL' ? 'CRAZE' : company);
    return NextResponse.json({ users: list, log: log.users || {} });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST { action: 'preview' | 'send', user, sros: [{company, no}], note?, lang? }: el correo se monta en el servidor con
// las SRO releídas de BC, igual en la vista previa y en el envío.
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const body = await req.json();
    const userId = String(body.user || '').toUpperCase();
    const wanted: { company: string; no: string }[] = Array.isArray(body.sros) ? body.sros.filter((x: any) => x?.company && x?.no) : [];
    if (!userId || !wanted.length) return NextResponse.json({ error: 'No user or return order selected.' }, { status: 400 });
    if (wanted.length > 300) return NextResponse.json({ error: 'At most 300 return orders at a time.' }, { status: 400 });
    const lang: Lang = body.lang === 'es' || body.lang === 'en' ? body.lang : await serverLang();
    const companies = Array.from(new Set(wanted.map(w => String(w.company))));
    const [list, ...data] = await Promise.all([users(company), ...companies.map(c => salesReturns(c))]);
    const keys = new Set(wanted.map(w => `${w.company}|${w.no}`));
    const sros = data.flatMap(d => d.rows).filter(r => keys.has(`${r.company}|${r.no}`));
    if (sros.length < wanted.length) {
      const found = new Set(sros.map(r => `${r.company}|${r.no}`));
      const missing = wanted.filter(w => !found.has(`${w.company}|${w.no}`)).map(w => w.no);
      return NextResponse.json({ error: `These return orders are no longer open in BC: ${missing.join(', ')}` }, { status: 400 });
    }
    const user = list[userId] || { user: userId, name: userId, email: '' };
    const note = String(body.note || '');
    if (body.action === 'send') {
      const by = ((await getSession())?.username as string) || '';
      const sent = await sendSroReminder(user, sros, note, lang, by);
      await logAction('Sales Return Orders: reminder sent', `${userId} <${sent.email}> · ${sros.length} return orders (${sros.map(r => `${r.company} ${r.no}`).join(', ')})`);
      return NextResponse.json({ ok: true, ...sent, at: new Date().toISOString() });
    }
    const { subject, html } = buildSroReminder(user, sros, note, lang);
    return NextResponse.json({ to: user.email, name: user.name, from: SHARED_MAILBOX, subject, html });
  } catch (e: any) {
    console.error('SRO reminders:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
