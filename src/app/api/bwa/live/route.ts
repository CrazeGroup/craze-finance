import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { bwaAnalytics } from '@/lib/bwaAnalytics';
import { companyCurrency } from '@/lib/royalties';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// BWA Analytics en directo de BC: /api/bwa/live?year=2026[&force=1]
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const year = Number(searchParams.get('year')) || new Date().getFullYear();
    const ctx = await getBcContext(company);
    const data = await bwaAnalytics(ctx, company, year, searchParams.get('force') === '1');
    return NextResponse.json({ ...data, currency: companyCurrency(company) });
  } catch (error: any) {
    console.error('Error in BWA live:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
