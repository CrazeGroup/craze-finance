// Amazon Vendor Central por la SP-API: remesas (pagos que Amazon nos envía y su detalle factura a factura), Finance
// Remittance API 2026-03-17. Credenciales en variables de entorno: SP_API_CLIENT_ID / SP_API_CLIENT_SECRET (app Vendor)
// y un SP_API_VENDOR_REFRESH_TOKEN_<marketplace> por marketplace autorizado (DE, FR, IT, ES, UK, NL, SE, PL, BE).
// Cada token solo devuelve los pagos de su marketplace (DE también PL y CZ; UK en GBP; NL y BE repiten pagos FR/DE): se
// leen todos y se quitan los repetidos por uniquePaymentId. Límite de Amazon: 0,5 llamadas/s.

const ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com';
const BASE = '/finances/remittances/2026-03-17/remittances';
const MARKETPLACES: Record<string, string> = {
  DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P',
  NL: 'A1805IZSGTT6HS', SE: 'A2NODRKZP88ZB9', PL: 'A1C3SOZRARQ6R3', BE: 'AMEN7PMS3EDWL',
};

export type Remittance = {
  marketplace: string; paymentNumber: string; uniquePaymentId: string; date: string; amount: number; currency: string;
  country: string; method: string; status: string; lineCount: number;
};
export type RemittanceItem = {
  invoiceNumber: string; invoiceDate: string; invoiceType: string; description: string;
  total: number; withholding: number; netPaid: number; currency: string;
};

// Empresas con Amazon Vendor: CRAZE GmbH (CRAZE) lee todos los marketplaces menos UK; CRAZE Toys Ltd (Craze UK), Amazon UK.
// El resto de empresas no vende a Amazon.
export const amazonCompany = (company: string) => company === 'CRAZE' || company === 'Craze UK';
// Marketplaces con token en las variables de entorno, de la empresa
export const vendorMarketplaces = (company?: string) => Object.keys(MARKETPLACES)
  .filter(k => process.env[`SP_API_VENDOR_REFRESH_TOKEN_${k}`])
  .filter(k => !company || (company === 'Craze UK' ? k === 'UK' : company === 'CRAZE' && k !== 'UK'));

const tokenCache = new Map<string, { token: string; until: number }>();
async function accessToken(mk: string) {
  const cachedToken = tokenCache.get(mk);
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.token;
  const refresh = process.env[`SP_API_VENDOR_REFRESH_TOKEN_${mk}`];
  const id = process.env.SP_API_CLIENT_ID, secret = process.env.SP_API_CLIENT_SECRET;
  if (!refresh || !id || !secret) {
    // Qué variables SP_API_ ve el servidor (solo nombre y longitud, nunca el valor)
    const seen = Object.keys(process.env).filter(k => k.startsWith('SP_API_')).map(k => `${k} (${String(process.env[k] || '').length})`);
    throw new Error(`Faltan las credenciales de Amazon Vendor (SP_API_CLIENT_ID, SP_API_CLIENT_SECRET y SP_API_VENDOR_REFRESH_TOKEN_DE, _FR, _IT, _ES, _UK…) en las variables de entorno de Vercel. El servidor ve: ${seen.join(', ') || 'ninguna'}.`);
  }
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Amazon no ha dado acceso (${res.status} ${j.error || ''}).`);
  tokenCache.set(mk, { token: j.access_token, until: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000 });
  return j.access_token as string;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
let lastCall = 0;
// Una llamada cada 2,1 s como mínimo (0,5 rps); con 429 o 5xx, reintenta hasta 4 veces
async function spGet(mk: string, path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const gap = lastCall + 2100 - Date.now();
    if (gap > 0) await wait(gap);
    lastCall = Date.now();
    const res = await fetch(ENDPOINT + path, { headers: { 'x-amz-access-token': await accessToken(mk), Accept: 'application/json' } });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await wait(3000 * (attempt + 1)); continue; }
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Amazon (${res.status}): ${j.errors?.[0]?.message || ''} ${j.errors?.[0]?.details || ''}`.trim());
    return j;
  }
}

const money = (m: any) => Number(m?.currencyAmount) || 0;
const day = (s: any) => String(s || '').substring(0, 10);

// Pagos con fecha de pago entre from y to (YYYY-MM-DD, ambos incluidos), de los marketplaces de la empresa
export async function vendorRemittances(from: string, to: string, company?: string): Promise<Remittance[]> {
  const markets = vendorMarketplaces(company);
  if (!markets.length) await accessToken(company === 'Craze UK' ? 'UK' : 'DE');   // sin token: el error de credenciales
  const end = new Date(Date.parse(to) + 86400000).toISOString().substring(0, 10);
  const out: Remittance[] = [];
  const seen = new Set<string>();
  for (const k of markets) {
    let next = '';
    for (let page = 0; page < 60; page++) {
      const j = await spGet(k, `${BASE}?startDate=${from}T00:00:00Z&endDate=${end}T00:00:00Z&marketplaceId=${MARKETPLACES[k]}${next ? `&nextToken=${encodeURIComponent(next)}` : ''}`);
      for (const r of j.remittances || []) {
        if (seen.has(String(r.uniquePaymentId))) continue;
        seen.add(String(r.uniquePaymentId));
        out.push({
          marketplace: k,
          paymentNumber: String(r.paymentNumber || ''), uniquePaymentId: String(r.uniquePaymentId || ''), date: day(r.paymentDate),
          amount: money(r.paymentAmount), currency: String(r.paymentAmount?.currencyCode || ''), country: String(r.countryCode || ''),
          method: String(r.paymentMethod || ''), status: String(r.remittanceStatus || ''), lineCount: Number(r.lineItemCount) || 0,
        });
      }
      next = j.nextToken || '';
      if (!next) break;
    }
  }
  return out.filter(r => r.date >= from && r.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.paymentNumber.localeCompare(b.paymentNumber));
}

// Detalle de un pago: una fila por factura pagada o ajustada (deducciones de Amazon en negativo)
export async function remittanceItems(r: Pick<Remittance, 'marketplace' | 'uniquePaymentId'>): Promise<RemittanceItem[]> {
  const { marketplace: mk, uniquePaymentId } = r;
  const out: RemittanceItem[] = [];
  let next = '';
  for (let page = 0; page < 50; page++) {
    const j = await spGet(mk, `${BASE}/${encodeURIComponent(uniquePaymentId)}?marketplaceId=${MARKETPLACES[mk]}${next ? `&nextTokenForLineItems=${encodeURIComponent(next)}` : ''}`);
    for (const i of j.remittanceItems || []) {
      out.push({
        invoiceNumber: String(i.invoiceNumber || ''), invoiceDate: day(i.invoiceIssueDate), invoiceType: String(i.invoiceType || ''),
        description: String(i.description || ''), total: money(i.totalAmount), withholding: money(i.withholdingAmount),
        netPaid: money(i.netAmountPaid), currency: String(i.netAmountPaid?.currencyCode || ''),
      });
    }
    next = j.nextTokenForLineItems || '';
    if (!next) break;
  }
  return out;
}
