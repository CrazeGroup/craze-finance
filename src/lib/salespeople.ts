import { bcFetchAll, BcContext, getBcContext } from '@/lib/bcClient';
import { cached, HOUR, readSetting } from '@/lib/reporting/cache';

// Vendedores/compradores (tabla 13 "Salesperson/Purchaser") de BC: código → nombre, por empresa.
// Se busca primero una entidad de la API custom (salespersons, salespeople…) y si no, un servicio web OData
// publicado (Salespersons_Purchasers, SalespersonPurchaser…), o el indicado en el ajuste "salespeopleService".
// Caché de 6 h. Sustituye al antiguo salespeopleMap.json fijo.
const SERVICE_PATTERN = /sales.?pe(rson|ople)/i;

async function serviceNames(url: string, token: string): Promise<string[]> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.value || []).map((s: any) => s.name || s.url).filter(Boolean);
}

async function findService(ctx: BcContext): Promise<string | null> {
  const configured = await readSetting<string>('salespeopleService', '');
  if (configured) return `${ctx.odataCompanyBase}/${configured}`;
  const apiRoot = ctx.customApiBase.replace(/\/companies\(.*$/, '');
  const odataRoot = ctx.odataCompanyBase.replace(/\/Company\(.*$/, '');
  const [api, odata] = await Promise.all([serviceNames(apiRoot, ctx.token), serviceNames(odataRoot, ctx.token)]);
  const a = api.find(n => SERVICE_PATTERN.test(n));
  if (a) return `${ctx.customApiBase}/${a}`;
  const o = odata.filter(n => SERVICE_PATTERN.test(n)).sort((x, y) => Number(/excel/i.test(y)) - Number(/excel/i.test(x)))[0];
  return o ? `${ctx.odataCompanyBase}/${o}` : null;
}

export async function salespeopleMap(company: string, ctx?: BcContext, force = false): Promise<Map<string, string>> {
  const entries = await cached(`salespeople:${company}`, 6 * HOUR, async () => {
    const c = ctx || await getBcContext(company);
    const url = await findService(c);
    if (!url) {
      console.warn(`[salespeople] No hay servicio de vendedores publicado en BC para ${company}`);
      return [] as [string, string][];
    }
    const rows = await bcFetchAll(url, c.token);
    return rows
      .map((r: any) => [String(r.code ?? r.Code ?? '').trim(), String(r.name ?? r.Name ?? r.displayName ?? '').trim()] as [string, string])
      .filter(([code, name]) => code && name);
  }, force).catch(err => {
    console.warn(`[salespeople] Error leyendo vendedores de BC (${company}):`, err.message);
    return [] as [string, string][];
  });
  return new Map(entries);
}
