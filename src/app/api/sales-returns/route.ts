import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { salesReturns, SalesReturn } from '@/lib/salesReturns';
import { GROUP_COMPANIES } from '@/lib/royalties';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Sales Return Orders abiertas de la empresa del menú (ALL = todas las del grupo), con sus comentarios
export async function GET() {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    const companies = company === 'ALL' ? GROUP_COMPANIES : [company];
    const results = await Promise.all(companies.map(c => salesReturns(c).then(r => ({ c, ...r, error: null as string | null }))
      .catch((e: any) => ({ c, rows: [] as SalesReturn[], commentsError: null as string | null, error: String(e.message || e) }))));
    const errors = results.filter(r => r.error).map(r => `${r.c}: ${r.error}`);
    if (errors.length === companies.length) return NextResponse.json({ error: errors.join(' · ') }, { status: 500 });
    return NextResponse.json({
      rows: results.flatMap(r => r.rows),
      errors,
      commentsError: results.find(r => r.commentsError)?.commentsError || null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
