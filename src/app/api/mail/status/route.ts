import { NextResponse } from 'next/server';
import { sharedMailStatus } from '@/lib/graphMail';

export const dynamic = 'force-dynamic';

// Los recordatorios salen siempre desde el buzón común (invoice@, Graph con permiso de aplicación):
// indica el buzón y si la app tiene el permiso Mail.Send
export async function GET() {
  return NextResponse.json(await sharedMailStatus());
}
