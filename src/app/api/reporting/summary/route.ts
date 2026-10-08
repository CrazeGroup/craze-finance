import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { generateSummary, SummaryLang, SummaryView } from '@/lib/reporting/summary';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Puntos clave con IA. Body: { view, lang, month, data, force? } (data = cifras ya calculadas en la página)
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const { view, lang, month, data, force } = await req.json();
    if (!['operational', 'management'].includes(view) || !['es', 'en', 'de'].includes(lang) || !data) {
      return NextResponse.json({ error: 'Petición no válida' }, { status: 400 });
    }
    return NextResponse.json(await generateSummary(view as SummaryView, lang as SummaryLang, month, company, data, !!force));
  } catch (error: any) {
    console.error('Error in reporting summary:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
