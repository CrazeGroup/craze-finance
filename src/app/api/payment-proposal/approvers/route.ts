import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { approvers, reminderLog } from '@/lib/approvalReminders';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Correos de los usuarios de BC (aprobadores) y último recordatorio enviado a cada uno
export async function GET() {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Select a specific company.' }, { status: 400 });
    const ctx = await getBcContext(company);
    const [list, log] = await Promise.all([approvers(ctx, company), reminderLog(company)]);
    return NextResponse.json({ approvers: list, log });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
