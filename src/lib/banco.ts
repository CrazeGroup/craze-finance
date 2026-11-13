import { bcFetchAll, odataUrl, type BcContext } from '@/lib/bcClient';
import { bcRequest } from '@/lib/bcWrite';
import * as XLSX from 'xlsx';

// BANCO: extracto del banco en CSV (CSV-CAMT de Sparkasse…) o Excel (.xls/.xlsx: Sabadell…) → movimientos que aún no están en las Bank Account Ledger
// Entries de la cuenta → sugerencia de líneas para el General Journal (lote con esa cuenta de banco como contrapartida).
// - Cuadre: cada movimiento con un movimiento de banco del mismo importe (±7 días) o con varios del mismo nº de
//   documento que suman su importe (cobros repartidos por factura, comisiones descontadas…).
// - Sugerencia, por orden: lo que se hizo con la misma contrapartida (IBAN o nombre) en los movimientos del extracto
//   que ya están registrados; las facturas abiertas citadas en el concepto; el cliente o proveedor con ese nombre.

export type Movement = {
  idx: number; date: string; valueDate: string; text: string; purpose: string; name: string; iban: string;
  endToEnd: string; amount: number; pending: boolean; account: string;
  // Saldo de la cuenta tras el movimiento, si el extracto lo trae (columna Saldo / Kontostand)
  balance?: number;
  // Pago colectivo (Acrevis "Belast. E-Banking (3 Transaktionen)" y debajo una fila por pago, "1. Westhive…"): el detalle
  // lleva el idx de la fila del total
  group?: number;
};
export type LedgerEntry = {
  entryNo: number; date: string; docNo: string; description: string; amount: number; balType: string; balNo: string;
  reversed?: boolean;
};
export type AppliesType = 'Invoice' | 'Credit Memo' | 'Payment' | 'Refund';
export type AccountType = 'G/L Account' | 'Customer' | 'Vendor' | 'Bank Account';
export type SuggestedLine = {
  accountType: AccountType | ''; accountNo: string; accountName: string; description: string;
  amount: number; appliesToDocType?: AppliesType; appliesToDocNo?: string;
};
export type Suggestion = { documentNo: string; source: string; note: string; lines: SuggestedLine[] };
export type MovementResult = Movement & {
  status: 'posted' | 'batch' | 'new';
  matched: { docNo: string; date: string; description: string; balType: string; balNo: string; amount: number }[];
  suggestion: Suggestion | null;
  doubtful?: boolean;
  // Sin movimiento de banco que cuadre, pero BC tiene el mismo saldo que el extracto en una fecha posterior o igual
  byBalance?: boolean;
};
export type OpenEntry = { side: 'Customer' | 'Vendor'; no: string; name: string; docType: string; docNo: string; extDocNo: string; remaining: number };
export type Party = { side: 'Customer' | 'Vendor'; no: string; name: string };
export type BatchLine = { date: string; bankAmount: number; docNo: string; description: string };

const WINDOW_DAYS = 7;
const cents = (v: number) => Math.round(v * 100);
const r2 = (v: number) => Math.round(v * 100) / 100;
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const q = (s: string) => s.replace(/'/g, "''");

// ---------- CSV ----------

function splitCsvLine(line: string, sep: string) {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Fecha de una celda: Date (Excel), nº de serie de Excel, "03.11.26", "03/11/2026", "2026-11-03" → "2026-11-03"
function cellDate(v: unknown) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  // Nº de serie de Excel, sin zona horaria (con cellDates los .xls salían un día antes)
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (!m) return '';
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
// Importe de una celda: número, "-1.234,56", "1,234.56", "-12.50", "1.234 €" → -1234.56…
function cellNumber(v: unknown) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[^\d,.\-+]/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lastComma >= 0) s = /,\d{3}$/.test(s) && s.split(',').length > 2 ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) s = s.replace(/\./g, '');
  return parseFloat(s);
}

// Nombres de columna de los bancos (Sparkasse CSV-CAMT, Sabadell, Santander, BBVA, inglés…), sin acentos ni ":"
const COLUMNS = {
  account: ['auftragskonto', 'cuenta', 'numero de cuenta', 'account'],
  date: ['buchungstag', 'buchungsdatum', 'datum', 'fecha', 'fecha operacion', 'fecha operativa', 'f. operativa', 'fecha contable', 'f. contable', 'fecha de operacion', 'booking date', 'date', 'transaction date'],
  value: ['valutadatum', 'valuta', 'wertstellung', 'fecha valor', 'f. valor', 'value date'],
  text: ['buchungstext', 'tipo', 'tipo de movimiento', 'booking text', 'type'],
  purpose: ['verwendungszweck', 'concepto', 'descripcion', 'concepto comun', 'description', 'details', 'reference'],
  extra: ['mas datos', 'concepto propio', 'referencia 1', 'referencia 2', 'referencia', 'observaciones', 'informacion adicional'],
  name: ['beguenstigter/zahlungspflichtiger', 'begunstigter/zahlungspflichtiger', 'ordenante', 'beneficiario', 'ordenante/beneficiario', 'nombre', 'name', 'counterparty', 'payee'],
  iban: ['kontonummer/iban', 'kontonummer', 'iban', 'iban contrapartida'],
  e2e: ['kundenreferenz (end-to-end)', 'end-to-end'],
  amount: ['betrag', 'importe', 'importe (eur)', 'importe eur', 'amount', 'cantidad', 'betrag (eur)'],
  debit: ['cargo', 'cargos', 'debe', 'soll', 'debit', 'ausgang', 'belastung', 'lastschrift'],
  credit: ['abono', 'abonos', 'haber', 'haben', 'credit', 'eingang', 'gutschrift'],
  info: ['info', 'estado', 'status'],
  balance: ['saldo', 'kontostand', 'saldo nach buchung', 'balance', 'running balance'],
};
const normHead = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[:*]+$/, '').replace(/\s+/g, ' ').trim();

// Movimientos de una tabla (filas × celdas) de CSV o Excel: la cabecera es la primera fila (de las 40 primeras) con
// columna de fecha y de importe (o de cargo/abono); los bancos ponen antes el titular, la cuenta, el periodo…
function parseBankRows(rows: unknown[][]): Movement[] {
  let h = -1;
  let c: Record<keyof typeof COLUMNS, number> | null = null;
  // Columnas que completan el concepto (Sabadell: Más datos, Referencia 1, Referencia 2), todas
  let extras: number[] = [];
  for (let i = 0; i < Math.min(rows.length, 40) && !c; i++) {
    const head = (rows[i] || []).map(normHead);
    const col = (k: keyof typeof COLUMNS) => head.findIndex(x => COLUMNS[k].includes(x));
    const found = Object.fromEntries(Object.keys(COLUMNS).map(k => [k, col(k as keyof typeof COLUMNS)])) as Record<keyof typeof COLUMNS, number>;
    if (found.date >= 0 && (found.amount >= 0 || (found.debit >= 0 && found.credit >= 0))) {
      h = i; c = found;
      extras = head.map((x, j) => (COLUMNS.extra.includes(x) ? j : -1)).filter(j => j >= 0);
    }
  }
  if (!c) throw new Error('No se reconoce el formato: no hay una fila con columnas de fecha e importe (p. ej. Buchungstag/Betrag, Fecha/Importe o Cargo/Abono).');
  const cols = c;
  const get = (row: unknown[], i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
  // Si la fila de cabecera tiene la cuenta encima (Sabadell: "Cuenta: ES12 …"), es la del extracto
  const above = rows.slice(0, h).flat().map(x => String(x ?? '')).join(' ').match(/\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){4,7}(?:\s?[A-Z0-9]{1,3})?)\b/)?.[1] || '';
  // Columna IBAN con el mismo valor en todas las filas (Acrevis: la cuenta del extracto, no la contrapartida)
  const ibans = new Set(rows.slice(h + 1).map(row => get(row, cols.iban)).filter(Boolean));
  const ownIban = cols.account < 0 && ibans.size === 1 && rows.length - h > 2 ? Array.from(ibans)[0] : '';
  return rows.slice(h + 1).map((row, idx) => {
    // Sin columna de concepto, el texto puede venir en varias líneas (Acrevis: "Belastung LSV+ SALT MOBILE SA",
    // el nombre, la dirección, "Zahlungszweck: …", "Referenznummer: …"): 1ª línea = texto, 2ª = nombre, el resto = concepto
    const lines = cols.purpose < 0 ? get(row, cols.text).split(/\r?\n/).map(x => x.trim()).filter(Boolean) : [];
    // Pago de un colectivo: "1. <nombre>", la dirección y "Zahlungszweck: …" (sin texto propio)
    const part = lines[0]?.match(/^\d+\.\s+(.+)$/);
    if (part) lines.splice(0, 1, '', part[1]);
    const multi = lines.length > 1;
    const amount = cols.amount >= 0 ? cellNumber(row[cols.amount]) : (cellNumber(row[cols.credit]) || 0) - Math.abs(cellNumber(row[cols.debit]) || 0);
    const balance = cols.balance >= 0 ? cellNumber(row[cols.balance]) : NaN;
    const purpose = [get(row, cols.purpose), ...(multi ? lines.slice(1) : []), ...extras.map(j => get(row, j))].filter(Boolean).join(' ');
    return {
      idx, date: cellDate(row[cols.date]), valueDate: cellDate(row[cols.value]), text: multi ? lines[0] : get(row, cols.text),
      purpose: purpose.replace(/\s+/g, ' '), name: get(row, cols.name) || (multi ? lines[1] : ''),
      iban: ownIban ? '' : get(row, cols.iban).replace(/\s/g, '').toUpperCase(),
      endToEnd: get(row, cols.e2e), amount, pending: /vorgemerkt|pendiente/i.test(get(row, cols.info)),
      account: (get(row, cols.account) || ownIban || above).replace(/\s/g, '').toUpperCase(),
      ...(Number.isFinite(balance) ? { balance } : {}),
    };
  }).filter(m => m.date && Number.isFinite(m.amount) && m.amount !== 0).map((m, idx) => ({ ...m, idx }))
    .map((m, i, all) => {
      if (m.text) return m;
      // Detalle de un pago colectivo: el total es la fila anterior con texto "(N Transaktionen)" del mismo día
      let j = i - 1;
      while (j >= 0 && !all[j].text) j--;
      return j >= 0 && /\(\d+ Transaktion(en)?\)/i.test(all[j].text) && all[j].date === m.date ? { ...m, group: all[j].idx, text: all[j].text } : m;
    });
}

// Pagos colectivos: BC unas veces los tiene registrados por el total y otras pago a pago. Si el total cuadra con BC, se
// quitan sus pagos; si no, se quita el total y quedan los pagos (cuadrados o para registrar cada uno a su proveedor)
export function collapseGroups<T extends Movement>(movements: T[], matched: Map<number, unknown>): T[] {
  const heads = new Set(movements.filter(m => m.group != null).map(m => m.group!));
  return movements.filter(m => (m.group != null ? !matched.has(m.group) : !heads.has(m.idx) || matched.has(m.idx)));
}

export function parseBankCsv(text: string): Movement[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('El fichero está vacío.');
  const sep = [';', '\t', ','].find(x => lines.slice(0, 40).some(l => l.includes(x))) || ';';
  return parseBankRows(lines.map(l => splitCsvLine(l, sep)));
}

// Extracto CSV o Excel (.xls/.xlsx, la primera hoja con movimientos)
export function parseBankFile(bytes: Uint8Array, fileName: string): Movement[] {
  if (/\.xlsx?$/i.test(fileName) || (bytes[0] === 0x50 && bytes[1] === 0x4b) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    const wb = XLSX.read(bytes, { type: 'array' });
    let error: unknown = null;
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '' });
      try {
        const out = parseBankRows(rows);
        if (out.length) return out;
      } catch (e) { error = e; }
    }
    if (error) throw error;
    return [];
  }
  // Los CSV de Sparkasse vienen en ISO-8859-1; si es UTF-8 válido se lee como UTF-8
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('latin1').decode(bytes); }
  return parseBankCsv(text);
}

// ---------- BC ----------

export async function bankLedgerEntries(ctx: BcContext, bankNo: string, from: string): Promise<LedgerEntry[]> {
  const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Bank_Account_Ledger_Entries_Excel`, {
    $filter: `Bank_Account_No eq '${q(bankNo)}' and Posting_Date ge ${from}`,
    $select: 'Entry_No,Posting_Date,Document_No,Description,Amount,Bal_Account_Type,Bal_Account_No,Reversed',
  }), ctx.token);
  // Un movimiento anulado y su anulación no cuentan como registrados (reversed: solo para aprender de las correcciones)
  return rows.map((r: any) => ({
    entryNo: r.Entry_No, date: r.Posting_Date, docNo: String(r.Document_No || ''), description: String(r.Description || ''),
    amount: Number(r.Amount) || 0, balType: String(r.Bal_Account_Type || ''), balNo: String(r.Bal_Account_No || ''), reversed: !!r.Reversed,
  }));
}

// Saldo de la cuenta en BC antes de una fecha (suma de todos sus movimientos anteriores)
export async function bankBalanceBefore(ctx: BcContext, bankNo: string, date: string): Promise<number> {
  const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Bank_Account_Ledger_Entries_Excel`, {
    $filter: `Bank_Account_No eq '${q(bankNo)}' and Posting_Date lt ${date}`, $select: 'Amount',
  }), ctx.token);
  return rows.reduce((t: number, r: any) => t + (Number(r.Amount) || 0), 0);
}

// Cuadre por saldo: la última fecha del extracto en la que el saldo del banco (al cierre del día) es igual al de BC.
// Hasta esa fecha todo está registrado en BC, aunque sea con otra fecha, otro importe o agrupado.
// history: todos los movimientos de BC desde start (incluidos los anulados, que se compensan con su anulación)
export function balanceCutoff(movements: Movement[], history: LedgerEntry[], opening: number, start: string) {
  const withBal = movements.filter(m => m.balance != null && !m.pending);
  if (!withBal.length) return null;
  // Orden cronológico (los extractos suelen venir del más nuevo al más antiguo)
  const chrono = movements[0].date > movements[movements.length - 1].date ? [...withBal].reverse() : withBal;
  const eod = new Map<string, number>();
  for (const m of chrono) eod.set(m.date, m.balance!);
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const bcAt = (d: string) => r2(opening + sorted.filter(e => e.date <= d).reduce((t, e) => t + e.amount, 0));
  const dates = Array.from(eod.keys()).filter(d => d >= start).sort().reverse();
  if (!dates.length) return null;
  const last = { date: dates[0], bank: r2(eod.get(dates[0])!), bc: bcAt(dates[0]) };
  const until = dates.find(d => cents(eod.get(d)!) === cents(bcAt(d)));
  return { until: until || '', balance: until ? r2(eod.get(until)!) : 0, last };
}

export async function openEntries(ctx: BcContext): Promise<OpenEntry[]> {
  const [cust, vend] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.customApiBase}/custLedgerEntries`, { $filter: 'open eq true', $select: 'customerNo,customerName,documentType,documentNo,externalDocumentNo,remainingAmount' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, { $filter: 'open eq true', $select: 'vendorNo,vendorName,documentType,documentNo,externalDocumentNo,remainingAmount' }), ctx.token),
  ]);
  const docType = (t: string) => String(t || '').replace(/_x0020_/g, ' ');
  return [
    ...cust.map((r: any) => ({ side: 'Customer' as const, no: r.customerNo, name: r.customerName, docType: docType(r.documentType), docNo: String(r.documentNo || ''), extDocNo: String(r.externalDocumentNo || ''), remaining: Number(r.remainingAmount) || 0 })),
    ...vend.map((r: any) => ({ side: 'Vendor' as const, no: r.vendorNo, name: r.vendorName, docType: docType(r.documentType), docNo: String(r.documentNo || ''), extDocNo: String(r.externalDocumentNo || ''), remaining: Number(r.remainingAmount) || 0 })),
  ];
}

export async function journalByCode(ctx: BcContext, code: string) {
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/journals`, { $filter: `code eq '${q(code)}'`, $select: 'id,code,balancingAccountNumber' }), ctx.token);
  if (!rows.length) throw new Error(`No existe el lote ${code} en el General Journal de BC.`);
  return rows[0] as { id: string; code: string; balancingAccountNumber: string };
}

// Líneas que ya están en el lote (sin registrar), con el importe visto desde el banco
export async function batchLines(ctx: BcContext, journalId: string, bankNo: string): Promise<BatchLine[]> {
  const rows = await bcFetchAll(`${ctx.apiBase}/journals(${journalId})/journalLines`, ctx.token);
  return rows.map((r: any) => {
    const amount = Number(r.amount) || 0;
    const isBankAccount = r.accountType === 'Bank Account' && r.accountNumber === bankNo;
    return { date: r.postingDate, bankAmount: isBankAccount ? amount : -amount, docNo: String(r.documentNumber || ''), description: String(r.description || '') };
  });
}

// ---------- Cuadre ----------

// Devuelve, por movimiento, los movimientos de banco con los que cuadra
export function matchMovements(movements: Movement[], entries: LedgerEntry[]) {
  const used = new Set<number>();
  const result = new Map<number, LedgerEntry[]>();
  const dist = (m: Movement, d: string) => Math.min(days(m.date, d), m.valueDate ? days(m.valueDate, d) : Infinity);

  // Asigna a cada movimiento el candidato más cercano en fecha que siga libre
  const assign = (candidates: { m: Movement; es: LedgerEntry[]; d: number }[]) => {
    candidates.sort((a, b) => a.d - b.d || a.es[0].entryNo - b.es[0].entryNo);
    for (const { m, es } of candidates) {
      if (result.has(m.idx) || es.some(e => used.has(e.entryNo))) continue;
      result.set(m.idx, es);
      es.forEach(e => used.add(e.entryNo));
    }
  };
  const docs = new Map<string, LedgerEntry[]>();
  for (const e of entries) docs.set(`${e.docNo}|${e.date}`, [...(docs.get(`${e.docNo}|${e.date}`) || []), e]);
  const sum = (es: LedgerEntry[]) => cents(es.reduce((t, e) => t + e.amount, 0));
  const pending = () => movements.filter(m => !result.has(m.idx));

  // 1. Un documento entero (mismo nº y fecha) que suma el importe: un movimiento suelto o un cobro repartido por factura
  const docsBySum = new Map<number, LedgerEntry[][]>();
  for (const es of docs.values()) docsBySum.set(sum(es), [...(docsBySum.get(sum(es)) || []), es]);
  assign(movements.flatMap(m => (docsBySum.get(cents(m.amount)) || [])
    .map(es => ({ m, es, d: dist(m, es[0].date) })).filter(c => c.d <= WINDOW_DAYS)));

  // 2. Un movimiento de banco del mismo importe dentro de un documento con más líneas
  const byAmount = new Map<number, LedgerEntry[]>();
  for (const e of entries) byAmount.set(cents(e.amount), [...(byAmount.get(cents(e.amount)) || []), e]);
  assign(pending().flatMap(m => (byAmount.get(cents(m.amount)) || [])
    .map(e => ({ m, es: [e], d: dist(m, e.date) })).filter(c => c.d <= WINDOW_DAYS)));

  // 3. Parte de un documento que suma el importe (el resto del documento es otro movimiento)
  for (const m of pending()) {
    const target = cents(m.amount);
    for (const es of docs.values()) {
      const free = es.filter(e => !used.has(e.entryNo));
      if (free.length < 2 || dist(m, free[0].date) > WINDOW_DAYS) continue;
      const found = subsetWithSum(free, target);
      if (found) {
        result.set(m.idx, found);
        found.forEach(e => used.add(e.entryNo));
        break;
      }
    }
  }

  // 4. Remesa ("DATUM … ANZAHL n"): n movimientos de banco de un mismo día (documentos distintos) que suman el importe
  for (const m of movements) {
    const n = Number(m.purpose.match(/ANZAHL\s+(\d+)/i)?.[1] || 0);
    if (result.has(m.idx) || n < 2) continue;
    const dates = Array.from(new Set(entries.filter(e => !used.has(e.entryNo)).map(e => e.date)))
      .filter(d => dist(m, d) <= WINDOW_DAYS).sort((a, b) => dist(m, a) - dist(m, b));
    for (const d of dates) {
      const group = entries.filter(e => !used.has(e.entryNo) && e.date === d && Math.sign(e.amount) === Math.sign(m.amount));
      const found = combinationWithSum(group, n, cents(m.amount));
      if (found) {
        result.set(m.idx, found);
        found.forEach(e => used.add(e.entryNo));
        break;
      }
    }
  }

  // 4b. Pago del Payment Journal (Iberia: "TRANSFERENCIA CRAZE IBERIA S.L." -18.404,59): BC registra un movimiento de
  //     banco por proveedor, cada uno con su nº de documento, el mismo día; el extracto trae uno solo con la suma
  for (const m of pending()) {
    const dates = Array.from(new Set(entries.filter(e => !used.has(e.entryNo)).map(e => e.date)))
      .filter(d => dist(m, d) <= 3).sort((a, b) => dist(m, a) - dist(m, b));
    for (const d of dates) {
      const group = entries.filter(e => !used.has(e.entryNo) && e.date === d && Math.sign(e.amount) === Math.sign(m.amount));
      const found = group.length >= 2 ? subsetAnySize(group, cents(m.amount)) : null;
      if (found) {
        result.set(m.idx, found);
        found.forEach(e => used.add(e.entryNo));
        break;
      }
    }
  }

  // 5. Cobro neto de una factura de compra (o al revés): movimientos del mismo día de documentos distintos con el
  //    nombre de la contrapartida (p. ej. dm drogerie markt GmbH 17.689,69 y dm drogerie markt GmbH AT -308,16)
  for (const m of pending()) {
    const key = firstWord(m.name);
    if (!key) continue;
    const dates = Array.from(new Set(entries.filter(e => !used.has(e.entryNo)).map(e => e.date)))
      .filter(d => dist(m, d) <= WINDOW_DAYS).sort((a, b) => dist(m, a) - dist(m, b));
    for (const d of dates) {
      const group = entries.filter(e => !used.has(e.entryNo) && e.date === d && firstWord(e.description) === key);
      const found = group.length >= 2 ? subsetWithSum(group, cents(m.amount)) : null;
      if (found) {
        result.set(m.idx, found);
        found.forEach(e => used.add(e.entryNo));
        break;
      }
    }
  }
  return result;
}

// Primera palabra del nombre normalizado ("dm drogerie markt GmbH AT" → "dm")
const firstWord = (s: string) => normName(s).split(' ')[0] || '';

// k movimientos del grupo que suman target (busca por el lado más corto: los k o los que sobran)
function combinationWithSum(group: LedgerEntry[], k: number, target: number): LedgerEntry[] | null {
  if (k > group.length) return null;
  const total = group.reduce((t, e) => t + cents(e.amount), 0);
  const invert = k > group.length - k;
  const size = invert ? group.length - k : k;
  const goal = invert ? total - target : target;
  const values = group.map(e => cents(e.amount));
  const pick: number[] = [];
  let steps = 0;
  const dfs = (start: number, left: number, sum: number): boolean => {
    if (++steps > 2_000_000) return false;
    if (left === 0) return sum === goal;
    for (let i = start; i <= values.length - left; i++) {
      pick.push(i);
      if (dfs(i + 1, left - 1, sum + values[i])) return true;
      pick.pop();
    }
    return false;
  };
  if (!dfs(0, size, 0)) return null;
  const chosen = new Set(pick);
  return group.filter((_, i) => chosen.has(i) !== invert);
}

// Dos o más movimientos (de hasta 34) que suman target: mitad y mitad (2^17 sumas por lado, cada suma a partir de la
// de la máscara sin su bit más bajo)
function subsetAnySize(group: LedgerEntry[], target: number): LedgerEntry[] | null {
  if (group.length > 34) return null;
  const values = group.map(e => cents(e.amount));
  // Todos juntos no llegan al importe: no hay solución
  if (Math.abs(values.reduce((t, v) => t + v, 0)) < Math.abs(target)) return null;
  const half = Math.floor(values.length / 2);
  const sums = (from: number, n: number) => {
    const out = new Float64Array(1 << n);
    for (let mask = 1; mask < out.length; mask++) {
      const low = 31 - Math.clz32(mask & -mask);
      out[mask] = out[mask & (mask - 1)] + values[from + low];
    }
    return out;
  };
  const left = sums(0, half), right = sums(half, values.length - half);
  const index = new Map<number, number>();
  for (let mask = 0; mask < left.length; mask++) if (!index.has(left[mask])) index.set(left[mask], mask);
  for (let maskR = 0; maskR < right.length; maskR++) {
    const maskL = index.get(target - right[maskR]);
    if (maskL == null) continue;
    const pick = group.filter((_, i) => (i < half ? maskL & (1 << i) : maskR & (1 << (i - half))));
    if (pick.length >= 2) return pick;
  }
  return null;
}

function subsetWithSum(group: LedgerEntry[], target: number): LedgerEntry[] | null {
  if (cents(group.reduce((t, e) => t + e.amount, 0)) === target) return group;
  if (group.length > 16) return null;
  const n = group.length;
  for (let mask = 3; mask < (1 << n) - 1; mask++) {
    if ((mask & (mask - 1)) === 0) continue; // un solo movimiento: ya se ha probado en el paso 1
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += cents(group[i].amount);
    if (sum === target) return group.filter((_, i) => mask & (1 << i));
  }
  return null;
}

// Movimientos sin registrar que ya están en el lote (mismo importe, ±7 días)
export function matchBatch(movements: Movement[], lines: BatchLine[]) {
  const used = new Set<number>();
  const result = new Map<number, BatchLine>();
  for (const m of movements) {
    const i = lines.findIndex((l, j) => !used.has(j) && cents(l.bankAmount) === cents(m.amount) && days(l.date, m.date) <= WINDOW_DAYS);
    if (i >= 0) { used.add(i); result.set(m.idx, lines[i]); }
  }
  return result;
}

// ---------- Sugerencias ----------

const LEGAL = /\b(gmbh|ag|kg|co|ohg|se|sa|s a|sas|sarl|sl|slu|s l|bv|nv|ltd|limited|llc|inc|plc|eood|ood|spa|srl|s r l|sp z o o|z o o|spolka|ograniczona|odpowiedzialnoscia|beschraenkter|haftung|mit|ab|as|oy|mbh|und|and|the|eu|europe|deutschland)\b/g;
export const normName = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();

const toAccountType = (t: string): AccountType | '' =>
  t === 'G/L Account' || t === 'Customer' || t === 'Vendor' || t === 'Bank Account' ? t : '';
const docType = (t: string): AppliesType => (/credit/i.test(t) ? 'Credit Memo' : /refund/i.test(t) ? 'Refund' : /payment/i.test(t) ? 'Payment' : 'Invoice');
const amazonPaymentNo = (purpose: string) => purpose.match(/PAYMENT-NUM\s+([\d ]{6,})/i)?.[1].replace(/\s/g, '') || '';

const ownAccount = (m: Movement) => !!m.iban && !!m.account && (m.account === m.iban || m.account.endsWith(m.iban));

type Rule = {
  accountType: AccountType; accountNo: string; description: string; usesPurpose: boolean; date: string; text: string; amount: number;
  lines: { accountType: AccountType; accountNo: string; description: string; amount: number }[];
};

// Lo que se hizo con cada contrapartida (IBAN y nombre) en los movimientos ya registrados
function learnRules(movements: Movement[], matched: Map<number, LedgerEntry[]>, bankNo: string) {
  const byIban = new Map<string, Rule[]>();
  const byName = new Map<string, Rule[]>();
  for (const m of movements) {
    const entries = (matched.get(m.idx) || []).filter(e => !(e.balType === 'Bank Account' && e.balNo === bankNo));
    if (!entries.length) continue;
    const main = entries.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
    const accountType = toAccountType(main.balType);
    if (!accountType || !main.balNo) continue;
    const desc = normName(main.description);
    const usesPurpose = !!desc && (normName(m.purpose).includes(desc) || desc.includes(normName(m.purpose)) || main.description === main.docNo);
    const lines = entries.flatMap(e => {
      const t = toAccountType(e.balType);
      return t && e.balNo ? [{ accountType: t, accountNo: e.balNo, description: e.description, amount: e.amount }] : [];
    });
    const rule: Rule = { accountType, accountNo: main.balNo, description: main.description, usesPurpose, date: m.date, text: m.text, amount: m.amount, lines };
    const keep = (map: Map<string, Rule[]>, key: string) => { if (key) map.set(key, [...(map.get(key) || []), rule]); };
    // Las remesas y traspasos llevan la propia cuenta como contrapartida: no identifican a nadie
    if (!ownAccount(m)) keep(byIban, m.iban);
    keep(byName, normName(m.name));
  }
  return { byIban, byName };
}

// De lo hecho con la contrapartida: el mismo importe (cuota, alquiler, comisión); si no, el mismo tipo de movimiento
// (p. ej. la transferencia y su comisión), y si no, lo más reciente
function pickRule(m: Movement, rules: Rule[] | undefined) {
  if (!rules?.length) return null;
  const recent = [...rules].sort((a, b) => b.date.localeCompare(a.date));
  return recent.find(r => cents(r.amount) === cents(m.amount)) || recent.find(r => r.text === m.text) || recent[0];
}

// ---------- Histórico de la cuenta ----------
// Lo registrado en la cuenta de banco en los últimos 12 meses, por el texto: la descripción de los movimientos de banco
// suele ser el texto del extracto ("TRAMISEC SL-Hospitalet de", "INTERESES Y/O COMISIONES CUENTA", "TIKET CONSUM") o
// el nombre de la contrapartida ("Deutsche Lufthansa Aktiengesellschaft"). Sirve aunque el extracto no traiga el
// nombre (Sabadell) y para movimientos de otros extractos.
type Booking = { date: string; amount: number; description: string; balType: AccountType; balNo: string; via?: string };

// Palabras que no distinguen un movimiento
const GENERIC = new Set(['compra', 'compras', 'tarj', 'tarjeta', 'card', 'transferencia', 'transf', 'trf', 'recibo', 'pago', 'pagos', 'cargo',
  'abono', 'adeudo', 'sepa', 'devolucion', 'anul', 'anulacion', 'payment', 'paypal', 'sumup', 'visa', 'mastercard', 'xxxx', 'xxxxxxxx',
  'aktiengesellschaft', 'company', 'unlimited', 'spain', 'espana', 'services', 'servicios', 'international', 'group', 'holding', 'gutschrift',
  'lastschrift', 'ueberweisung', 'uberweisung', 'folgelastschrift', 'erstlastschrift', 'kartenzahlung', 'girocard', 'sabadell', 'santander']);
const words = (s: string, own: Set<string>) => new Set(normName(s).split(' ').filter(w => w.length >= 3 && !/\d/.test(w) && !GENERIC.has(w) && !own.has(w)));

// Correcciones: un movimiento anulado (Reversed, o a mano con el mismo importe en positivo y en negativo contra la
// misma cuenta en el mismo documento) y, por ese importe y ±3 días, el bueno con otra cuenta (TRAMISEC: VE-00078
// anulado → UPS VE-00010): el texto anulado vale para la cuenta buena
export function bookings(history: LedgerEntry[], bankNo: string): Booking[] {
  const valid = history.filter(e => toAccountType(e.balType) && e.balNo && !(e.balType === 'Bank Account' && e.balNo === bankNo));
  const cancelled = new Set<number>();
  const byDoc = new Map<string, LedgerEntry[]>();
  for (const e of valid) byDoc.set(e.docNo, [...(byDoc.get(e.docNo) || []), e]);
  const out: Booking[] = [];
  const add = (a: LedgerEntry) => {
    const good = valid.find(x => !x.reversed && x.docNo !== a.docNo && cents(x.amount) === cents(a.amount) && x.balNo !== a.balNo && days(x.date, a.date) <= 3);
    if (good) out.push({ date: good.date, amount: good.amount, description: a.description, balType: toAccountType(good.balType) as AccountType, balNo: good.balNo, via: good.description });
  };
  // Anulados en BC: el original (no la anulación, que lleva el signo contrario)
  for (const e of valid) {
    if (!e.reversed) continue;
    cancelled.add(e.entryNo);
    const twin = valid.find(x => x.reversed && x.docNo === e.docNo && x.entryNo !== e.entryNo && cents(x.amount) === -cents(e.amount));
    if (!twin || e.entryNo < twin.entryNo) add(e);
  }
  for (const es of byDoc.values()) {
    for (const a of es) {
      if (cancelled.has(a.entryNo) || a.amount >= 0) continue;
      const b = es.find(x => !cancelled.has(x.entryNo) && x.entryNo !== a.entryNo && x.balNo === a.balNo && cents(x.amount) === -cents(a.amount));
      if (!b) continue;
      cancelled.add(a.entryNo); cancelled.add(b.entryNo);
      add(a);
    }
  }
  for (const e of valid) if (!cancelled.has(e.entryNo)) out.push({ date: e.date, amount: e.amount, description: e.description, balType: toAccountType(e.balType) as AccountType, balNo: e.balNo });
  return out;
}

// Cuentas "cajón de sastre" (p. ej. VE-00078 Expenses Credit Card (Tickets)): muchos textos distintos registrados en ella
const catchAllCache = new WeakMap<Booking[], Set<string>>();
function catchAllAccounts(books: Booking[], own: Set<string>) {
  let set = catchAllCache.get(books);
  if (set) return set;
  const texts = new Map<string, { n: number; distinct: Set<string> }>();
  for (const b of books) {
    const key = `${b.balType}|${b.balNo}`;
    const t = texts.get(key) || { n: 0, distinct: new Set<string>() };
    t.n++; t.distinct.add([...words(b.description, own)].sort().join(' '));
    texts.set(key, t);
  }
  set = new Set([...texts].filter(([, t]) => t.distinct.size >= 8 && t.distinct.size / t.n >= 0.4).map(([k]) => k));
  catchAllCache.set(books, set);
  return set;
}

// La cuenta con la que más se parece el texto del movimiento: palabras en común (ponderadas por lo raras que son en la
// cuenta) sobre las de la descripción o las del movimiento, la que tenga menos; ≥ 50 % y una palabra de ≥ 4 letras.
// Entre las cuentas que pasan, la de más peso (mismo signo × 2, más recientes primero). Si gana una cuenta cajón de
// sastre y hay una cuenta específica con ≥ 2 movimientos que comparten una palabra distintiva (≥ 30 %), la específica:
// "COMPRA TARJ. VIENA FILADORS-SABADELL" → VE-00066 ESTABLIMENTS VIENA S.A. (60 pagos) y no VE-00078 por dos "TIKET
// VIENA FILADORS" registrados ahí una vez
function fromHistory(m: Movement, books: Booking[], own: Set<string>) {
  if (!books.length) return null;
  const docs = books.map(b => words(b.description, own));
  const df = new Map<string, number>();
  for (const ws of docs) for (const w of ws) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w: string) => Math.log(1 + books.length / (df.get(w) || 1));
  const mw = words(`${m.name} ${m.purpose}`, own);
  if (!mw.size) return null;
  const mWeight = [...mw].reduce((t, w) => t + idf(w), 0);
  type Vote = { key: string; weight: number; best: Booking; score: number; n: number; words: Map<string, number> };
  const strong = new Map<string, Vote>();
  const weak = new Map<string, Vote>();
  books.forEach((b, i) => {
    const ws = docs[i];
    if (!ws.size) return;
    const shared = [...ws].filter(w => mw.has(w));
    if (!shared.some(w => w.length >= 4)) return;
    const score = shared.reduce((t, w) => t + idf(w), 0) / Math.min([...ws].reduce((t, w) => t + idf(w), 0), mWeight);
    if (score < 0.3) return;
    const key = `${b.balType}|${b.balNo}`;
    const weight = score * (Math.sign(b.amount) === Math.sign(m.amount) ? 2 : 1);
    for (const votes of score >= 0.5 ? [strong, weak] : [weak]) {
      const v = votes.get(key) || { key, weight: 0, best: b, score, n: 0, words: new Map<string, number>() };
      votes.set(key, v);
      for (const w of shared) v.words.set(w, (v.words.get(w) || 0) + 1);
      if (v.n++ === 0) v.weight = weight;
      else { v.weight += weight; if (score > v.score || (score === v.score && b.date > v.best.date)) { v.best = b; v.score = score; } }
    }
  });
  const byWeight = (a: Vote, b: Vote) => b.weight - a.weight;
  const top = [...strong.values()].sort(byWeight)[0];
  if (!top) return null;
  const generic = catchAllAccounts(books, own);
  if (generic.has(top.key)) {
    // Una palabra en común casi exclusiva de esa cuenta (VIENA: 60 de 62 movimientos), no una genérica (STORE)
    const owns = (v: Vote) => [...v.words].some(([w, n]) => w.length >= 4 && n >= 3 && n / (df.get(w) || 1) >= 0.8);
    const specific = [...weak.values()].filter(v => !generic.has(v.key) && v.n >= 2 && owns(v)).sort(byWeight)[0];
    if (specific) return specific;
  }
  return top;
}

// Facturas abiertas citadas en el concepto (nº de documento o nº de documento externo)
function citedEntries(m: Movement, open: OpenEntry[]) {
  const side = m.amount > 0 ? 'Customer' : 'Vendor';
  const text = ` ${m.purpose.toUpperCase().replace(/[^A-Z0-9-]+/g, ' ')} `;
  const compact = m.purpose.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return open.filter(o => {
    if (o.side !== side) return false;
    if (o.docNo.length >= 6 && text.includes(` ${o.docNo.toUpperCase()} `)) return true;
    const ext = o.extDocNo.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return ext.length >= 6 && compact.includes(ext);
  });
}

// Índices de values (hasta 14) que suman target
function subsetIndexes(values: number[], target: number): number[] | null {
  const n = Math.min(values.length, 14);
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += values[i];
    if (sum === target) return Array.from({ length: n }, (_, i) => i).filter(i => mask & (1 << i));
  }
  return null;
}

// Facturas abiertas de la cuenta ya elegida que liquida el movimiento: las que cita el concepto (nº de documento,
// nº externo o solo su número, p. ej. "Rechnung 02657" o "RG 1215217008"); si no cita ninguna, la que tiene pendiente
// el importe o varias que lo suman
function applyWithinAccount(m: Movement, side: 'Customer' | 'Vendor', no: string, name: string, open: OpenEntry[]) {
  const own = open.filter(o => o.side === side && o.no === no && o.remaining);
  const compact = m.purpose.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const runs = new Set((m.purpose.match(/\d{4,}/g) || []).filter(r => !/^20[2-3]\d$/.test(r)).map(r => r.replace(/^0+/, '')));
  const cites = (o: OpenEntry) => [o.docNo, o.extDocNo].some(d => {
    const c = d.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tail = d.match(/(\d{4,})\D*$/)?.[1].replace(/^0+/, '') || '';
    return (c.length >= 4 && compact.includes(c)) || (!!tail && runs.has(tail));
  });
  const lineFor = (o: OpenEntry, amount = o.remaining): SuggestedLine => ({
    accountType: side, accountNo: no, accountName: name, description: `${name} ${o.docNo}`.substring(0, 100), amount: r2(amount),
    appliesToDocType: docType(o.docType), appliesToDocNo: o.docNo,
  });
  const target = cents(m.amount);
  const cited = own.filter(cites);
  if (cited.length) {
    const total = cents(cited.reduce((t, o) => t + o.remaining, 0));
    if (total === target) return { lines: cited.map(o => lineFor(o)), note: `El concepto cita ${cited.map(o => o.docNo).join(', ')}` };
    if (cited.length === 1) return { lines: [lineFor(cited[0], m.amount)], note: `El concepto cita ${cited[0].docNo}, con pendiente ${r2(cited[0].remaining).toFixed(2)}: revisa la diferencia` };
  }
  const same = own.filter(o => cents(o.remaining) === target);
  if (same.length) return { lines: [lineFor(same[0])], note: `${same[0].docNo} tiene pendiente el mismo importe${same.length > 1 ? ` (y ${same.length - 1} más)` : ''}` };
  const idx = own.length >= 2 ? subsetIndexes(own.map(o => cents(o.remaining)), target) : null;
  if (idx) return { lines: idx.map(i => lineFor(own[i])), note: `${idx.map(i => own[i].docNo).join(' + ')} suman el importe` };
  const refs = m.purpose.toUpperCase().match(/\b(?:[A-Z]{2,5}-)?[A-Z]{2,5}\d{2}-\d{4,6}\b/g);
  return refs ? { lines: null, note: `El concepto cita ${Array.from(new Set(refs)).join(', ')}, sin pendiente en esta cuenta` } : null;
}

function matchParty(m: Movement, parties: Party[]) {
  const name = normName(m.name);
  if (name.length < 3) return null;
  const preferred = m.amount > 0 ? 'Customer' : 'Vendor';
  const hits = parties.filter(p => {
    const n = normName(p.name);
    return n && (n === name || (Math.min(n.length, name.length) >= 5 && (n.startsWith(name) || name.startsWith(n))));
  });
  return hits.find(p => p.side === preferred) || hits[0] || null;
}

// history: movimientos de banco de la cuenta de los últimos 12 meses; ownName: la empresa (no distingue: "TRANSFERENCIA
// CRAZE IBERIA S.L." no es un cobro de CRAZE GmbH)
export function suggest(
  movements: Movement[], matched: Map<number, LedgerEntry[]>, bankNo: string, open: OpenEntry[], parties: Party[],
  history: LedgerEntry[] = [], ownName = '',
): Map<number, Suggestion> {
  const { byIban, byName } = learnRules(movements, matched, bankNo);
  const books = bookings(history, bankNo);
  const own = new Set(normName(ownName).split(' '));
  const partyName = new Map(parties.map(p => [`${p.side}|${p.no}`, p.name]));
  const out = new Map<number, Suggestion>();
  const defaultDescription = (m: Movement) => (m.name || m.purpose).substring(0, 100);

  for (const m of movements) {
    if (matched.has(m.idx)) continue;
    const documentNo = amazonPaymentNo(m.purpose);
    const line = (accountType: AccountType | '', accountNo: string, description: string, amount = m.amount): SuggestedLine => ({
      accountType, accountNo, accountName: accountType === 'Customer' || accountType === 'Vendor' ? partyName.get(`${accountType}|${accountNo}`) || '' : '',
      description: description.substring(0, 100), amount: r2(amount),
    });

    // Con la cuenta de un cliente o proveedor, las facturas que liquida (si no, la línea tal cual)
    const withApply = (l: SuggestedLine) => {
      if (l.accountType !== 'Customer' && l.accountType !== 'Vendor') return { lines: [l], note: '' };
      const a = applyWithinAccount(m, l.accountType, l.accountNo, l.accountName || partyName.get(`${l.accountType}|${l.accountNo}`) || m.name, open);
      return { lines: a?.lines || [l], note: a?.note || '' };
    };

    // Facturas abiertas citadas en el concepto
    const cited = citedEntries(m, open);
    const citedParties = new Set(cited.map(o => o.no));
    if (cited.length && citedParties.size === 1) {
      const o = cited[0];
      const total = cents(cited.reduce((t, c) => t + c.remaining, 0));
      const name = o.name || partyName.get(`${o.side}|${o.no}`) || m.name;
      const applied = (c: OpenEntry): SuggestedLine => ({ ...line(o.side, o.no, `${name} ${c.docNo}`, c.remaining), accountName: name, appliesToDocType: docType(c.docType), appliesToDocNo: c.docNo });
      // La diferencia puede ser una factura abierta del otro lado con nombre parecido (cobro neto de una factura de compra)
      const other = open.find(c => c.side !== o.side && cents(c.remaining) === cents(m.amount) - total && firstWord(c.name) === firstWord(name));
      if (total === cents(m.amount)) {
        out.set(m.idx, { documentNo, source: 'Factura', note: `Cuadra con ${cited.map(c => c.docNo).join(', ')}`, lines: cited.map(applied) });
      } else if (other) {
        const otherLine: SuggestedLine = { ...line(other.side, other.no, `${other.name} ${other.docNo}`, other.remaining), accountName: other.name, appliesToDocType: docType(other.docType), appliesToDocNo: other.docNo };
        out.set(m.idx, { documentNo, source: 'Factura', note: `Cuadra con ${cited.map(c => c.docNo).join(', ')} menos ${other.docNo} de ${other.name}`, lines: [...cited.map(applied), otherLine] });
      } else if (cited.length === 1) {
        out.set(m.idx, { documentNo, source: 'Factura', note: `${o.docNo} tiene pendiente ${r2(o.remaining).toFixed(2)}: revisa la diferencia (Skonto, comisión…)`, lines: [{ ...applied(o), amount: r2(m.amount) }] });
      } else {
        out.set(m.idx, { documentNo, source: 'Factura', note: `Facturas citadas ${cited.map(c => `${c.docNo} (${r2(c.remaining).toFixed(2)})`).join(', ')}: no suman el importe, liquídalas en BC`, lines: [{ ...line(o.side, o.no, name), accountName: name }] });
      }
      continue;
    }

    // Misma contrapartida en movimientos ya registrados
    const rule = pickRule(m, (m.iban && !ownAccount(m) && byIban.get(m.iban)) || byName.get(normName(m.name)));
    if (rule) {
      const when = `Como el ${rule.date.split('-').reverse().join('.')}`;
      // Varias líneas (p. ej. leasing: cuota, intereses e IVA): las mismas; con otro importe, solo si son cuentas de
      // G/L, y la principal se queda la diferencia (las de clientes y proveedores van por factura)
      const same = cents(rule.amount) === cents(m.amount);
      if (rule.lines.length > 1 && (same || rule.lines.every(l => l.accountType === 'G/L Account'))) {
        const main = rule.lines.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
        const lines = rule.lines.map(l => line(l.accountType, l.accountNo, rule.usesPurpose ? m.purpose : l.description, l === main ? l.amount + m.amount - rule.amount : l.amount));
        out.set(m.idx, { documentNo, source: 'Histórico', note: same ? `${when}, mismo importe` : `${when}: revisa el reparto entre las líneas`, lines });
        continue;
      }
      const description = documentNo || (rule.usesPurpose ? m.purpose : rule.description) || defaultDescription(m);
      const single = line(rule.accountType, rule.accountNo, description);
      const applied = withApply(single);
      out.set(m.idx, { documentNo, source: 'Histórico', note: [when, applied.note].filter(Boolean).join(' · '), lines: applied.lines });
      continue;
    }

    // Lo registrado antes en la cuenta con un texto parecido
    const hist = fromHistory(m, books, own);
    if (hist) {
      const b = hist.best;
      const applied = withApply(line(b.balType, b.balNo, b.via || b.description));
      const when = `Como "${b.description.substring(0, 40)}" el ${b.date.split('-').reverse().join('.')}${b.via ? ` (corregido a ${b.via.substring(0, 30)})` : ''}`;
      out.set(m.idx, { documentNo, source: 'Histórico', note: [when, applied.note].filter(Boolean).join(' · '), lines: applied.lines });
      continue;
    }

    // Cliente o proveedor con ese nombre
    const party = matchParty(m, parties);
    if (party) {
      const applied = withApply({ ...line(party.side, party.no, party.name), accountName: party.name });
      out.set(m.idx, { documentNo, source: 'Nombre', note: applied.note, lines: applied.lines });
      continue;
    }
    out.set(m.idx, { documentNo, source: '', note: 'Sin sugerencia: indica la cuenta', lines: [line('', '', `${m.name} ${m.purpose}`.trim())] });
  }
  // En las líneas de cliente o proveedor el nombre ya está en la cuenta: la descripción no lo repite ("ALDI TURNHOUT N.V.
  // CRZ-SI26-03349" → "CRZ-SI26-03349"); si no queda nada, la factura que liquida o el concepto del banco
  for (const [idx, sug] of out) {
    const m = movements.find(x => x.idx === idx)!;
    for (const l of sug.lines) {
      if (l.accountType !== 'Customer' && l.accountType !== 'Vendor') continue;
      const own = partyName.get(`${l.accountType}|${l.accountNo}`) || '';
      l.description = (withoutName(l.description, [l.accountName, own, m.name]) || l.appliesToDocNo || m.purpose || l.description).substring(0, 100);
    }
  }
  return out;
}

// La descripción sin el nombre de la cuenta delante (comparando sin mayúsculas, acentos ni puntuación)
function withoutName(description: string, names: string[]) {
  for (const name of names.filter(n => n && n.trim().length >= 3).sort((a, b) => b.length - a.length)) {
    const target = normName(name);
    // El prefijo más largo de la descripción que, normalizado, es el nombre ("ALDI TURNHOUT N.V." entero, con su N.V.)
    let end = 0;
    for (let i = 1; i <= description.length; i++) {
      if (!/[A-Za-z0-9]/.test(description[i] || ' ') && normName(description.slice(0, i)) === target) end = i;
    }
    if (end) return description.slice(end).replace(/^[\s,.;:\-–]+/, '').trim();
  }
  return description.trim();
}

// ---------- Envío al lote ----------

export type SendMovement = { date: string; documentNo: string; lines: SuggestedLine[] };

async function templateName(ctx: BcContext, journalId: string) {
  const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/workflowGenJournalBatches`, { $filter: `id eq ${journalId}`, $select: 'journalTemplateName' }), ctx.token).catch(() => []);
  return String(rows[0]?.journalTemplateName || 'ALLGEMEIN');
}

// Crea las líneas (sin registrar) con el banco como contrapartida. Las de un mismo movimiento comparten nº de documento;
// sin nº, BC pone el siguiente de la serie del lote. Tipo de documento y liquidación (no están en la API v2) se ponen
// después en la página General_Journals_Excel.
export async function sendToBatch(ctx: BcContext, journal: { id: string; code: string }, bankNo: string, movements: SendMovement[]) {
  const base = `${ctx.apiBase}/journals(${journal.id})/journalLines`;
  const created: { id: string; lineNumber: number; documentNumber: string; docType: string; applies?: { type: string; no: string } }[] = [];
  try {
    for (const mv of movements) {
      let docNo = mv.documentNo.trim();
      for (const l of mv.lines) {
        const r = await bcRequest('POST', base, ctx.token, {
          accountType: l.accountType, accountNumber: l.accountNo, postingDate: mv.date, ...(docNo ? { documentNumber: docNo } : {}),
          amount: -r2(l.amount), description: l.description.substring(0, 100), balanceAccountType: 'Bank Account', balancingAccountNumber: bankNo,
        });
        docNo = docNo || String(r.documentNumber || '');
        const party = l.accountType === 'Customer' || l.accountType === 'Vendor';
        // Cobro de cliente o pago a proveedor: Payment; devolución: Refund
        const refund = (l.accountType === 'Customer' && l.amount < 0) || (l.accountType === 'Vendor' && l.amount > 0);
        created.push({
          id: r.id, lineNumber: r.lineNumber, documentNumber: String(r.documentNumber || ''), docType: party && refund ? 'Refund' : 'Payment',
          applies: party && l.appliesToDocNo ? { type: l.appliesToDocType || 'Invoice', no: l.appliesToDocNo } : undefined,
        });
      }
    }
  } catch (e) {
    // No dejar el envío a medias
    for (const c of created) await bcRequest('DELETE', `${base}(${c.id})`, ctx.token).catch(() => {});
    throw e;
  }

  const warnings: string[] = [];
  const template = await templateName(ctx, journal.id);
  const key = (n: number) => `${ctx.odataCompanyBase}/General_Journals_Excel(Journal_Template_Name='${encodeURIComponent(q(template))}',Journal_Batch_Name='${encodeURIComponent(q(journal.code))}',Line_No=${n})`;
  for (const c of created) {
    try {
      await bcRequest('PATCH', key(c.lineNumber), ctx.token, {
        Document_Type: c.docType,
        ...(c.applies ? { Applies_to_Doc_Type: c.applies.type, Applies_to_Doc_No: c.applies.no } : {}),
      });
    } catch (e: any) {
      warnings.push(`No se ha podido poner el tipo de documento ni la liquidación en las líneas (${String(e?.message || e).substring(0, 160)}); revísalo en BC.`);
      break;
    }
  }
  if (created.some(c => !c.documentNumber)) warnings.push('Alguna línea ha quedado sin nº de documento: ponlo en BC antes de registrar.');
  return { lines: created.length, documentNumbers: Array.from(new Set(created.map(c => c.documentNumber).filter(Boolean))), warnings };
}

// ---------- Cierre cruzado (Open Entries) ----------

// Dos (o más) movimientos abiertos de distinto cliente / proveedor que se compensan: una línea por movimiento con el
// importe pendiente cambiado de signo y liquidándolo, misma fecha y mismo nº de documento, SIN cuenta de contrapartida
// (las líneas suman 0). El nº de documento lo pone BC (serie del lote) en la primera línea.
export type ClearingLine = {
  accountType: 'Customer' | 'Vendor'; accountNo: string; amount: number; description: string;
  appliesToDocType: string; appliesToDocNo: string; currencyCode: string;
};
export async function sendClearing(ctx: BcContext, journal: { id: string; code: string }, date: string, lines: ClearingLine[]) {
  const base = `${ctx.apiBase}/journals(${journal.id})/journalLines`;
  const created: { id: string; lineNumber: number; documentNumber: string; line: ClearingLine }[] = [];
  let docNo = '';
  try {
    for (const l of lines) {
      const r = await bcRequest('POST', base, ctx.token, {
        accountType: l.accountType, accountNumber: l.accountNo, postingDate: date, ...(docNo ? { documentNumber: docNo } : {}),
        amount: r2(l.amount), description: l.description.substring(0, 100),
      });
      docNo = docNo || String(r.documentNumber || '');
      created.push({ id: r.id, lineNumber: r.lineNumber, documentNumber: String(r.documentNumber || ''), line: l });
    }
  } catch (e) {
    for (const c of created) await bcRequest('DELETE', `${base}(${c.id})`, ctx.token).catch(() => {});
    throw e;
  }

  // Si algo falla (BC no deja liquidar, divisa…) se borran las líneas: o quedan las dos bien o ninguna
  const template = await templateName(ctx, journal.id);
  const key = (n: number) => `${ctx.odataCompanyBase}/General_Journals_Excel(Journal_Template_Name='${encodeURIComponent(q(template))}',Journal_Batch_Name='${encodeURIComponent(q(journal.code))}',Line_No=${n})`;
  for (const c of created) {
    try {
      // Sin contrapartida (el lote puede traer una por defecto) y en la divisa del movimiento; después, la liquidación
      await bcRequest('PATCH', key(c.lineNumber), ctx.token, {
        Bal_Account_Type: 'G/L Account', Bal_Account_No: '', ...(c.line.currencyCode ? { Currency_Code: c.line.currencyCode } : {}),
      });
      await bcRequest('PATCH', key(c.lineNumber), ctx.token, {
        Applies_to_Doc_Type: c.line.appliesToDocType && c.line.appliesToDocType !== 'Empty' ? c.line.appliesToDocType : ' ',
        Applies_to_Doc_No: c.line.appliesToDocNo,
      });
    } catch (e: any) {
      for (const d of created) await bcRequest('DELETE', `${base}(${d.id})`, ctx.token).catch(() => {});
      const msg = String(e?.message || e).replace(/^BC PATCH [^:]*: /, '');
      throw new Error(`BC no deja liquidar ${c.line.appliesToDocType} ${c.line.appliesToDocNo} (${c.line.accountType} ${c.line.accountNo}): ${msg.substring(0, 300)}. No se ha dejado nada en el lote.`);
    }
  }
  const warnings: string[] = [];
  if (!docNo) warnings.push('Las líneas han quedado sin nº de documento: ponles el mismo en BC antes de registrar.');
  return { lines: created.length, documentNumber: docNo, warnings };
}
