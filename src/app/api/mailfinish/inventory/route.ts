import { NextResponse } from 'next/server';
import { getBcContext } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { mailfinishInventory } from '@/lib/mailfinishInventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const COMPANY = 'Craze Entertainment';

// Inventario de fin de mes que informa Mailfinish (Excel de las facturas de almacenaje) contra el stock de BC
// en MAILFINISH / DESTR MAIL. ?year=2026[&force=1]. Solo lectura, solo Craze Entertainment.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const year = /^\d{4}$/.test(searchParams.get('year') || '') ? searchParams.get('year')! : String(new Date().getFullYear());
    const force = searchParams.get('force') === '1';
    const data = await cached(`mfInventory2:${year}`, 6 * HOUR, async () => mailfinishInventory(await getBcContext(COMPANY), year), force);
    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Mailfinish inventory:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
