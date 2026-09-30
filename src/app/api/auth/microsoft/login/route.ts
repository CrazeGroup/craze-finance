import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getMicrosoftConfig, getRedirectUri } from '@/lib/microsoftAuth';

export async function GET(req: Request) {
  try {
    const config = getMicrosoftConfig();

    const state = crypto.randomBytes(16).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: getRedirectUri(req.url),
      response_mode: 'query',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

    const response = NextResponse.redirect(`${config.authorizeUrl}?${params.toString()}`);

    // Short-lived cookie to validate the callback (CSRF state, replay nonce, PKCE verifier)
    response.cookies.set({
      name: 'ms-oauth',
      value: JSON.stringify({ state, nonce, codeVerifier }),
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/auth/microsoft',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 10,
    });

    return response;
  } catch (error) {
    console.error('Microsoft login error:', error);
    return NextResponse.redirect(new URL('/login?error=sso_config', req.url));
  }
}
