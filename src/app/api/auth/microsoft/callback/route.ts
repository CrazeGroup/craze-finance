import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import prisma from '@/lib/prisma';
import { entraConfig, setSessionCookie, getSession } from '@/lib/auth';
import { GRAPH_MAIL_SCOPE, saveMailToken } from '@/lib/graphMail';

// Vuelta de Entra ID: canjea el code, verifica el id_token (firma, tenant, client id, nonce) y abre sesión con el
// usuario de la tabla User cuyo username es el correo de Microsoft. Un correo que no esté dado de alta no entra.
export async function GET(req: Request) {
  const { searchParams, origin } = new URL(req.url);
  const fail = (error: string, detail?: string) => {
    const url = new URL(`/login?error=${error}`, origin);
    if (detail) url.searchParams.set('detail', detail.slice(0, 300));
    const response = NextResponse.redirect(url);
    response.cookies.delete({ name: 'sso-state', path: '/api/auth/microsoft' });
    return response;
  };
  const cfg = entraConfig();
  if (!cfg) return fail('sso_config');

  const [state, nonce, purpose, backRaw] = ((await cookies()).get('sso-state')?.value || '').split('.');
  const mail = purpose === 'mail';
  const back = decodeURIComponent(backRaw || '/recobros');
  const code = searchParams.get('code');
  if (searchParams.get('error')) {
    // Conectar correo cancelado o sin permiso (p. ej. AADSTS65001 / "need admin approval"): vuelve a la página
    if (mail) {
      const target = new URL(back.startsWith('/') ? back : '/recobros', origin);
      target.searchParams.set('mail', 'error');
      target.searchParams.set('detail', String(searchParams.get('error_description') || searchParams.get('error')).split('\n')[0].slice(0, 200));
      const response = NextResponse.redirect(target);
      response.cookies.delete({ name: 'sso-state', path: '/api/auth/microsoft' });
      return response;
    }
    return fail('sso_cancelado');
  }
  if (!code || !state || searchParams.get('state') !== state) return fail('sso_state');

  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${origin}/api/auth/microsoft/callback`,
        scope: mail ? GRAPH_MAIL_SCOPE : 'openid profile email',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.id_token) throw new Error(tokens.error_description || 'Sin id_token');

    // Issuer y claves del documento OIDC del tenant (así el tenant puede ser el GUID o el dominio)
    const oidc = await (await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/v2.0/.well-known/openid-configuration`)).json();
    if (!oidc.issuer || !oidc.jwks_uri) throw new Error(`Tenant no válido: ${oidc.error_description || cfg.tenantId}`);
    const jwks = createRemoteJWKSet(new URL(oidc.jwks_uri));
    const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: oidc.issuer, audience: cfg.clientId });
    if (payload.nonce !== nonce) return fail('sso_state');

    const email = String(payload.preferred_username || payload.email || payload.upn || '').trim().toLowerCase();

    // Conectar el correo: la cuenta de Microsoft tiene que ser la del usuario de la sesión
    if (mail) {
      const session = await getSession();
      const target = new URL(back.startsWith('/') ? back : '/recobros', origin);
      if (!session?.username || session.username.toLowerCase() !== email) {
        target.searchParams.set('mail', 'otra_cuenta');
      } else if (!tokens.refresh_token) {
        target.searchParams.set('mail', 'sin_permiso');
      } else {
        await saveMailToken(session.username, tokens.refresh_token, email);
        await prisma.actionLog.create({ data: { user: session.username, action: 'Correo conectado', details: `Recordatorios desde ${email} (Microsoft Graph)` } }).catch(() => {});
        target.searchParams.set('mail', 'conectado');
      }
      const response = NextResponse.redirect(target);
      response.cookies.delete({ name: 'sso-state', path: '/api/auth/microsoft' });
      return response;
    }
    const user = email ? await prisma.user.findFirst({ where: { username: { equals: email, mode: 'insensitive' } } }) : null;
    if (!user) return fail('sso_usuario', email);

    const response = NextResponse.redirect(new URL('/', origin));
    response.cookies.delete({ name: 'sso-state', path: '/api/auth/microsoft' });
    await setSessionCookie(response, user);
    await prisma.actionLog.create({ data: { user: user.username, action: 'Inicio de sesión', details: 'Microsoft (Entra ID)' } }).catch(() => {});
    return response;
  } catch (error) {
    console.error('Error SSO Microsoft:', error);
    // El motivo (p. ej. AADSTS7000215 = client secret incorrecto) se muestra en /login
    return fail('sso_error', String((error as Error)?.message || error).split('\n')[0]);
  }
}
