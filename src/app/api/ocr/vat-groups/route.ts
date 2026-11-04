import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { vatGroups } from '@/lib/ocr';

export const dynamic = 'force-dynamic';

// GET: VAT Product Posting Groups de la empresa activa (selector de Grupo IVA en OCR)
export async function GET() {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ groups: [] });
    return NextResponse.json({ groups: await vatGroups(await getBcContext(company)) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
