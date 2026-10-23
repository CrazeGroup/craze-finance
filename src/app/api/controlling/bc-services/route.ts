import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Diagnóstico: servicios OData y entidades de API (custom y v2.0) publicados en BC, con los campos de los que
// coinciden con ?match= (regex, por defecto compras / configuración contable / movimientos contables).
async function names(url: string, token: string): Promise<string[]> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.value || []).map((s: any) => s.name || s.url).filter(Boolean);
}
async function fields(url: string, token: string): Promise<string[] | string> {
  const res = await fetch(`${url}?$top=1`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`;
  const data: any = await res.json();
  return data.value?.[0] ? Object.keys(data.value[0]).filter(k => !k.startsWith('@')) : '(sin filas)';
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const match = new RegExp(searchParams.get('match') || 'purch|posting.?setup|g.?l.?entr|general.?ledger|vendor', 'i');
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const ctx = await getBcContext(company === 'ALL' ? 'CRAZE' : company);
    // ?sample=<servicio OData>[&filter=&select=&top=]: filas de ejemplo de un servicio (diagnóstico, solo lectura)
    const sample = searchParams.get('sample');
    if (sample) {
      const params = new URLSearchParams({ $top: searchParams.get('top') || '5' });
      if (searchParams.get('filter')) params.set('$filter', searchParams.get('filter')!);
      if (searchParams.get('select')) params.set('$select', searchParams.get('select')!);
      const base = searchParams.get('api') === 'custom' ? ctx.customApiBase : searchParams.get('api') === 'v2' ? ctx.apiBase : ctx.odataCompanyBase;
      const res = await fetch(`${base}/${encodeURIComponent(sample)}?${params}`, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
      const body = await res.json().catch(async () => ({ error: await res.text() }));
      return NextResponse.json({ company: ctx.companyName, status: res.status, rows: body.value ?? body });
    }
    const odataRoot = ctx.odataCompanyBase.replace(/\/Company\(.*$/, '');
    const customRoot = ctx.customApiBase.replace(/\/companies\(.*$/, '');
    const [odata, custom, v2] = await Promise.all([names(odataRoot, ctx.token), names(customRoot, ctx.token), names(ctx.apiBase.replace(/\/companies\(.*$/, ''), ctx.token)]);
    const pick = async (list: string[], base: string) => Object.fromEntries(await Promise.all(
      list.filter(n => match.test(n)).map(async n => [n, await fields(`${base}/${n}`, ctx.token)] as const)));
    return NextResponse.json({
      company: ctx.companyName,
      odata: await pick(odata, ctx.odataCompanyBase), custom: await pick(custom, ctx.customApiBase), v2: await pick(v2, ctx.apiBase),
      allOdata: odata, allCustom: custom,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
