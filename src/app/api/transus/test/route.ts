import { NextResponse } from 'next/server';
import { transusCall, transusCredentials } from '@/lib/transus';

export const dynamic = 'force-dynamic';

// Prueba de credenciales de Transus WebConnect sin enviar ni confirmar nada.
// M10110 (recibir) con una clave falsa (esperado ExitCode 10) y con la real (0). Si hay un mensaje pendiente NO se
// confirma (M10300): según la guía de Transus vuelve a presentarse hasta que alguien informe su estado, así BC lo
// recoge como siempre. Del mensaje solo se devuelve el tipo (primer elemento XML / segmento), no su contenido.
const kindOf = (b64: string) => {
  if (!b64) return null;
  const text = Buffer.from(b64, 'base64').toString('latin1');
  const xmlRoot = text.replace(/<\?xml[^>]*\?>/, '').match(/<([A-Za-z_][\w:.-]*)/)?.[1];
  const edifact = text.match(/UNH\+[^+]*\+([A-Z]{6})/)?.[1];
  return { bytes: text.length, format: xmlRoot ? 'XML' : edifact ? 'EDIFACT' : 'other', type: xmlRoot || edifact || text.substring(0, 12) };
};

export async function GET(req: Request) {
  const creds = transusCredentials();
  if (!creds) return NextResponse.json({ error: 'Faltan TRANSUS_CLIENT_ID / TRANSUS_CLIENT_KEY en este entorno' }, { status: 500 });
  // ?confirmTest=1: confirma (Delivered) SOLO el mensaje de prueba de Transus ("Test communication"), para que no
  // bloquee la cola de BC; cualquier otro mensaje se deja sin tocar.
  if (new URL(req.url).searchParams.get('confirmTest') === '1') {
    const got = await transusCall('M10110', {});
    const text = got.fields?.Message ? Buffer.from(got.fields.Message, 'base64').toString('latin1') : '';
    if (got.fields?.ExitCode !== '0' || !got.fields?.TransactionID || !/^This is a test/i.test(text)) {
      return NextResponse.json({ confirmed: false, exitCode: got.fields?.ExitCode, hasMessage: !!text, isTest: /^This is a test/i.test(text) });
    }
    await new Promise(r => setTimeout(r, 1500));
    const conf = await transusCall('M10300', { TransactionID: got.fields.TransactionID, Status: '0', StatusDetails: '' });
    return NextResponse.json({ confirmed: conf.fields?.ExitCode === '0', exitCode: conf.fields?.ExitCode, text });
  }
  const wrong = await transusCall('M10110', {}, { clientId: creds.clientId, clientKey: 'wrong-key-test' }).catch(e => ({ error: e.message } as any));
  await new Promise(r => setTimeout(r, 1500));
  const real = await transusCall('M10110', {}).catch(e => ({ error: e.message } as any));
  const msg = real.fields?.Message || '';
  return NextResponse.json({
    wrongKey: { exitCode: wrong.fields?.ExitCode, fault: wrong.fault, error: wrong.error },
    real: { exitCode: real.fields?.ExitCode, hasMessage: !!msg, transactionId: real.fields?.TransactionID ? 'present' : null, message: kindOf(msg), fault: real.fault, error: real.error },
    meaning: { '0': 'OK', '10': 'Client ID, key or IP invalid', '20': 'Access denied', '90': 'Restriction', '99': 'Error' },
  });
}
