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

// Lanza un error con status 413 si el correo pasa del límite de Graph (~4 MB) para que se pueda usar el SMTP
export async function sendAsUser(username: string, mail: { to: string; cc?: string; subject: string; html: string; attachments: GraphAttachment[] }) {
  const token = await accessToken(username);
  const body = JSON.stringify({
    message: {
      subject: mail.subject,
      body: { contentType: 'HTML', content: mail.html },
      toRecipients: recipients(mail.to),
      ...(mail.cc ? { ccRecipients: recipients(mail.cc) } : {}),
      attachments: mail.attachments.map(a => ({
        '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType,
        contentBytes: a.content.toString('base64'), ...(a.contentId ? { contentId: a.contentId, isInline: true } : {}),
      })),
    },
    saveToSentItems: true,
  });
  if (body.length > 3_900_000) throw Object.assign(new Error('Correo demasiado grande para Microsoft Graph'), { status: 413 });
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body });
  if (!res.ok) throw Object.assign(new Error(`Microsoft Graph: ${(await res.text()).slice(0, 300)}`), { status: res.status });
}
