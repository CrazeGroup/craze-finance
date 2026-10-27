import { after } from 'next/server';
import prisma from '@/lib/prisma';

// Caché de Reporting y Controlling en ApiConfig (clave 'reporting:cache:...'). Evita repetir consultas pesadas a BC
// (inventario: ~320.000 movimientos; BWA: ~110.000) cada vez que se abre la página.
// Funciona como "stale-while-revalidate": siempre se devuelven al momento los últimos datos guardados y, si tienen
// más de una hora (o más de maxAgeMs si es menor), se recalculan en segundo plano con after() para la siguiente
// visita. Solo se espera al cálculo si no hay nada guardado o con force (botón de actualizar).
const PREFIX = 'reporting:cache:';
const LOCK_PREFIX = 'reporting:refreshing:';
const REFRESH_EVERY = 3600 * 1000;
const LOCK_MS = 2 * 60 * 1000;
const refreshing = new Set<string>();

async function computeAndStore<T>(dbKey: string, compute: () => Promise<T>): Promise<T> {
  const value = await compute();
  const config = JSON.stringify(value);
  await prisma.apiConfig.upsert({ where: { key: dbKey }, update: { config }, create: { key: dbKey, url: '', config } });
  return value;
}

// Recalcula en segundo plano una sola vez a la vez (en esta instancia y, con una marca en la BD, entre instancias)
async function refreshInBackground<T>(dbKey: string, compute: () => Promise<T>) {
  if (refreshing.has(dbKey)) return;
  refreshing.add(dbKey);
  try {
    const lockKey = LOCK_PREFIX + dbKey;
    const lock = await prisma.apiConfig.findUnique({ where: { key: lockKey } });
    if (lock && Date.now() - lock.updatedAt.getTime() < LOCK_MS) return;
    await prisma.apiConfig.upsert({ where: { key: lockKey }, update: { config: '1' }, create: { key: lockKey, url: '', config: '1' } });
    await computeAndStore(dbKey, compute);
    await prisma.apiConfig.delete({ where: { key: lockKey } }).catch(() => {});
  } catch (e) {
    console.error(`Caché: no se pudo actualizar ${dbKey}:`, e);
  } finally {
    refreshing.delete(dbKey);
  }
}

// opts.refreshAfterMs: cada cuánto se renueva en segundo plano (por defecto, cada hora como mucho)
export async function cached<T>(key: string, maxAgeMs: number, compute: () => Promise<T>, force = false, opts: { refreshAfterMs?: number } = {}): Promise<T> {
  // REPORTING_NO_CACHE=1: sin caché (scripts y pruebas sin base de datos)
  if (process.env.REPORTING_NO_CACHE === '1') return compute();
  const dbKey = PREFIX + key;
  if (!force) {
    const row = await prisma.apiConfig.findUnique({ where: { key: dbKey } });
    if (row?.config) {
      let value: T | undefined;
      try {
        value = JSON.parse(row.config) as T;
      } catch {
        // caché corrupta: se recalcula abajo
      }
      if (value !== undefined) {
        // Cachés de larga duración (p. ej. los puntos clave de la IA, por contenido) no se renuevan cada hora
        const refreshAfter = opts.refreshAfterMs ?? (maxAgeMs > 24 * REFRESH_EVERY ? maxAgeMs : Math.min(maxAgeMs, REFRESH_EVERY));
        if (Date.now() - row.updatedAt.getTime() >= refreshAfter) {
          const job = () => refreshInBackground(dbKey, compute);
          try {
            after(job);       // tras enviar la respuesta (Vercel mantiene viva la función hasta maxDuration)
          } catch {
            void job();       // fuera de una petición (scripts)
          }
        }
        return value;
      }
    }
  }
  return computeAndStore(dbKey, compute);
}

// Último valor guardado de una caché (sin recalcular) y cuándo se guardó
export async function readCached<T>(key: string): Promise<{ value: T; at: Date } | null> {
  if (process.env.REPORTING_NO_CACHE === '1') return null;
  const row = await prisma.apiConfig.findUnique({ where: { key: PREFIX + key } });
  if (!row?.config) return null;
  try {
    return { value: JSON.parse(row.config) as T, at: row.updatedAt };
  } catch {
    return null;
  }
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
