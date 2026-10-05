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

