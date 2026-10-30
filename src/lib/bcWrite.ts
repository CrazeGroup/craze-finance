import type { BcContext } from '@/lib/bcClient';

// Escrituras en BC (API v2 / OData) compartidas por Aduanas y OCR

// Petición a BC con el mensaje de error de BC si falla (PATCH/DELETE con If-Match: *)
export async function bcRequest(method: string, url: string, token: string, body?: any) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(method === 'PATCH' || method === 'DELETE' ? { 'If-Match': '*' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* texto */ }
    throw new Error(`BC ${method} ${url.split('/').pop()?.split('?')[0]}: ${msg.substring(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Adjunta un fichero a un documento (Attachments de BC, v2 documentAttachments + attachmentContent)
export async function attachFile(ctx: BcContext, parentId: string, file: { name: string; data: Uint8Array }, parentType = 'Purchase Invoice') {
  const att = await bcRequest('POST', `${ctx.apiBase}/documentAttachments`, ctx.token, { fileName: file.name, parentType, parentId });
  const res = await fetch(`${ctx.apiBase}/documentAttachments(${att.id})/attachmentContent`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/octet-stream', 'If-Match': '*' },
    body: Buffer.from(file.data),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).substring(0, 160)}`);
}
