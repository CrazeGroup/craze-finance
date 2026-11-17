import { NextResponse } from 'next/server';
import { entraConfig, getSession } from '@/lib/auth';
import { GRAPH_MAIL_SCOPE } from '@/lib/graphMail';

// Inicio de sesión con Microsoft: redirige a Entra ID (OIDC, flujo authorization code) con state y nonce en una cookie.
// ?purpose=mail&back=/ruta: conectar el correo del usuario ya conectado (permiso delegado Mail.Send) para enviar
// los recordatorios desde su buzón; misma redirect URI, el propósito va en la cookie.
export async function GET(req: Request) {
  const cfg = entraConfig();
  const origin = new URL(req.url).origin;
  if (!cfg) return NextResponse.redirect(new URL('/login?error=sso_config', origin));

  const params = new URL(req.url).searchParams;
  const mail = params.get('purpose') === 'mail';
  const back = (params.get('back') || '/recobros').startsWith('/') ? (params.get('back') || '/recobros') : '/recobros';
  const session = mail ? await getSession() : null;
  if (mail && !session?.username) return NextResponse.redirect(new URL('/login', origin));
  const state = crypto.randomUUID(), nonce = crypto.randomUUID();
  const url = new URL(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: `${origin}/api/auth/microsoft/callback`,
    response_mode: 'query',
    scope: mail ? GRAPH_MAIL_SCOPE : 'openid profile email',
    state,
    nonce,
    ...(mail ? { login_hint: session!.username } : { prompt: 'select_account' }),
  }).toString();

  const response = NextResponse.redirect(url);
  response.cookies.set({
    name: 'sso-state', value: mail ? `${state}.${nonce}.mail.${encodeURIComponent(back)}` : `${state}.${nonce}`, httpOnly: true, path: '/api/auth/microsoft',
    secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 600,
  });
  return response;
}
