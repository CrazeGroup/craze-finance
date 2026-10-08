import prisma from '@/lib/prisma';
import { getAccessToken } from '@/lib/bcSync';

export type BcContext = {
  token: string;
  companyName: string;          // Nombre exacto de la empresa en BC
  apiBase: string;              // API estándar v2.0, ya con /companies(id)
  customApiBase: string;        // API custom craze/integrations, ya con /companies(id)
  odataCompanyBase: string;     // ODataV4, ya con /Company('nombre')
};

// Prepara token y URLs base de BC para una empresa (companyId de la app = nombre de empresa en BC)
export async function getBcContext(companyName: string): Promise<BcContext> {
  const config = await prisma.businessCentralConfig.findUnique({ where: { id: 1 } });
  if (!config || !config.tenantId || !config.clientId || !config.clientSecret) {
    throw new Error('La configuración de Business Central está incompleta. Por favor, rellena todos los campos en Ajustes.');
  }

  const token = await getAccessToken(config.tenantId, config.clientId, config.clientSecret);
  const root = `https://api.businesscentral.dynamics.com/v2.0/${config.tenantId}/${config.environment}`;

  const compRes = await fetch(`${root}/api/v2.0/companies`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!compRes.ok) throw new Error(`No se pudieron obtener las empresas de BC: ${await compRes.text()}`);
  const compData = await compRes.json();
  const company = compData.value.find((c: any) => c.name.toLowerCase() === companyName.toLowerCase());
  if (!company) throw new Error(`Empresa "${companyName}" no encontrada en Business Central.`);

  const escapedName = company.name.replace(/'/g, "''");
  return {
    token,
    companyName: company.name,
    apiBase: `${root}/api/v2.0/companies(${company.id})`,
    customApiBase: `${root}/api/craze/integrations/v1.0/companies(${company.id})`,
    odataCompanyBase: `${root}/ODataV4/Company('${encodeURIComponent(escapedName)}')`,
  };
}

// Descarga todas las páginas de una consulta OData (páginas de hasta 20.000 filas)
export async function bcFetchAll(url: string, token: string, timeoutMs = 45000): Promise<any[]> {
  let nextUrl: string | null = url;
  const results: any[] = [];
  let pages = 0;

  while (nextUrl && pages < 200) {
    pages++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=20000' },
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Consulta a BC fallida (${res.status}): ${await res.text()}`);
      const data: any = await res.json();
      if (Array.isArray(data.value)) results.push(...data.value);
      const newNext: string | null = data['@odata.nextLink'] || null;
      nextUrl = newNext === nextUrl ? null : newNext;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`Business Central tardó más de ${timeoutMs / 1000} segundos en responder.`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return results;
}

// Construye una URL OData con parámetros ($filter, $select...) codificados
export function odataUrl(base: string, params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  return query ? `${base}?${query}` : base;
}

// Descarga una tabla grande en paralelo, partiendo por rangos del campo de nº de movimiento.
// El nº de filas ($count) sirve de referencia para los rangos (algunos servicios, como las Query de BC,
// no admiten $orderby); el último rango queda abierto. `extraFilter` se combina con el rango.
export async function bcFetchByEntryRanges(
  base: string, token: string, entryField: string, select: string, extraFilter: string, parts = 6
): Promise<any[]> {
  const res = await fetch(`${base}/$count`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Consulta a BC fallida (${res.status}): ${await res.text()}`);
  const count = parseInt((await res.text()).replace(/[^0-9]/g, ''), 10) || 0;
  const size = Math.max(1, Math.ceil(count / parts));
  const chunks = await Promise.all(Array.from({ length: parts }, (_, i) => {
    const range = i === parts - 1
      ? `${entryField} gt ${i * size}`
      : `${entryField} gt ${i * size} and ${entryField} le ${(i + 1) * size}`;
    return bcFetchAll(odataUrl(base, { $select: select, $filter: extraFilter ? `${range} and ${extraFilter}` : range }), token);
  }));
  return chunks.flat();
}
