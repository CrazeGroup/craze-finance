import * as XLSX from 'xlsx';
import prisma from '@/lib/prisma';

// Tracking Cierre Mensual: las empresas de la app (Allike va como subempresa de CRAZE GmbH)
export const CLOSING_COMPANIES = ['CRAZE', 'Craze Iberia SL', 'Craze UK', 'CRAZE Group AG', 'Craze Entertainment'];

// Pestaña del Excel de tareas → empresa y subempresa (tabla aparte dentro de la empresa)
const SHEET_COMPANY: Record<string, { company: string; group: string | null }> = {
  gmbh: { company: 'CRAZE', group: null }, iberia: { company: 'Craze Iberia SL', group: null }, uk: { company: 'Craze UK', group: null },
  ag: { company: 'CRAZE Group AG', group: null }, entertainment: { company: 'Craze Entertainment', group: null }, allike: { company: 'CRAZE', group: 'Allike' },
};

// "Jordi" → jordi.osorio@…, "Dani" → daniel.luengo@…; si no hay usuario con ese nombre, el nombre tal cual
export function matchUser(name: string, usernames: string[]) {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const hit = usernames.find(u => {
    const first = u.toLowerCase().split(/[.@]/)[0];
    return first === n || (n.length >= 3 && first.startsWith(n));
  });
  return hit || name.trim();
}

const toDone = (v: any): boolean | null => {
  if (v === true || v === false) return v;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === 'verdadero' || s === 'x' ? true : s === 'false' || s === 'falso' ? false : null;
};

type ParsedTask = { number: number; description: string; assignee: string | null; notes: string | null; cells: { month: number; done: boolean | null; comment: string | null }[] };

// Lee el Excel (una pestaña por empresa: Id, Description, User y los 12 meses en True/False/vacío; los comentarios de
// las celdas de los meses van a la celda y el texto suelto a la derecha de los meses, a las notas de la tarea)
export function parseClosingWorkbook(data: Uint8Array, usernames: string[]) {
  const wb = XLSX.read(data);
  const sheets: { sheet: string; company: string; group: string | null; tasks: ParsedTask[] }[] = [];
  const skipped: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const target = SHEET_COMPANY[sheetName.trim().toLowerCase()];
    if (!target) { skipped.push(sheetName); continue; }
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    const cell = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })];
    // La columna AB (y siguientes) es la lista del desplegable (nombres, True, False): no es de las tareas
    const lastCol = Math.min(range.e.c, 26);
    const tasks: ParsedTask[] = [];
    for (let r = 1; r <= range.e.r; r++) {
      const description = String(cell(r, 1)?.v ?? '').trim();
      if (!description) continue;
      const number = parseInt(String(cell(r, 0)?.v ?? ''), 10) || tasks.length + 1;
      const user = String(cell(r, 2)?.v ?? '').trim();
      const notes: string[] = [];
      for (let c = 15; c <= lastCol; c++) {
        const v = cell(r, c)?.v;
        if (v !== undefined && v !== null && String(v).trim()) notes.push(String(v).trim());
      }
      const cells = Array.from({ length: 12 }, (_, i) => {
        const x = cell(r, 3 + i);
        const comment = (x?.c || []).map((cm: any) => String(cm.t || '').trim()).filter(Boolean).join('\n') || null;
        return { month: i + 1, done: toDone(x?.v), comment };
      }).filter(c => c.done !== null || c.comment);
      tasks.push({ number, description, assignee: user ? matchUser(user, usernames) : null, notes: notes.join(' · ') || null, cells });
    }
    sheets.push({ sheet: sheetName, ...target, tasks });
  }
  return { sheets, skipped };
}

// Importa el Excel: sustituye las tareas de ese año de cada empresa (o subempresa) que viene en el fichero
export async function importClosingWorkbook(data: Uint8Array, year: number, author: string | null) {
  const usernames = (await prisma.user.findMany({ select: { username: true } })).map(u => u.username).filter(u => u !== 'admin');
  const { sheets, skipped } = parseClosingWorkbook(data, usernames);
  for (const { company, group, tasks } of sheets) {
    await prisma.$transaction(async tx => {
      await tx.closingTask.deleteMany({ where: { companyId: company, year, group } });
      for (const [i, t] of tasks.entries()) {
        await tx.closingTask.create({
          data: {
            companyId: company, year, group, number: t.number, sortOrder: i, description: t.description, assignee: t.assignee, notes: t.notes,
            cells: { create: t.cells.map(c => ({ ...c, updatedBy: author })) },
          },
        });
      }
    }, { timeout: 60000 });
  }
  return { summary: sheets.map(s => ({ sheet: s.sheet, company: s.company, group: s.group, tasks: s.tasks.length })), skipped };
}
