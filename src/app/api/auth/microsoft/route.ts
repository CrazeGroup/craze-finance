import { NextResponse } from 'next/server';
import { entraConfig } from '@/lib/auth';

// Inicio de sesión con Microsoft: redirige a Entra ID (OIDC, flujo authorization code) con state y nonce en una cookie
export async function GET(req: Request) {
  const cfg = entraConfig();
  const origin = new URL(req.url).origin;
  if (!cfg) return NextResponse.redirect(new URL('/login?error=sso_config', origin));

  const state = crypto.randomUUID(), nonce = crypto.randomUUID();
  const url = new URL(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: `${origin}/api/auth/microsoft/callback`,
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    prompt: 'select_account',
  }).toString();

  const response = NextResponse.redirect(url);
  response.cookies.set({
    name: 'sso-state', value: `${state}.${nonce}`, httpOnly: true, path: '/api/auth/microsoft',
    secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 600,
  });
  return response;
}
