import { NextResponse } from 'next/server';
import { transusCall, transusCredentials } from '@/lib/transus';

export const dynamic = 'force-dynamic';

// Prueba de conexión sin enviar ni recoger mensajes: confirmación (M10300) de una transacción inexistente,
// con las credenciales reales y con una clave falsa, para ver si Transus distingue las credenciales válidas.
export async function GET() {
  const creds = transusCredentials();
  if (!creds) return NextResponse.json({ error: 'Faltan TRANSUS_CLIENT_ID / TRANSUS_CLIENT_KEY en este entorno' }, { status: 500 });
  const fields = { TransactionID: '0', Status: '0', StatusDetails: 'connection test', ExitCode: '' };
  const [real, wrong] = await Promise.all([
    transusCall('M10300', fields).catch(e => ({ error: e.message })),
    transusCall('M10300', fields, { clientId: creds.clientId, clientKey: 'wrong-key-test' }).catch(e => ({ error: e.message })),
  ]);
  return NextResponse.json({ clientIdLength: creds.clientId.length, real, wrongKey: wrong });
}
