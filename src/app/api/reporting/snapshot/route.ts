import { NextResponse } from 'next/server';
import { saveSnapshots } from '@/lib/reporting';

export const dynamic = 'force-dynamic';

// Llamado a diario por Vercel Cron (vercel.json). Si CRON_SECRET está definido, Vercel lo envía como Bearer.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ success: true, ...(await saveSnapshots()) });
  } catch (error: any) {
    console.error('Error saving reporting snapshots:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
