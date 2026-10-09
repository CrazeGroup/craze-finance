import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { saveUsersUpload, StoredUsersUpload } from '@/lib/paymentProposal';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Guarda los Approval / Pending Users leídos en el navegador del Excel de la página 29 (Vendor Ledger Entries)
// de la empresa seleccionada. Provisional, hasta que BC los devuelva por API/OData.
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const body = await req.json();
    if (!Array.isArray(body.rows) || !body.rows.length) return NextResponse.json({ error: 'El fichero no contiene movimientos' }, { status: 400 });
    const upload: StoredUsersUpload = { fileName: String(body.fileName || ''), uploadedAt: new Date().toISOString(), rows: body.rows };
    await saveUsersUpload(company, upload);
    await logAction('Payment Proposal: Excel de Pending Users cargado', `${upload.fileName} · ${upload.rows.length} movimientos`);
    return NextResponse.json({ ok: true, rows: upload.rows.length });
  } catch (error: any) {
    console.error('Error uploading pending users:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
