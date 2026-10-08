import prisma from '@/lib/prisma';

// Caché del reporting en ApiConfig (clave 'reporting:cache:...'). Evita repetir consultas pesadas a BC
// (inventario: ~320.000 movimientos; BWA: ~110.000) cada vez que se abre la página.
const PREFIX = 'reporting:cache:';

export async function cached<T>(key: string, maxAgeMs: number, compute: () => Promise<T>, force = false): Promise<T> {
  // REPORTING_NO_CACHE=1: sin caché (scripts y pruebas sin base de datos)
  if (process.env.REPORTING_NO_CACHE === '1') return compute();
  const dbKey = PREFIX + key;
  if (!force) {
    const row = await prisma.apiConfig.findUnique({ where: { key: dbKey } });
    if (row?.config && Date.now() - row.updatedAt.getTime() < maxAgeMs) {
      try {
        return JSON.parse(row.config) as T;
      } catch {
        // caché corrupta: se recalcula
      }
    }
  }
  const value = await compute();
  const config = JSON.stringify(value);
  await prisma.apiConfig.upsert({ where: { key: dbKey }, update: { config }, create: { key: dbKey, url: '', config } });
  return value;
}

export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  if (process.env.REPORTING_NO_CACHE === '1') return fallback;
  const row = await prisma.apiConfig.findUnique({ where: { key: 'reporting:setting:' + key } });
  if (!row?.config) return fallback;
  try {
    return JSON.parse(row.config) as T;
  } catch {
    return fallback;
  }
}

export async function writeSetting(key: string, value: unknown) {
  const dbKey = 'reporting:setting:' + key;
  const config = JSON.stringify(value);
  await prisma.apiConfig.upsert({ where: { key: dbKey }, update: { config }, create: { key: dbKey, url: '', config } });
}

export const HOUR = 3600 * 1000;
