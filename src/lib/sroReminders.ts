import { readSetting, writeSetting } from '@/lib/reporting/cache';
import { sendAsMailbox, SHARED_MAILBOX } from '@/lib/graphMail';
import { translate, type Lang } from '@/i18n/translate';
import type { Approver } from '@/lib/approvalReminders';
import type { SalesReturn } from '@/lib/salesReturns';

// Recordatorios a los Assigned Users de las Sales Return Orders: un correo por usuario con las SRO elegidas (de una o
// varias empresas, siempre indicadas), desde el buzón común invoice@ (como Payment Proposal). El correo del usuario de
// BC sale de approvers() (Approval User Setup / User Card). Se guarda el último envío por usuario y por SRO en el ajuste
// sro:reminders:<empresa> ({ users: { USER: {at, by, sros} }, sros: { no: {at, by, user} } }).

export type SroReminderLog = {
  users: Record<string, { at: string; by: string; sros: number }>;
  sros: Record<string, { at: string; by: string; user: string }>;
};
const logKey = (company: string) => `sro:reminders:${company}`;
export const sroReminderLog = (company: string) => readSetting<SroReminderLog>(logKey(company), { users: {}, sros: {} });

// Nombre de la empresa como se ve en la app (CRAZE = CRAZE GmbH)
export const companyDisplay = (c: string) => (c === 'CRAZE' ? 'CRAZE GmbH' : c.replace(/^craze\b/i, 'CRAZE'));

const esc = (v: string) => v.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtDate = (d: string) => { if (!d) return ''; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd}/${m}/${y}`; };
const fmtAmount = (v: number, lang: Lang) => v.toLocaleString(lang === 'es' ? 'es-ES' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lcy = (company: string) => (/group ag/i.test(company) ? 'CHF' : /^craze uk$/i.test(company) ? 'GBP' : 'EUR');

export function buildSroReminder(user: Approver, sros: SalesReturn[], note: string, lang: Lang) {
  const t = (en: string, vars?: Record<string, string | number>) => translate(lang, en, vars);
  const companies = Array.from(new Set(sros.map(r => r.company)));
  const names = companies.map(companyDisplay);
  const th = (x: string, right = false) => `<th style="padding:4px 8px;border-bottom:2px solid #333;text-align:${right ? 'right' : 'left'};white-space:nowrap">${esc(x)}</th>`;
  const td = (x: string, extra = '') => `<td style="padding:4px 8px;border-bottom:1px solid #eee;vertical-align:top;${extra}">${x}</td>`;
  // Una tabla por empresa, con su nombre como título
  const sections = companies.map(c => {
    const list = sros.filter(r => r.company === c).sort((a, b) => a.no.localeCompare(b.no));
    const totals = new Map<string, number>();
    for (const r of list) { const cur = r.currency || lcy(c); totals.set(cur, (totals.get(cur) || 0) + r.amount); }
    const rows = list.map(r => {
      const last = r.comments.at(-1);
      return `<tr>
        ${td(`<b>${esc(r.no)}</b>`, 'white-space:nowrap')}
        ${td(`${esc(r.customerName)}<br/><span style="color:#888;font-size:11px">${esc(r.customerNo)}</span>`)}
        ${td(esc(r.externalDocumentNo))}
        ${td(fmtDate(r.documentDate), 'white-space:nowrap')}
        ${td(esc(r.status))}
        ${td(esc(r.campaignNo))}
        ${td(esc(r.xmlStatus))}
        ${td(`${fmtAmount(r.amount, lang)} ${esc(r.currency || lcy(c))}`, 'text-align:right;white-space:nowrap')}
        ${td(last ? `<span style="color:#888;font-size:11px">${fmtDate(last.date)}${last.author ? ` · ${esc(last.author)}` : ''}</span><br/>${esc(last.text).replace(/\n/g, '<br/>')}` : '<span style="color:#aaa">—</span>', 'max-width:280px;font-size:12px')}
      </tr>`;
    }).join('');
    return `<h3 style="margin:18px 0 6px;font-size:15px">${esc(t('Company: {company}', { company: companyDisplay(c) }))}</h3>
      <table style="border-collapse:collapse;font-size:13px">
        <tr>${th(t('Return order'))}${th(t('Customer'))}${th(t('External Document No.'))}${th(t('Document Date'))}${th(t('Status'))}${th(t('Campaign No.'))}${th(t('XML Status'))}${th(t('Amount'), true)}${th(t('Last note'))}</tr>
        ${rows}
      </table>
      <p style="margin:6px 0 0"><b>${esc(t('Total: {total}', { total: Array.from(totals.entries()).map(([cur, v]) => `${fmtAmount(v, lang)} ${cur}`).join(' + ') }))}</b> · ${esc(t('{n} return orders', { n: list.length }))}</p>`;
  }).join('');
  const html = `<div style="font-family:Arial,sans-serif;color:#333;max-width:1000px">
    <p>${esc(t('Hello {name},', { name: user.name.split(' ')[0] || user.name }))}</p>
    <p>${esc(t('The following Sales Return Orders of {company} are assigned to you in Business Central and are still open. Please review them and update their status, or add a note with the next steps.', { company: names.join(', ') }))}</p>
    ${note.trim() ? `<p style="background:#f6f6f6;padding:8px 12px;border-left:3px solid #999">${esc(note.trim()).replace(/\n/g, '<br/>')}</p>` : ''}
    ${sections}
    <p style="margin-top:18px">${esc(t('Thank you,'))}<br/>${esc(t('Accounting'))}</p>
  </div>`;
  const subject = t('Open Sales Return Orders – {company} ({n})', { company: names.join(', '), n: sros.length });
  return { subject, html };
}

export async function sendSroReminder(user: Approver, sros: SalesReturn[], note: string, lang: Lang, by: string) {
  if (!user.email) throw new Error(translate(lang, '{user} has no e-mail in Business Central (Approval User Setup / User Card).', { user: user.user }));
  const { subject, html } = buildSroReminder(user, sros, note, lang);
  await sendAsMailbox({ to: user.email, subject, html, attachments: [] });
  const at = new Date().toISOString();
  for (const c of Array.from(new Set(sros.map(r => r.company)))) {
    const mine = sros.filter(r => r.company === c);
    const log = await sroReminderLog(c);
    log.users = log.users || {}; log.sros = log.sros || {};
    log.users[user.user] = { at, by, sros: mine.length };
    for (const r of mine) log.sros[r.no] = { at, by, user: user.user };
    await writeSetting(logKey(c), log);
  }
  return { user: user.user, email: user.email, from: SHARED_MAILBOX, subject };
}
