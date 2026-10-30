import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { searchVendors } from '@/lib/ocr';

export const dynamic = 'force-dynamic';

// GET ?q=: proveedores de la empresa por nº o nombre (para elegirlo a mano en OCR)
export async function GET(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ vendors: [] });
    const term = new URL(req.url).searchParams.get('q') || '';
    return NextResponse.json({ vendors: await searchVendors(await getBcContext(company), term) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
