import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { checkTariffs, CustomsPosition } from '@/lib/customs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Compara los códigos arancelarios de las posiciones de una declaración con el Tariff No. de los artículos de su
// factura de China (body: { orders: N380[], positions }). Solo lectura.
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const { orders, positions } = await req.json() as { orders: string[]; positions: CustomsPosition[] };
    const ctx = await getBcContext(company);
    return NextResponse.json(await checkTariffs(ctx, orders || [], positions || []));
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
