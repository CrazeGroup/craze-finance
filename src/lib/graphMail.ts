import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import prisma from './prisma';
import { entraConfig } from './auth';

// Envío de correo desde el buzón de cada usuario con Microsoft Graph (permiso delegado Mail.Send). El usuario lo
// conecta una vez ("Conectar mi correo", /api/auth/microsoft?purpose=mail); el refresh token se guarda cifrado
// (AES-256-GCM con clave derivada de JWT_SECRET) en ApiConfig mail:graph:<usuario>.
export const GRAPH_MAIL_SCOPE = 'openid offline_access https://graph.microsoft.com/Mail.Send';
const keyOf = (u: string) => `mail:graph:${u.toLowerCase()}`;
const aes = () => createHash('sha256').update(`graph-mail:${process.env.JWT_SECRET || 'craze-super-secret-key-2026'}`).digest();

function seal(text: string) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', aes(), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function open(sealed: string) {
  const [iv, tag, data] = sealed.split('.').map(x => Buffer.from(x, 'base64'));
  const d = createDecipheriv('aes-256-gcm', aes(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

export async function saveMailToken(username: string, refreshToken: string, email: string) {
  const config = JSON.stringify({ token: seal(refreshToken), email, at: new Date().toISOString() });
  await prisma.apiConfig.upsert({ where: { key: keyOf(username) }, update: { config }, create: { key: keyOf(username), url: '', config } });
}
export async function mailStatus(username: string): Promise<{ connected: boolean; email?: string; at?: string }> {
  if (!username) return { connected: false };
  const row = await prisma.apiConfig.findUnique({ where: { key: keyOf(username) } });
  if (!row?.config) return { connected: false };
  const d = JSON.parse(row.config);
  return { connected: true, email: d.email, at: d.at };
}
export async function disconnectMail(username: string) {
  await prisma.apiConfig.delete({ where: { key: keyOf(username) } }).catch(() => {});
}

async function accessToken(username: string): Promise<string> {
  const cfg = entraConfig();
  const row = await prisma.apiConfig.findUnique({ where: { key: keyOf(username) } });
  if (!cfg || !row?.config) throw new Error('Correo no conectado');
  const d = JSON.parse(row.config);
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token', refresh_token: open(d.token), scope: GRAPH_MAIL_SCOPE }),
  });
  const t = await res.json();
  if (!res.ok || !t.access_token) throw new Error(`Microsoft no renovó el acceso al correo (${t.error_description?.split('\n')[0] || res.status}). Vuelve a conectar tu correo.`);
  if (t.refresh_token) await saveMailToken(username, t.refresh_token, d.email);
  return t.access_token;
}

export type GraphAttachment = { name: string; contentType: string; content: Buffer; contentId?: string };
const recipients = (s: string) => s.split(/[,;]/).map(x => x.trim()).filter(Boolean).map(address => ({ emailAddress: { address } }));

const messageOf = (mail: { to: string; cc?: string; subject: string; html: string }) => ({
  subject: mail.subject,
  body: { contentType: 'HTML', content: mail.html },
  toRecipients: recipients(mail.to),
  ...(mail.cc ? { ccRecipients: recipients(mail.cc) } : {}),
});
const attachmentOf = (a: GraphAttachment) => ({
  '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType,
  contentBytes: a.content.toString('base64'), ...(a.contentId ? { contentId: a.contentId, isInline: true } : {}),
});
const graphError = async (res: Response) => Object.assign(new Error(`Microsoft Graph: ${(await res.text()).slice(0, 300)}`), { status: res.status });

// Lanza un error con status 413 si el correo pasa del límite de Graph (~4 MB) para que se pueda usar el SMTP
export async function sendAsUser(username: string, mail: { to: string; cc?: string; subject: string; html: string; attachments: GraphAttachment[] }) {
  const token = await accessToken(username);
  const body = JSON.stringify({ message: { ...messageOf(mail), attachments: mail.attachments.map(attachmentOf) }, saveToSentItems: true });
  if (body.length > 3_900_000) throw Object.assign(new Error('Correo demasiado grande para Microsoft Graph'), { status: 413 });
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body });
  if (!res.ok) throw await graphError(res);
}

// ---- Buzón común (permiso de aplicación Mail.Send, limitado por IT a este buzón con ApplicationAccessPolicy) ----
// Los recordatorios a clientes salen siempre desde aquí, sea quien sea el usuario que los envía.
export const SHARED_MAILBOX = process.env.REMINDER_MAILBOX || 'invoice@craze-group.com';
let appTok: { token: string; exp: number; roles: string[] } | null = null;

async function appToken() {
  if (appTok && appTok.exp > Date.now() + 60_000) return appTok;
  const cfg = entraConfig();
  if (!cfg) throw new Error('Falta el registro de la app de Microsoft (AZURE_AD_*)');
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
  });
  const t = await res.json();
  if (!res.ok || !t.access_token) throw new Error(`Microsoft no dio acceso a la app (${t.error_description?.split('\n')[0] || res.status})`);
  let roles: string[] = [];
  try { roles = JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url').toString()).roles || []; } catch { /* token opaco */ }
  const tok = { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000, roles };
  // Sin Mail.Send no se guarda: en cuanto IT conceda el permiso, el siguiente intento ya lo recoge
  appTok = roles.includes('Mail.Send') ? tok : null;
  return tok;
}

// ¿Tiene la app el permiso Mail.Send de aplicación (con consentimiento de administrador)?
export async function sharedMailStatus(): Promise<{ mailbox: string; ok: boolean; error?: string }> {
  try {
    const t = await appToken();
    return t.roles.includes('Mail.Send')
      ? { mailbox: SHARED_MAILBOX, ok: true }
      : { mailbox: SHARED_MAILBOX, ok: false, error: `La app (${entraConfig()?.clientId}) no tiene el permiso de aplicación Mail.Send con consentimiento de administrador. Permisos de aplicación que tiene: ${t.roles.join(', ') || 'ninguno'}` };
  } catch (e: any) {
    return { mailbox: SHARED_MAILBOX, ok: false, error: e.message };
  }
}

// Envía desde el buzón común. Hasta ~3,9 MB en una sola llamada; si pesa más, borrador + adjuntos uno a uno + envío
// (cada adjunto < 3 MB; se guarda igualmente en Elementos enviados de invoice@).
export async function sendAsMailbox(mail: { to: string; cc?: string; subject: string; html: string; attachments: GraphAttachment[] }, mailbox = SHARED_MAILBOX) {
  const { token } = await appToken();
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}`;
  const body = JSON.stringify({ message: { ...messageOf(mail), attachments: mail.attachments.map(attachmentOf) }, saveToSentItems: true });
  if (body.length <= 3_900_000) {
    const res = await fetch(`${base}/sendMail`, { method: 'POST', headers: h, body });
    if (!res.ok) throw await graphError(res);
    return;
  }
  const draft = await fetch(`${base}/messages`, { method: 'POST', headers: h, body: JSON.stringify(messageOf(mail)) });
  if (!draft.ok) throw await graphError(draft);
  const { id } = await draft.json();
  const msg = `${base}/messages/${encodeURIComponent(id)}`;
  try {
    for (const a of mail.attachments) {
      if (a.content.length > 2_900_000) throw new Error(`El adjunto ${a.name} pesa demasiado (máx. 3 MB por fichero)`);
      const r = await fetch(`${msg}/attachments`, { method: 'POST', headers: h, body: JSON.stringify(attachmentOf(a)) });
      if (!r.ok) throw await graphError(r);
    }
    const sent = await fetch(`${msg}/send`, { method: 'POST', headers: h });
    if (!sent.ok) throw await graphError(sent);
  } catch (e) {
    await fetch(msg, { method: 'DELETE', headers: h }).catch(() => {});
    throw e;
  }
}
