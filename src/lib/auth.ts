import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

// Login is off unless AUTH_ENABLED=true. When off, the app is public and everyone gets admin permissions.
export const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
export const PUBLIC_SESSION = { id: '0', username: '', permissions: '["admin"]' };

const secretKey = process.env.JWT_SECRET || 'craze-super-secret-key-2026';
const key = new TextEncoder().encode(secretKey);

export async function encrypt(payload: any) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(key);
}

export async function decrypt(input: string): Promise<any> {
  const { payload } = await jwtVerify(input, key, {
    algorithms: ['HS256'],
  });
  return payload;
}

// Cookie de sesión (24 h) para un usuario de la tabla User; la usan el login con contraseña y el de Microsoft
export async function setSessionCookie(response: { cookies: { set: (c: any) => void } }, user: { id: number; username: string; permissions: string }) {
  const token = await encrypt({ id: user.id, username: user.username, permissions: user.permissions });
  response.cookies.set({
    name: 'auth-token',
    value: token,
    httpOnly: true,
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24,
  });
}

// Inicio de sesión con Microsoft (Entra ID), activo cuando están las tres variables del registro de la app en Azure
export const entraConfig = () => {
  const tenantId = process.env.AZURE_AD_TENANT_ID, clientId = process.env.AZURE_AD_CLIENT_ID, clientSecret = process.env.AZURE_AD_CLIENT_SECRET;
  return tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : null;
};

export async function getSession() {
  if (!AUTH_ENABLED) return PUBLIC_SESSION;
  const cookieStore = await cookies();
  const session = cookieStore.get('auth-token')?.value;
  if (!session) return null;
  try {
    const payload = await decrypt(session);
    return payload;
  } catch (error) {
    return null;
  }
}

