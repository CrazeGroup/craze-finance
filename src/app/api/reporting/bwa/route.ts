import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { parseMonths } from '@/lib/reporting';

export const dynamic = 'force-dynamic';

const MONTH_KEYS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type BwaRow = { group: string; level: string; period: number; ytd: number };

// Filas del BWA con el importe de los meses seleccionados y el acumulado desde enero
function summarize(data: any[], periodKeys: string[], ytdKeys: string[]): BwaRow[] {
  return data.map(entry => {
    const values = entry.Values || {};
    const sum = (keys: string[]) => keys.reduce((s, k) => s + (Number(values[k]) || 0), 0);
    return { group: entry.BwaGroup || '', level: entry.Level || '', period: sum(periodKeys), ytd: sum(ytdKeys) };
  });
}

// Usa el último BWA subido de cada empresa (pantalla BWA Analytics)
export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const months = parseMonths(new URL(req.url).searchParams.get('months'));
    if (months.length === 0) return NextResponse.json({ error: 'Selecciona al menos un mes.' }, { status: 400 });

    const periodKeys = months.map(m => MONTH_KEYS[Number(m.substring(5, 7)) - 1]);
    const lastMonthIndex = Number(months[months.length - 1].substring(5, 7));
    const ytdKeys = MONTH_KEYS.slice(0, lastMonthIndex);

    const reports = await prisma.bwaReport.findMany({ orderBy: { date: 'desc' } });
    const latestByCompany = new Map<string, typeof reports[number]>();
    for (const r of reports) if (!latestByCompany.has(r.companyId)) latestByCompany.set(r.companyId, r);

    const own = latestByCompany.get(companyId);
    const company = own
      ? { reportDate: own.date, rows: summarize(JSON.parse(own.data), periodKeys, ytdKeys) }
      : null;

    // Consolidado de todas las empresas: solo en CRAZE (o en la vista de todas las empresas)
    let consolidated = null;
    if (companyId.toUpperCase() === 'CRAZE' || companyId === 'ALL') {
      const merged = new Map<string, BwaRow>();
      // Empezar por CRAZE para respetar el orden de su estructura
      const ordered = Array.from(latestByCompany.values()).sort((a, b) =>
        (a.companyId.toUpperCase() === 'CRAZE' ? -1 : 0) - (b.companyId.toUpperCase() === 'CRAZE' ? -1 : 0));
      for (const report of ordered) {
        for (const row of summarize(JSON.parse(report.data), periodKeys, ytdKeys)) {
          const key = `${row.group}|${row.level}`;
          const acc = merged.get(key);
          if (acc) {
            acc.period += row.period;
            acc.ytd += row.ytd;
          } else {
            merged.set(key, { ...row });
          }
        }
      }
      consolidated = {
        companies: ordered.map(r => ({ companyId: r.companyId, reportDate: r.date })),
        rows: Array.from(merged.values()),
      };
    }

    return NextResponse.json({ company, consolidated });
  } catch (error: any) {
    console.error('Error in reporting BWA:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
