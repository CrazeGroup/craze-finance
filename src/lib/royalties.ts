import prisma from '@/lib/prisma';
import { bcFetchAll, BcContext, getBcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR, readSetting } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';
import { DEFAULT_ROYALTY_RATES } from '@/lib/royaltyRates';

// Royalties: líneas de la tabla 60000 "AIT Document LM Components" (página 60000 "AIT Documents LM Components").
// Se leen de BC (servicio web OData de la página) o, mientras no esté disponible, de la última exportación
// a Excel de esa página subida en la app. Sin líneas "Main Item" ni ventas intercompañía, agrupado por
// Royalty Code × país de facturación × artículo. El Royalty Code de la LM no se usa: se toma siempre de la ficha
// del artículo (tabla 27) en CRAZE GmbH, que es donde está bien mantenido (en otras empresas, como UK, no siempre).
// La provisión tampoco se toma de la LM: se recalcula con el % de cada Royalty Code de la tabla 80007 RoyaltiesCRZ
// de CRAZE GmbH (Turnover × % Domestic Royalty; % FOB Royalty en ventas con condición de envío FOB).

// Línea normalizada (BC o Excel). Las líneas Main Item no se guardan.
export type LmLine = {
  date: string; code: string; country: string; item: string; desc: string;
  qty: number; turnover: number; provision: number;
  custNo: string; custName: string; dim: string; vatBus: string; ship: string;
};

// % de royalty por Royalty Code (tabla 80007 RoyaltiesCRZ de CRAZE GmbH), en tanto por uno
export type RoyaltyRates = Record<string, { domestic: number; fob: number }>;

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

// itemCodes: Royalty Code de la ficha de cada artículo en CRAZE GmbH ('' = sin royalty). Si el artículo no
// existe allí (o no se pudo leer), se queda el código de la LM.
// rates: null = se queda la provisión de la LM. Un código sin % en la tabla de royalties no provisiona.
// excludedCodes: licencias que la empresa no puede vender (se quitan del informe, ver EXCLUDED_CODES)
export function buildReport(
  lines: LmLine[], from: string, to: string, icCustomers: Set<string>,
  itemCodes: Record<string, string> | null, rates: RoyaltyRates | null, excludedCodes: string[] = [],
) {
  const stats = {
    lines: 0, ic: { lines: 0, turnover: 0, provision: 0 }, noItemCard: [] as string[], noRate: [] as string[],
    excluded: { codes: excludedCodes, lines: 0, turnover: 0 },
  };
  const noCard = new Set<string>();
  const noRate = new Set<string>();
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
    let code = l.code;
    if (itemCodes) {
      if (l.item in itemCodes) code = itemCodes[l.item];
      else noCard.add(l.item);
    }
    code = code || 'NOT APPLIED';
    if (excludedCodes.includes(code.toUpperCase())) {
      stats.excluded.lines++;
      stats.excluded.turnover += l.turnover;
      continue;
    }
    let provision = l.provision;
    if (rates) {
      const r = rates[code.toUpperCase()];
      if (!r && code !== 'NOT APPLIED') noRate.add(code);
      provision = r ? l.turnover * (/^FOB$/i.test(l.ship) ? r.fob : r.domestic) : 0;
    }
    const key = `${code}|${l.country}|${l.item}`;
    const g = groups.get(key) || { code, country: l.country, item: l.item, desc: l.desc, qty: 0, turnover: 0, price: 0, provision: 0, rate: 0, lines: 0 };
    g.qty += l.qty;
    g.turnover += l.turnover;
    g.provision += provision;
    g.lines++;
    groups.set(key, g);
  }
  stats.noItemCard = Array.from(noCard).sort();
  stats.noRate = Array.from(noRate).sort();
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
  ship: ['Shipment_Method_Code', 'shipmentMethodCode'],
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
    ship: str(get(r, 'ship')),
  }));
  return { service: service.name, lines };
}

// ---------- Royalty Code de la ficha de artículo (CRAZE GmbH) ----------

export const MASTER_COMPANY = 'CRAZE';
const ROYALTY_FIELD = /royalt/i;

async function sampleKeys(url: string, token: string): Promise<string[] | null> {
  const res = await fetch(odataUrl(url, { $top: '1' }), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) return null;
  const data: any = await res.json();
  return data.value?.[0] ? Object.keys(data.value[0]) : null;
}

// Busca un listado de artículos que incluya el Royalty Code: API custom "items" o una página de artículos
// publicada en OData (Items, Item_Card…). Nombre del servicio fijable con el setting 'royaltiesItemService'.
async function itemRoyaltyCodes(ctx: BcContext): Promise<Record<string, string>> {
  const odataRoot = ctx.odataCompanyBase.replace(/\/Company\(.*$/, '');
  const configured = await readSetting<string>('royaltiesItemService', '');
  const odataNames = configured ? [configured] : (await serviceNames(odataRoot, ctx.token)).filter(n => /^item/i.test(n));
  const candidates = [
    `${ctx.customApiBase}/items`,
    ...odataNames.sort((a, b) => Number(!/^items?(_card)?$/i.test(a)) - Number(!/^items?(_card)?$/i.test(b))).map(n => `${ctx.odataCompanyBase}/${n}`),
  ];
  const tried: string[] = [];
  for (const url of candidates) {
    const keys = await sampleKeys(url, ctx.token);
    const name = url.split('/').pop() as string;
    tried.push(`${name}${keys ? '' : ' (no accesible)'}`);
    const codeKey = keys?.find(k => ROYALTY_FIELD.test(k));
    const noKey = keys?.find(k => ['number', 'no', 'No'].includes(k));
    if (!codeKey || !noKey) continue;
    const rows = await bcFetchAll(odataUrl(url, { $select: `${noKey},${codeKey}` }), ctx.token);
    return Object.fromEntries(rows.map(r => [str(r[noKey]), str(r[codeKey])]));
  }
  throw new Error(`No se encuentra el Royalty Code de la ficha de artículo en ${ctx.companyName} (probado: ${tried.join(', ') || 'ningún servicio de artículos'}).`);
}

// % de royalty de la página 80007 "Royalties" (servicio web RoyaltiesCRZ, fijable con 'royaltiesRatesService')
async function royaltyRates(ctx: BcContext): Promise<RoyaltyRates> {
  const service = await readSetting<string>('royaltiesRatesService', 'RoyaltiesCRZ');
  const rows = await bcFetchAll(`${ctx.odataCompanyBase}/${service}`, ctx.token);
  if (!rows.length) throw new Error(`El servicio ${service} de ${ctx.companyName} no devuelve ningún Royalty Code.`);
  const keys = Object.keys(rows[0]);
  const codeKey = keys.find(k => /^code$/i.test(k));
  const domKey = keys.find(k => /domestic/i.test(k) && !/total/i.test(k));
  const fobKey = keys.find(k => /fob/i.test(k) && !/total/i.test(k));
  if (!codeKey || !domKey) throw new Error(`El servicio ${service} no tiene los campos Code / % Domestic Royalty (campos: ${keys.join(', ')}).`);
  return Object.fromEntries(rows.map(r => [str(r[codeKey]).toUpperCase(), {
    domestic: num(r[domKey]) / 100,
    fob: (fobKey ? num(r[fobKey]) : num(r[domKey])) / 100,
  }]));
}

// Excel de la página 80007 "Royalties" subido en la app (para cuando RoyaltiesCRZ no se puede leer de BC)
const RATES_UPLOAD_KEY = 'royalties:rates-upload';
export type StoredRates = { fileName: string; uploadedAt: string; rates: RoyaltyRates };

export async function saveRatesUpload(upload: StoredRates) {
  const config = JSON.stringify(upload);
  await prisma.apiConfig.upsert({ where: { key: RATES_UPLOAD_KEY }, update: { config }, create: { key: RATES_UPLOAD_KEY, url: '', config } });
}

async function loadRatesUpload(): Promise<StoredRates | null> {
  const row = await prisma.apiConfig.findUnique({ where: { key: RATES_UPLOAD_KEY } });
  return row?.config ? JSON.parse(row.config) as StoredRates : null;
}

// Datos maestros de CRAZE GmbH: Royalty Code por artículo y % por Royalty Code.
// % de royalty: RoyaltiesCRZ de BC → Excel de royalties subido → tabla fija de royaltyRates.ts
async function loadMasterData(ctx: BcContext | null, force: boolean) {
  const out = {
    itemCodes: null as Record<string, string> | null, itemsError: null as string | null,
    rates: null as RoyaltyRates | null, ratesSource: 'bc' as 'bc' | 'excel' | 'default', ratesInfo: null as string | null, ratesBcError: null as string | null,
  };
  let gmbh: BcContext | null = null;
  try {
    gmbh = ctx && ctx.companyName.toLowerCase() === MASTER_COMPANY.toLowerCase() ? ctx : await getBcContext(MASTER_COMPANY);
  } catch (e: any) {
    out.itemsError = out.ratesBcError = e.message;
  }
  if (gmbh) {
    const g = gmbh;
    const [items, rates] = await Promise.allSettled([
      cached(`royalties:items:${MASTER_COMPANY}`, 6 * HOUR, () => itemRoyaltyCodes(g), force),
      cached(`royalties:rates:${MASTER_COMPANY}`, 6 * HOUR, () => royaltyRates(g), force),
    ]);
    if (items.status === 'fulfilled') out.itemCodes = items.value;
    else { out.itemsError = items.reason?.message || String(items.reason); console.error('Royalties items:', items.reason); }
    if (rates.status === 'fulfilled') out.rates = rates.value;
    else { out.ratesBcError = rates.reason?.message || String(rates.reason); console.error('Royalties rates:', rates.reason); }
  }
  if (!out.rates) {
    const uploaded = await loadRatesUpload();
    if (uploaded) {
      out.rates = uploaded.rates;
      out.ratesSource = 'excel';
      out.ratesInfo = `${uploaded.fileName} (cargado el ${uploaded.uploadedAt.substring(0, 10).split('-').reverse().join('/')})`;
    } else {
      out.rates = DEFAULT_ROYALTY_RATES;
      out.ratesSource = 'default';
      out.ratesInfo = 'tabla Royalties de CRAZE GmbH del 08/10/2026';
    }
  }
  return out;
}

// Licencias que una empresa no puede vender: sus líneas no entran en el informe
const EXCLUDED_CODES: { company: RegExp; codes: string[] }[] = [
  { company: /\bUK\b/i, codes: ['BLUEY'] },
];
export const excludedCodesFor = (company: string) => EXCLUDED_CODES.filter(e => e.company.test(company)).flatMap(e => e.codes);

// ---------- Divisa ----------

// Divisa local de cada empresa (UK en GBP, Group AG en CHF; el resto en EUR)
export function companyCurrency(company: string) {
  return /\bUK\b/i.test(company) ? 'GBP' : /\bAG\b/i.test(company) ? 'CHF' : 'EUR';
}

// Tipo de cambio a EUR (EUR por 1 unidad de la divisa) de Currencies_Excel en CRAZE GmbH, como el BWA
async function eurRate(ctx: BcContext | null, currency: string, force: boolean) {
  try {
    const gmbh = ctx && ctx.companyName.toLowerCase() === MASTER_COMPANY.toLowerCase() ? ctx : await getBcContext(MASTER_COMPANY);
    return await cached(`royalties:fx:${currency}`, 6 * HOUR, async () => {
      const rows = await bcFetchAll(odataUrl(`${gmbh.odataCompanyBase}/Currencies_Excel`, { $select: 'Code,ExchangeRateAmt,ExchangeRateDate' }), gmbh.token);
      const row = rows.find((c: any) => c.Code === currency && c.ExchangeRateAmt);
      if (!row) throw new Error(`No hay tipo de cambio para ${currency} en Currencies_Excel.`);
      return { rate: num(row.ExchangeRateAmt), date: str(row.ExchangeRateDate).substring(0, 10), error: null as string | null };
    }, force);
  } catch (e: any) {
    console.error('Royalties fx:', e);
    return { rate: null, date: null, error: e.message as string };
  }
}

// ---------- Excel subido ----------

const UPLOAD_PREFIX = 'royalties:upload:';
// Formato guardado: descripciones por artículo aparte para que quepa en el límite de Vercel
export type StoredUpload = {
  fileName: string; uploadedAt: string; from: string; to: string;
  desc: Record<string, string>;
  // [fecha, código, país, artículo, cantidad, turnover, provisión, nº cliente, cliente, dimensión, grupo IVA, cond. envío]
  lines: [string, string, string, string, number, number, number, string, string, string, string, string?][];
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
  const lines = u.lines.map(([date, code, country, item, qty, turnover, provision, custNo, custName, dim, vatBus, ship]) => ({
    date, code, country, item, desc: u.desc[item] || '', qty, turnover, provision, custNo, custName, dim, vatBus, ship: ship || '',
  }));
  return { meta: { fileName: u.fileName, uploadedAt: u.uploadedAt, from: u.from, to: u.to }, lines };
}

// ---------- Informe ----------

export async function royaltiesReport(ctx: BcContext | null, company: string, from: string, to: string, force = false) {
  let bcError: string | null = null;
  const master = await loadMasterData(ctx, force);
  const currency = companyCurrency(company);
  const fx = currency === 'EUR' ? null : await eurRate(ctx, currency, force);
  const masterInfo = { currency, fx, itemsError: master.itemsError, ratesSource: master.ratesSource, ratesInfo: master.ratesInfo, ratesBcError: master.ratesBcError };
  if (ctx) {
    try {
      // Se guardan las líneas (no el agregado) para aplicar los Royalty Codes de artículo vigentes
      const fromBc = await cached(`royalties:lines:${company}:${from}:${to}`, to < today() ? 12 * HOUR : 1 * HOUR, () => bcLines(ctx, from, to), force);
      return {
        from, to, company, source: 'bc' as const, service: fromBc.service, ...masterInfo,
        ...buildReport(fromBc.lines, from, to, await intergroupCustomers(company), master.itemCodes, master.rates, excludedCodesFor(company)),
      };
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
    from, to, company, source: 'excel' as const, upload: upload.meta, bcError, ...masterInfo,
    ...buildReport(upload.lines, from, to, await intergroupCustomers(company), master.itemCodes, master.rates, excludedCodesFor(company)),
  };
}
