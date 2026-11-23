// Transus WebConnect (EDI): servicio SOAP https://webconnect.transus.com/Exchange.asmx
// Credenciales en env TRANSUS_CLIENT_ID / TRANSUS_CLIENT_KEY (van en el cuerpo de cada llamada).
// Operaciones: M10100 enviar mensaje, M10110 recoger el siguiente mensaje (lo saca de la cola), M10300 confirmar recepción.
// No hay ninguna operación para consultar lo ya enviado.
const ENDPOINT = 'https://webconnect.transus.com/Exchange.asmx';
const NS = 'https://webconnect.transus.com/';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function transusCredentials() {
  const clientId = process.env.TRANSUS_CLIENT_ID, clientKey = process.env.TRANSUS_CLIENT_KEY;
  return clientId && clientKey ? { clientId, clientKey } : null;
}

// Llamada SOAP 1.1; devuelve los campos de <OpResponse> como texto
export async function transusCall(op: string, fields: Record<string, string>, creds = transusCredentials()) {
  if (!creds) throw new Error('Faltan TRANSUS_CLIENT_ID / TRANSUS_CLIENT_KEY');
  const body = Object.entries({ ClientID: creds.clientId, ClientKey: creds.clientKey, ...fields })
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${op} xmlns="${NS}">${body}</${op}></soap:Body></soap:Envelope>`;
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${NS}${op}` }, body: envelope });
  const xml = await res.text();
  const inner = xml.match(new RegExp(`<${op}Response[^>]*>([\\s\\S]*?)</${op}Response>`))?.[1];
  const out: Record<string, string> = {};
  if (inner) for (const m of inner.matchAll(/<(\w+)>([\s\S]*?)<\/\1>|<(\w+)\s*\/>/g)) out[m[1] || m[3]] = m[2] ? unesc(m[2]) : '';
  const fault = xml.match(/<faultstring>([\s\S]*?)<\/faultstring>/)?.[1];
  return { httpStatus: res.status, fields: out, fault: fault ? unesc(fault) : undefined, raw: inner ? undefined : xml.substring(0, 1500) };
}
