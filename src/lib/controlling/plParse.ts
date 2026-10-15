import * as XLSX from 'xlsx';

// Lectura de un Excel de cuenta de resultados (BWA / Profit & Loss) con una fila por concepto y una columna por mes.
// Admite la BWA de DATEV (alemán, "Jan/2025", fechas de Excel, gastos en positivo) y la BWA del grupo exportada
// de Power BI (inglés, "Jan"…"Dec", gastos en negativo). Se normaliza el signo: ingresos +, gastos −.

export type PlRow = { label: string; values: (number | null)[]; total: number };
export type PlFile = { name: string; year: number | null; format: 'datev' | 'generic'; months: boolean[]; rows: PlRow[]; uploadedAt: string };

const MONTHS: Record<string, number> = {
  jan: 0, ene: 0, januar: 0, january: 0, enero: 0,
  feb: 1, februar: 1, february: 1, febrero: 1,
  mar: 2, mär: 2, mrz: 2, märz: 2, march: 2, marzo: 2,
  apr: 3, abr: 3, april: 3, abril: 3,
  may: 4, mai: 4, mayo: 4,
  jun: 5, juni: 5, june: 5, junio: 5,
  jul: 6, juli: 6, july: 6, julio: 6,
  aug: 7, ago: 7, august: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, septiembre: 8,
  oct: 9, okt: 9, oktober: 9, october: 9, octubre: 9,
  nov: 10, november: 10, noviembre: 10,
  dec: 11, dez: 11, dic: 11, dezember: 11, december: 11, diciembre: 11,
};

// Mes (0-11) y año de una cabecera: "Jan", "Mrz/2025", "Sep 2026" o fecha de Excel (nº de serie)
function monthOf(cell: any): { m: number; y: number | null } | null {
  if (typeof cell === 'number' && cell > 30000 && cell < 80000) {
    const d = XLSX.SSF.parse_date_code(cell);
    return d ? { m: d.m - 1, y: d.y } : null;
  }
  if (cell instanceof Date) return { m: cell.getMonth(), y: cell.getFullYear() };
  const s = String(cell ?? '').trim().toLowerCase();
  const match = s.match(/^([a-zäé]+)\.?\s*[\/\-\s]?\s*(\d{2,4})?$/);
  if (!match || !(match[1] in MONTHS)) return null;
  const y = match[2] ? Number(match[2].length === 2 ? `20${match[2]}` : match[2]) : null;
  return { m: MONTHS[match[1]], y };
}

// Filas de gasto de la BWA de DATEV (vienen en positivo)
const DATEV_COST = /einkauf|kosten|aufwand|abschreibung|steuern|versicherung|instandhaltung/i;

export function parsePl(buffer: ArrayBuffer, name: string): PlFile {
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const text = rows.slice(0, 5).flat().map(c => String(c)).join(' ');
  const format: PlFile['format'] = /DATEV|Betriebswirtschaftliche/i.test(text) ? 'datev' : 'generic';

  // Fila de cabecera: la primera con al menos 3 meses
  let headerIdx = -1;
  let cols: { col: number; m: number }[] = [];
  let year: number | null = null;
  for (let i = 0; i < Math.min(rows.length, 30) && headerIdx < 0; i++) {
    const found = rows[i].map((c, col) => ({ col, mo: monthOf(c) })).filter(x => x.mo);
    if (found.length >= 3) {
      headerIdx = i;
      cols = found.map(x => ({ col: x.col, m: x.mo!.m }));
      year = found.map(x => x.mo!.y).find(y => y) ?? null;
    }
  }
  if (headerIdx < 0) throw new Error('No se encuentra la fila de meses (Jan, Feb… o Jan/2025…) en el Excel.');
  if (!year) {
    const y = name.match(/\b(20\d{2})\b/) || text.match(/\b(20\d{2})\b/);
    year = y ? Number(y[1]) : null;
  }

  const out: PlRow[] = [];
  const months = Array(12).fill(false);
  for (const r of rows.slice(headerIdx + 1)) {
    const label = String(r[0] ?? '').trim();
    if (!label || label === '%' || /^filtros aplicados/i.test(label)) continue;
    const values: (number | null)[] = Array(12).fill(null);
    let any = false;
    for (const { col, m } of cols) {
      const v = r[col];
      if (typeof v === 'number' && isFinite(v)) { values[m] = (values[m] || 0) + v; any = true; }
    }
    if (!any) continue;
    const sign = format === 'datev' && DATEV_COST.test(label) && !/verrechnete|ergebnis/i.test(label) ? -1 : 1;
    const signed = values.map(v => (v === null ? null : v * sign));
    signed.forEach((v, m) => { if (v !== null && v !== 0) months[m] = true; });
    out.push({ label, values: signed, total: signed.reduce((s: number, v) => s + (v || 0), 0) });
  }
  if (!out.length) throw new Error('El Excel no tiene filas con importes por mes.');
  return { name, year, format, months, rows: out, uploadedAt: new Date().toISOString() };
}
