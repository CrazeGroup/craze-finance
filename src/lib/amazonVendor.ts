// Amazon Vendor Central por la SP-API: remesas (pagos que Amazon nos envía y su detalle factura a factura), Finance
// Remittance API 2026-03-17. Credenciales en variables de entorno: SP_API_CLIENT_ID / SP_API_CLIENT_SECRET (app Vendor)
// y SP_API_VENDOR_REFRESH_TOKEN_<marketplace> (o SP_API_VENDOR_REFRESH_TOKEN_DE); marketplace SP_API_MARKETPLACE (DE).
// Los pagos son del payee (CRBSL), de todos los países, con cualquier marketplace. Límite de Amazon: 0,5 llamadas/s.

const ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com';
const BASE = '/finances/remittances/2026-03-17/remittances';
const MARKETPLACES: Record<string, string> = {
  DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P',
  NL: 'A1805IZSGTT6HS', SE: 'A2NODRKZP88ZB9', PL: 'A1C3SOZRARQ6R3', BE: 'AMEN7PMS3EDWL',
};

export type Remittance = {
  paymentNumber: string; uniquePaymentId: string; date: string; amount: number; currency: string;
  country: string; method: string; status: string; lineCount: number;
};
export type RemittanceItem = {
  invoiceNumber: string; invoiceDate: string; invoiceType: string; description: string;
  total: number; withholding: number; netPaid: number; currency: string;
};

const marketplace = () => (process.env.SP_API_MARKETPLACE || 'DE').toUpperCase();

let tokenCache: { token: string; until: number } | null = null;
async function accessToken() {
  if (tokenCache && tokenCache.until > Date.now()) return tokenCache.token;
  const mk = marketplace();
  const refresh = process.env[`SP_API_VENDOR_REFRESH_TOKEN_${mk}`] || process.env.SP_API_VENDOR_REFRESH_TOKEN_DE;
  const id = process.env.SP_API_CLIENT_ID, secret = process.env.SP_API_CLIENT_SECRET;
  if (!refresh || !id || !secret) throw new Error('Faltan las credenciales de Amazon Vendor (SP_API_CLIENT_ID, SP_API_CLIENT_SECRET, SP_API_VENDOR_REFRESH_TOKEN_DE) en las variables de entorno.');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Amazon no ha dado acceso (${res.status} ${j.error || ''}).`);
  tokenCache = { token: j.access_token, until: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000 };
  return j.access_token as string;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
let lastCall = 0;
// Una llamada cada 2,1 s como mínimo (0,5 rps); con 429 o 5xx, reintenta hasta 4 veces
async function spGet(path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const gap = lastCall + 2100 - Date.now();
    if (gap > 0) await wait(gap);
    lastCall = Date.now();
    const res = await fetch(ENDPOINT + path, { headers: { 'x-amz-access-token': await accessToken(), Accept: 'application/json' } });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await wait(3000 * (attempt + 1)); continue; }
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Amazon (${res.status}): ${j.errors?.[0]?.message || ''} ${j.errors?.[0]?.details || ''}`.trim());
    return j;
  }
}

const money = (m: any) => Number(m?.currencyAmount) || 0;
const day = (s: any) => String(s || '').substring(0, 10);

// Pagos con fecha de pago entre from y to (YYYY-MM-DD, ambos incluidos)
export async function vendorRemittances(from: string, to: string): Promise<Remittance[]> {
  const mk = MARKETPLACES[marketplace()] || MARKETPLACES.DE;
  const end = new Date(Date.parse(to) + 86400000).toISOString().substring(0, 10);
  const out: Remittance[] = [];
  let next = '';
  for (let page = 0; page < 60; page++) {
    const j = await spGet(`${BASE}?startDate=${from}T00:00:00Z&endDate=${end}T00:00:00Z&marketplaceId=${mk}${next ? `&nextToken=${encodeURIComponent(next)}` : ''}`);
    for (const r of j.remittances || []) {
      out.push({
        paymentNumber: String(r.paymentNumber || ''), uniquePaymentId: String(r.uniquePaymentId || ''), date: day(r.paymentDate),
        amount: money(r.paymentAmount), currency: String(r.paymentAmount?.currencyCode || ''), country: String(r.countryCode || ''),
        method: String(r.paymentMethod || ''), status: String(r.remittanceStatus || ''), lineCount: Number(r.lineItemCount) || 0,
      });
    }
    next = j.nextToken || '';
    if (!next) break;
  }
  return out.filter(r => r.date >= from && r.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.paymentNumber.localeCompare(b.paymentNumber));
}

// Detalle de un pago: una fila por factura pagada o ajustada (deducciones de Amazon en negativo)
export async function remittanceItems(uniquePaymentId: string): Promise<RemittanceItem[]> {
  const mk = MARKETPLACES[marketplace()] || MARKETPLACES.DE;
  const out: RemittanceItem[] = [];
  let next = '';
  for (let page = 0; page < 50; page++) {
    const j = await spGet(`${BASE}/${encodeURIComponent(uniquePaymentId)}?marketplaceId=${mk}${next ? `&nextTokenForLineItems=${encodeURIComponent(next)}` : ''}`);
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
