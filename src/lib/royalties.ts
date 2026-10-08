import prisma from '@/lib/prisma';
import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR, readSetting } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';

// Royalties: líneas de la tabla 60000 "AIT Document LM Components" (página 60000 "AIT Documents LM Components").
// Se leen de BC (servicio web OData de la página) o, mientras no esté disponible, de la última exportación
// a Excel de esa página subida en la app. Sin líneas "Main Item" ni ventas intercompañía, agrupado por
// Royalty Code × país de facturación × artículo.

// Línea normalizada (BC o Excel). Las líneas Main Item no se guardan.
export type LmLine = {
  date: string; code: string; country: string; item: string; desc: string;
  qty: number; turnover: number; provision: number;
  custNo: string; custName: string; dim: string; vatBus: string;
};

export type RoyaltyRow = {
  code: string; country: string; item: string; desc: string;
  qty: number; turnover: number; price: number; provision: number; rate: number; lines: number;
};

// ---------- Intercompañía ----------

// Cliente intercompañía: forma de pago INTERGROUP (misma regla que la cartera), empresa del grupo
// (nombre "CRAZE …"), dimensión de cliente "Craze Intercompany" o grupo IVA INTERCOMPANY
const GROUP_NAME = /^craze\b/i;
export function isIntercompany(l: LmLine, icCustomers: Set<string>) {
  return icCustomers.has(l.custNo) || GROUP_NAME.test(l.custName) || /intercompany/i.test(l.dim) || /^INTERCOMPANY/i.test(l.vatBus);
}

async function intergroupCustomers(company: string) {
  const customers = await prisma.customer.findMany({ where: { companyId: company, paymentMethod: 'INTERGROUP' }, select: { bcId: true } });
  return new Set(customers.map(c => c.bcId).filter(Boolean) as string[]);
}

// ---------- Agregado ----------

export function buildReport(lines: LmLine[], from: string, to: string, icCustomers: Set<string>) {
  const stats = { lines: 0, ic: { lines: 0, turnover: 0, provision: 0 } };
  const groups = new Map<string, RoyaltyRow>();
  for (const l of lines) {
    if (l.date < from || l.date > to) continue;
    stats.lines++;
    if (isIntercompany(l, icCustomers)) {
      stats.ic.lines++;
      stats.ic.turnover += l.turnover;
      stats.ic.provision += l.provision;
      continue;
    }
    const code = l.code || 'NOT APPLIED';
    const key = `${code}|${l.country}|${l.item}`;
    const g = groups.get(key) || { code, country: l.country, item: l.item, desc: l.desc, qty: 0, turnover: 0, price: 0, provision: 0, rate: 0, lines: 0 };
    g.qty += l.qty;
    g.turnover += l.turnover;
    g.provision += l.provision;
    g.lines++;
    groups.set(key, g);
  }
  // Precio medio por unidad y % royalty efectivo del grupo
  const rows = Array.from(groups.values()).map(g => ({
    ...g, price: g.qty ? g.turnover / g.qty : 0, rate: g.turnover ? g.provision / g.turnover : 0,
  }));
  return { rows, stats };
}

// ---------- Business Central ----------

// El nombre del servicio web se puede fijar en ApiConfig ('reporting:setting:royaltiesService');
// si no, se busca en la lista de servicios OData / API custom por su nombre.
const SERVICE_PATTERN = /lm_?components?|royalt/i;

// Nombres posibles de cada campo (OData de página: Royalty_Code; API: royaltyCode)
const FIELDS = {
  code: ['Royalty_Code', 'royaltyCode'],
  country: ['Bill_to_Country_Region_Code', 'billToCountryRegionCode'],
  item: ['No', 'no', 'itemNo'],
  desc: ['Description', 'description'],
  qty: ['Quantity', 'quantity'],
  turnover: ['Turnover_Net_of_Provision_Sales', 'turnoverNetOfProvisionSales'],
  provision: ['Provision_Royalties', 'provisionRoyalties'],
  main: ['Main_Item', 'mainItem'],
  date: ['Posting_Date', 'postingDate'],
  custNo: ['Bill_to_Customer_No', 'billToCustomerNo', 'Sell_to_Customer_No', 'sellToCustomerNo'],
  custName: ['Bill_to_Customer_Name', 'billToCustomerName', 'Sell_to_Customer_Name', 'sellToCustomerName'],
  dim: ['Customer_Dimension_Name', 'customerDimensionName'],
  vatBus: ['VAT_Bus_Posting_Group', 'vatBusPostingGroup'],
} as const;
type FieldKey = keyof typeof FIELDS;
const REQUIRED: FieldKey[] = ['code', 'country', 'item', 'qty', 'turnover', 'provision', 'main', 'date'];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function resolveFields(sample: Record<string, any>) {
  const keys = Object.keys(sample).filter(k => !k.startsWith('@'));
  const byNorm = new Map(keys.map(k => [norm(k), k]));
  const map = {} as Record<FieldKey, string | null>;
  for (const f of Object.keys(FIELDS) as FieldKey[]) {
    map[f] = FIELDS[f].map(c => byNorm.get(norm(c))).find(Boolean) || null;
  }
  return { map, keys };
}

export class RoyaltiesSetupError extends Error {
  constructor(message: string, public details: Record<string, unknown>) { super(message); }
}

async function serviceNames(url: string, token: string): Promise<string[]> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.value || []).map((s: any) => s.name || s.url).filter(Boolean);
}

// URL del conjunto de datos de la tabla 60000 para la empresa
async function findService(ctx: BcContext): Promise<{ name: string; url: string }> {
  const configured = await readSetting<string>('royaltiesService', '');
  if (configured) return { name: configured, url: `${ctx.odataCompanyBase}/${configured}` };

  const odataRoot = ctx.odataCompanyBase.replace(/\/Company\(.*$/, '');
  const apiRoot = ctx.customApiBase.replace(/\/companies\(.*$/, '');
  const [odata, api] = await Promise.all([serviceNames(odataRoot, ctx.token), serviceNames(apiRoot, ctx.token)]);
  const o = odata.find(n => SERVICE_PATTERN.test(n));
  if (o) return { name: o, url: `${ctx.odataCompanyBase}/${o}` };
  const a = api.find(n => SERVICE_PATTERN.test(n));
  if (a) return { name: a, url: `${ctx.customApiBase}/${a}` };

  throw new RoyaltiesSetupError(
    'No se encuentra en Business Central el servicio web de la página 60000 "AIT Documents LM Components". ' +
    'Publícala en "Servicios web" (tipo Página, objeto 60000) o indica su nombre en la configuración.',
    { odataServices: odata, apiEntities: api }
  );
}

export const isTrue = (v: any) => v === true || v === 1 || v === '1' || v === 'true' || v === 'Yes' || v === 'Sí';
export const num = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
export const str = (v: any) => (v == null ? '' : String(v).trim());

async function bcLines(ctx: BcContext, from: string, to: string): Promise<{ service: string; lines: LmLine[] }> {
  const service = await findService(ctx);
  // Una fila para conocer los nombres reales de los campos
  const sample = await bcFetchAll(odataUrl(service.url, { $top: '1' }), ctx.token);
  if (!sample.length) return { service: service.name, lines: [] };
  const { map: F, keys } = resolveFields(sample[0]);
  const missing = REQUIRED.filter(f => !F[f]);
  if (missing.length) {
    throw new RoyaltiesSetupError(
      `El servicio "${service.name}" no tiene los campos esperados (${missing.join(', ')}).`,
      { service: service.name, availableFields: keys }
    );
  }
  const raw = await bcFetchAll(odataUrl(service.url, { $filter: `${F.date} ge ${from} and ${F.date} le ${to}` }), ctx.token);
  const get = (r: any, f: FieldKey) => (F[f] ? r[F[f] as string] : undefined);
  const lines = raw.filter(r => !isTrue(get(r, 'main'))).map(r => ({
    date: str(get(r, 'date')).substring(0, 10),
    code: str(get(r, 'code')), country: str(get(r, 'country')), item: str(get(r, 'item')), desc: str(get(r, 'desc')),
    qty: num(get(r, 'qty')), turnover: num(get(r, 'turnover')), provision: num(get(r, 'provision')),
    custNo: str(get(r, 'custNo')), custName: str(get(r, 'custName')), dim: str(get(r, 'dim')), vatBus: str(get(r, 'vatBus')),
  }));
  return { service: service.name, lines };
}

// ---------- Excel subido ----------

const UPLOAD_PREFIX = 'royalties:upload:';
// Formato guardado: descripciones por artículo aparte para que quepa en el límite de Vercel
export type StoredUpload = {
  fileName: string; uploadedAt: string; from: string; to: string;
  desc: Record<string, string>;
  lines: [string, string, string, string, number, number, number, string, string, string, string][];
};

export async function saveUpload(company: string, upload: StoredUpload) {
  const config = JSON.stringify(upload);
  const key = UPLOAD_PREFIX + company;
  await prisma.apiConfig.upsert({ where: { key }, update: { config }, create: { key, url: '', config } });
}

async function loadUpload(company: string): Promise<{ meta: Omit<StoredUpload, 'lines' | 'desc'>; lines: LmLine[] } | null> {
  const row = await prisma.apiConfig.findUnique({ where: { key: UPLOAD_PREFIX + company } });
  if (!row?.config) return null;
  const u = JSON.parse(row.config) as StoredUpload;
  const lines = u.lines.map(([date, code, country, item, qty, turnover, provision, custNo, custName, dim, vatBus]) => ({
    date, code, country, item, desc: u.desc[item] || '', qty, turnover, provision, custNo, custName, dim, vatBus,
  }));
  return { meta: { fileName: u.fileName, uploadedAt: u.uploadedAt, from: u.from, to: u.to }, lines };
}

// ---------- Informe ----------

export async function royaltiesReport(ctx: BcContext | null, company: string, from: string, to: string, force = false) {
  let bcError: string | null = null;
  if (ctx) {
    try {
      const fromBc = await cached(`royalties:${company}:${from}:${to}`, to < today() ? 12 * HOUR : 1 * HOUR, async () => {
        const { service, lines } = await bcLines(ctx, from, to);
        return { service, ...buildReport(lines, from, to, await intergroupCustomers(company)) };
      }, force);
      return { from, to, company, source: 'bc' as const, ...fromBc };
    } catch (e: any) {
      bcError = e.message;
      if (!(e instanceof RoyaltiesSetupError)) console.error('Royalties BC:', e);
    }
  }
  const upload = await loadUpload(company);
  if (!upload) {
    throw new RoyaltiesSetupError(
      `${bcError ? bcError + ' ' : ''}Mientras tanto, puedes cargar la exportación a Excel de la página "Documents LM Components".`,
      {}
    );
  }
  return {
    from, to, company, source: 'excel' as const, upload: upload.meta, bcError,
    ...buildReport(upload.lines, from, to, await intergroupCustomers(company)),
  };
}
