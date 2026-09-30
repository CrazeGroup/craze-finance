import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { encrypt } from '@/lib/auth';
import { logAction } from '@/lib/logger';
import { getMicrosoftConfig, getRedirectUri, verifyIdToken } from '@/lib/microsoftAuth';

function fail(req: Request, code: string) {
  const response = NextResponse.redirect(new URL(`/login?error=${code}`, req.url));
  response.cookies.delete({ name: 'ms-oauth', path: '/api/auth/microsoft' });
  return response;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (url.searchParams.get('error')) {
    console.warn('Microsoft SSO error:', url.searchParams.get('error_description'));
    return fail(req, 'sso_cancelled');
  }

  const cookieStore = await cookies();
  const rawOauth = cookieStore.get('ms-oauth')?.value;
  if (!code || !state || !rawOauth) {
    return fail(req, 'sso_invalid');
  }

  try {
    const oauth = JSON.parse(rawOauth) as { state: string; nonce: string; codeVerifier: string };
    if (oauth.state !== state) {
      return fail(req, 'sso_invalid');
    }

    const config = getMicrosoftConfig();

    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: getRedirectUri(req.url),
        code_verifier: oauth.codeVerifier,
      }),
    });

    if (!tokenRes.ok) {
      console.error('Microsoft token exchange failed:', await tokenRes.text());
      return fail(req, 'sso_invalid');
    }

    const tokens = await tokenRes.json();
    const claims = await verifyIdToken(tokens.id_token, oauth.nonce);

    const email = ((claims.preferred_username || claims.email || '') as string).trim();
    if (!email) {
      return fail(req, 'sso_invalid');
    }

    // Only users already created in Ajustes > Usuarios (username = Microsoft email) can log in
    const user = await prisma.user.findFirst({
      where: { username: { equals: email, mode: 'insensitive' } },
    });

    if (!user) {
      console.warn(`Microsoft SSO: usuario no registrado ${email}`);
      return fail(req, 'sso_not_registered');
    }

    const token = await encrypt({
      id: user.id,
      username: user.username,
      permissions: user.permissions,
    });

    const response = NextResponse.redirect(new URL('/', req.url));
    response.cookies.delete({ name: 'ms-oauth', path: '/api/auth/microsoft' });
    response.cookies.set({
      name: 'auth-token',
      value: token,
      httpOnly: true,
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24, // 24 hours
    });

    await logAction('Login Microsoft', `Usuario: ${user.username}`);
    return response;
  } catch (error) {
    console.error('Microsoft callback error:', error);
    return fail(req, 'sso_invalid');
  }
}
