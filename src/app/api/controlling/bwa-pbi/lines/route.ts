import { NextResponse } from 'next/server';
import { documentLines } from '@/lib/controlling/bwaPbiDetail';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const KINDS = ['purchInv', 'purchCrMemo', 'salesInv', 'salesCrMemo'] as const;

// Líneas (artículos) de un documento registrado: /api/controlling/bwa-pbi/lines?company=&doc=&kind=purchInv
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const company = searchParams.get('company') || '';
    const doc = searchParams.get('doc') || '';
    const kind = searchParams.get('kind') as typeof KINDS[number];
    if (!company || !doc || !KINDS.includes(kind)) return NextResponse.json({ error: 'Parámetros no válidos' }, { status: 400 });
    return NextResponse.json({ lines: await documentLines(company, doc, kind) });
  } catch (error: any) {
    console.error('Error in BWA document lines:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
