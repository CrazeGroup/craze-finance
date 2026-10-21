import * as XLSX from 'xlsx';

// Lectura de la "Jahresübersicht" (BWA) de DATEV: columnas Zeile, Konto, Zeilen-/Kontobezeichnung, un mes por columna
// ("Jan/2025", "Mrz/2025"…) y el acumulado. Las filas de apartado llevan un código de 4 cifras en Zeile (1020
// Umsatzerlöse, 1100 Personalkosten…) y las de cuenta un nº de 6 cifras (602000 = cuenta 6020 00 de BC).
export type DatevAccount = { account: string; name: string; section: string; values: number[] };
export type DatevFile = { name: string; year: number; months: number; accounts: DatevAccount[]; sections: Record<string, string> };

const MONTHS = ['jan', 'feb', 'mrz', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'];

export async function parseDatev(file: File): Promise<DatevFile> {
  const wb = XLSX.read(await file.arrayBuffer());
  const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  const h = rows.findIndex(r => r.some(c => /^konto$/i.test(String(c).trim())));
  if (h < 0) throw new Error('No es una Jahresübersicht de DATEV: no se encuentra la columna "Konto".');
  const header = rows[h].map(c => String(c).trim().toLowerCase());
  // Columnas de mes (en orden) y año
  const monthCols: { col: number; m: number; y: number }[] = [];
  header.forEach((c, col) => {
    const mm = c.match(/^([a-zäö]{3})\/(\d{4})$/);
    if (mm && MONTHS.includes(mm[1])) monthCols.push({ col, m: MONTHS.indexOf(mm[1]), y: Number(mm[2]) });
  });
  if (!monthCols.length) throw new Error('No se encuentran columnas de mes (Jan/2025, Feb/2025…).');
  const year = monthCols[0].y;
  const months = Math.max(...monthCols.map(c => c.m)) + 1;
  const konto = header.findIndex(c => c === 'konto');
  const nameCol = header.findIndex(c => c.includes('bezeichnung'));
  const sections: Record<string, string> = {};
  const accounts: DatevAccount[] = [];
  let section = '';
  const zeile = Math.max(0, header.findIndex(c => c === 'zeile'));
  for (const r of rows.slice(h + 1)) {
    const code = String(r[zeile]).trim();
    if (/^\d{4}$/.test(code)) { section = code; sections[code] = String(r[nameCol] || '').trim(); continue; }
    const acc = String(r[konto] || '').trim();
    if (!/^\d{6}$/.test(acc)) continue;
    const values = Array.from({ length: months }, () => 0);
    for (const mc of monthCols) values[mc.m] = Number(r[mc.col]) || 0;
    accounts.push({ account: acc, name: String(r[nameCol] || '').trim(), section, values });
  }
  if (!accounts.length) throw new Error('El Excel no tiene filas de cuenta (nº de 6 cifras).');
  return { name: file.name, year, months, accounts, sections };
}
