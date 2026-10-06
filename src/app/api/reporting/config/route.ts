import { NextResponse } from 'next/server';
import { getReportingConfig, saveReportingConfig } from '@/lib/reporting';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await getReportingConfig());
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const config = await saveReportingConfig(await req.json());
    await logAction('Configuración Reporting', `Cuentas provisiones: ${config.provisionAccounts.join(', ')}; Servicio: ${config.valueEntriesService}`);
    return NextResponse.json(config);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
