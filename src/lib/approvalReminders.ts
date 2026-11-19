import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR, readSetting, writeSetting } from '@/lib/reporting/cache';
import { sendAsMailbox, SHARED_MAILBOX } from '@/lib/graphMail';
import type { Lang } from '@/i18n/translate';
import { translate } from '@/i18n/translate';

// Recordatorios a los aprobadores de facturas de proveedor pendientes (Payment Proposal › Pending Approval).
// Los Pending Users son usuarios de BC (ANNA.SANFELIU…): su correo sale de Approval User Setup (v2 approvalUserSetups)
// o, si no lo tiene, de la ficha de usuario (OData UserCard: Authentication / Contact Email). Se envían desde el buzón
// común (invoice@, como los recordatorios a clientes). Último envío por usuario en el ajuste
// payment:approval-reminders:<company>.

export type Approver = { user: string; name: string; email: string };
export type ReminderDoc = { vendorName: string; vendorNo: string; docType: string; docNo: string; extDocNo: string; postingDate: string; dueDate: string; remaining: number; currency: string; approvalPct: number };
export type ReminderLog = Record<string, { at: string; by: string; docs: number }>;

const s = (v: any) => (v == null ? '' : String(v).trim());
const logKey = (company: string) => `payment:approval-reminders:${company}`;

export async function approvers(ctx: BcContext, company: string): Promise<Record<string, Approver>> {
  return cached(`approvers:emails:${company}`, 6 * HOUR, async () => {
    const [setups, users] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.apiBase}/approvalUserSetups`, { $select: 'userId,userFullName,email' }), ctx.token).catch(() => [] as any[]),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/UserCard`, { $select: 'User_Name,Full_Name,Contact_Email,Authentication_Email' }), ctx.token).catch(() => [] as any[]),
    ]);
    const out: Record<string, Approver> = {};
    for (const u of users) {
      const user = s(u.User_Name).toUpperCase();
      if (user) out[user] = { user, name: s(u.Full_Name) || user, email: s(u.Authentication_Email) || s(u.Contact_Email) };
    }
    for (const a of setups) {
      const user = s(a.userId).toUpperCase();
      if (!user) continue;
      out[user] = { user, name: s(a.userFullName) || out[user]?.name || user, email: s(a.email) || out[user]?.email || '' };
    }
    return out;
  }, false, { refreshAfterMs: 6 * HOUR });
}

export const reminderLog = (company: string) => readSetting<ReminderLog>(logKey(company), {});

const esc = (v: string) => v.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtDate = (d: string, lang: Lang) => { if (!d) return ''; const [y, m, dd] = d.split('-'); return lang === 'es' ? `${dd}/${m}/${y}` : `${dd}/${m}/${y}`; };
const fmtAmount = (v: number, lang: Lang) => Math.abs(v).toLocaleString(lang === 'es' ? 'es-ES' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Un correo por aprobador con sus documentos (tabla por proveedor) y una nota opcional
export async function sendApprovalReminder(company: string, companyName: string, approver: Approver, docs: ReminderDoc[], note: string, lang: Lang, by: string) {
  const t = (en: string, vars?: Record<string, string | number>) => translate(lang, en, vars);
  if (!approver.email) throw new Error(t('{user} has no e-mail in Business Central (Approval User Setup / User Card).', { user: approver.user }));
  const total = new Map<string, number>();
  for (const d of docs) total.set(d.currency, (total.get(d.currency) || 0) + Math.abs(d.remaining));
  const rows = [...docs].sort((a, b) => a.vendorName.localeCompare(b.vendorName) || a.dueDate.localeCompare(b.dueDate)).map(d => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(d.vendorName)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(d.docType === 'Credit Memo' ? t('Credit memo') : t('Invoice'))} ${esc(d.docNo)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(d.extDocNo)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">${fmtDate(d.dueDate, lang)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${fmtAmount(d.remaining, lang)} ${esc(d.currency)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${d.approvalPct}%</td>
    </tr>`).join('');
  const th = (x: string, right = false) => `<th style="padding:4px 8px;border-bottom:2px solid #333;text-align:${right ? 'right' : 'left'}">${esc(x)}</th>`;
  const html = `<div style="font-family:Arial,sans-serif;color:#333;max-width:900px">
    <p>${esc(t('Hello {name},', { name: approver.name.split(' ')[0] || approver.name }))}</p>
    <p>${esc(t('The following vendor invoices of {company} are still pending your approval in Business Central. Please review and approve them so they can be included in the next payment run.', { company: companyName }))}</p>
    ${note.trim() ? `<p style="background:#f6f6f6;padding:8px 12px;border-left:3px solid #999">${esc(note.trim()).replace(/\n/g, '<br/>')}</p>` : ''}
    <table style="border-collapse:collapse;font-size:13px">
      <tr>${th(t('Vendor'))}${th(t('Document'))}${th(t('Vendor invoice no.'))}${th(t('Due date'))}${th(t('Amount'), true)}${th(t('% approved'), true)}</tr>
      ${rows}
    </table>
    <p><b>${esc(t('Total: {total}', { total: Array.from(total.entries()).map(([c, v]) => `${fmtAmount(v, lang)} ${c}`).join(' + ') }))}</b> · ${esc(t('{n} documents', { n: docs.length }))}</p>
    <p>${esc(t('Thank you,'))}<br/>${esc(t('Accounting'))}</p>
  </div>`;
  const subject = t('Pending invoice approvals – {company} ({n})', { company: companyName, n: docs.length });
  await sendAsMailbox({ to: approver.email, subject, html, attachments: [] });
  const log = await reminderLog(company);
  log[approver.user] = { at: new Date().toISOString(), by, docs: docs.length };
  await writeSetting(logKey(company), log);
  return { user: approver.user, email: approver.email, from: SHARED_MAILBOX };
}
