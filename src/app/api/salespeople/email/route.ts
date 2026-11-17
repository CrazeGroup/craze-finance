import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext, bcFetchAll } from '@/lib/bcClient';

export const dynamic = 'force-dynamic';

// Email del comercial (Salesperson/Purchaser de BC, v2 salespeoplePurchasers) por código o nombre,
// para ponerlo en copia de los recordatorios a clientes.
export async function GET(req: NextRequest) {
  const code = (req.nextUrl.searchParams.get('code') || '').trim();
  const name = (req.nextUrl.searchParams.get('name') || '').trim().toLowerCase();
  if (!code && !name) return NextResponse.json({ email: '' });
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const ctx = await getBcContext(company === 'ALL' ? 'CRAZE' : company);
    const rows = await bcFetchAll(`${ctx.apiBase}/salespeoplePurchasers?$select=code,displayName,email,email2`, ctx.token);
    const r = rows.find((x: any) => code && String(x.code) === code) || rows.find((x: any) => name && String(x.displayName || '').toLowerCase() === name);
    return NextResponse.json({ email: r?.email || r?.email2 || '', name: r?.displayName || '' });
  } catch (e: any) {
    return NextResponse.json({ email: '', error: e.message });
  }
}
