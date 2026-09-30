import { createRemoteJWKSet, jwtVerify } from 'jose';

// Microsoft Entra ID (Azure AD) OpenID Connect config.
// Requires an app registration with redirect URI <APP_URL>/api/auth/microsoft/callback
export function getMicrosoftConfig() {
  const tenantId = process.env.AZURE_AD_TENANT_ID;
  const clientId = process.env.AZURE_AD_CLIENT_ID;
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Faltan variables de entorno de Microsoft SSO (AZURE_AD_TENANT_ID, AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET)');
  }

  const authority = `https://login.microsoftonline.com/${tenantId}`;
  return {
    tenantId,
    clientId,
    clientSecret,
    authorizeUrl: `${authority}/oauth2/v2.0/authorize`,
    tokenUrl: `${authority}/oauth2/v2.0/token`,
    issuer: `${authority}/v2.0`,
    jwksUrl: `${authority}/discovery/v2.0/keys`,
  };
}

export function getRedirectUri(requestUrl: string) {
  const origin = process.env.APP_URL || new URL(requestUrl).origin;
  return `${origin}/api/auth/microsoft/callback`;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function verifyIdToken(idToken: string, nonce: string) {
  const config = getMicrosoftConfig();
  if (!jwks) jwks = createRemoteJWKSet(new URL(config.jwksUrl));

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: config.issuer,
    audience: config.clientId,
  });

  if (payload.nonce !== nonce) {
    throw new Error('Nonce inválido');
  }

  return payload;
}
