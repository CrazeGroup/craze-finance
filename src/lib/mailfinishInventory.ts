import * as XLSX from 'xlsx';
import { bcFetchAll, odataUrl, type BcContext } from '@/lib/bcClient';
import { outputMap, LOC_GOOD, LOC_DAMAGED } from '@/lib/mailfinish';

// Mailfinish Inventory (Craze Entertainment): el stock que Mailfinish dice tener a fin de mes contra el de BC.
// Mailfinish adjunta a cada factura de almacenaje (artículo AA-00009 "LOGISTIC COSTS - Storage", nombre "05.xlsx"…)
// un Excel con una fila por artículo × palet × día del mes (hoja "table - …": Karta | ID | Popis | Sklad | Den |
// Paletod. | Kusů | Pozice). Inventario a fin de mes = suma de Kusů del último día (lo que el usuario hacía con una
// tabla dinámica filtrando el último día). Karta = nº de artículo de BC (o su variante con letras, 43547 → 43547DE);
// "_3" al final = UNUSABLE (II. Wahl), que en BC está en DESTR MAIL; el resto en MAILFINISH.

export const VENDOR = 'VE-00175';        // MailFinish a.s.
export const STORAGE_ITEM = 'AA-00009';  // LOGISTIC COSTS - Storage
const MAGAZINE_PREFIX: Record<string, string> = { galupy: '05995', inkee: '05993' };

// Avisos traducibles en el navegador: t(text, params)
export type MfWarning = { text: string; params?: Record<string, string> };
export type MfRow = {
  key: string; bcItem: string | null; codes: string[]; description: string;
  mfGood: number; bcGood: number; mfDamaged: number; bcDamaged: number;
};
export type MfMonth = {
  month: string; lastDay: string; endOfMonth: string; invoice: string; invoiceDate: string; file: string;
  rows: MfRow[]; warnings: MfWarning[];
};
export type MfInventory = { year: string; months: MfMonth[]; missing: string[]; warnings: MfWarning[]; generatedAt: string };

const str = (v: any) => (v == null ? '' : String(v).trim());
const num = (v: any) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.')) || 0);
const pad = (n: number) => String(n).padStart(2, '0');
const eom = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};

// Fecha de la columna Den: nº de serie de Excel, Date o texto (dd.mm.yyyy / yyyy-mm-dd)
function isoDay(v: any): string {
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : '';
  }
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = str(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  return m ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : '';
}

// Excel de almacenaje → stock del último día por código de Mailfinish
export function parseStorageExcel(data: ArrayBuffer | Uint8Array) {
  const wb = XLSX.read(data, { type: 'array' });
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, defval: null, raw: true });
    const h = rows.findIndex(r => r?.some((c: any) => /^karta$/i.test(str(c))) && r?.some((c: any) => /^den$/i.test(str(c))));
    if (h < 0) continue;
    const head = rows[h].map(str);
    const col = (re: RegExp) => head.findIndex(c => re.test(c));
    const C = { code: col(/^karta$/i), desc: col(/^popis$/i), day: col(/^den$/i), qty: col(/^ku/i) };
    if (C.qty < 0) continue;
    const data = rows.slice(h + 1).map(r => ({ code: str(r?.[C.code]), desc: str(r?.[C.desc]), day: isoDay(r?.[C.day]), qty: num(r?.[C.qty]) }))
      .filter(r => r.code && r.day);
    if (!data.length) continue;
    const lastDay = data.reduce((m, r) => (r.day > m ? r.day : m), '');
    const stock = new Map<string, { desc: string; qty: number }>();
    for (const r of data.filter(r => r.day === lastDay)) {
      const s = stock.get(r.code) || { desc: r.desc, qty: 0 };
      s.qty += r.qty;
      stock.set(r.code, s);
    }
    return { lastDay, stock };
  }
  return null;
}

// Código de Mailfinish → artículo de BC
function resolver(items: Map<string, string>, map: Record<string, string>, withStock: Set<string>) {
  const byUpper = new Map(Array.from(items.keys()).map(k => [k.toUpperCase(), k]));
  return (base: string, desc: string): string | null => {
    if (map[base] && items.has(map[base])) return map[base];
    if (items.has(base)) return base;
    if (byUpper.has(base.toUpperCase())) return byUpper.get(base.toUpperCase())!;
    const re = new RegExp(`^${base.replace(/[^\w]/g, '')}[A-Z]+$`, 'i');
    const variants = Array.from(items.keys()).filter(k => re.test(k));
    if (variants.length) return variants.find(v => withStock.has(v)) || variants[0];
    // Revista: "INKEE Magazin 01/25" → 05993_2501
    const m = desc.match(/(inkee|galupy)\D*magazin\w*\s*(\d{1,2})\s*\/\s*(\d{2,4})/i);
    if (m) {
      const no = `${MAGAZINE_PREFIX[m[1].toLowerCase()]}_${m[3].slice(-2)}${pad(+m[2])}`;
      if (items.has(no)) return no;
    }
    return null;
  };
}

export async function mailfinishInventory(ctx: BcContext, year: string): Promise<MfInventory> {
  const warnings: MfWarning[] = [];
  const nextJan = `${+year + 1}-01-31`;   // la factura del almacenaje de diciembre llega en enero

  // Facturas de almacenaje del año (y enero del siguiente)
  const lines = await bcFetchAll(odataUrl(`${ctx.customApiBase}/purchInvLines`, {
    $filter: `buyFromVendorNo eq '${VENDOR}' and no eq '${STORAGE_ITEM}' and postingDate ge ${year}-01-01 and postingDate le ${nextJan}`,
    $select: 'documentNo,postingDate',
  }), ctx.token);
  const docNos = Array.from(new Set(lines.map((l: any) => str(l.documentNo))));
  const invoices = (await bcFetchAll(odataUrl(`${ctx.apiBase}/purchaseInvoices`, {
    $filter: `vendorNumber eq '${VENDOR}' and postingDate ge ${year}-01-01 and postingDate le ${nextJan}`,
    $select: 'id,number,postingDate',
  }), ctx.token)).filter((i: any) => docNos.includes(i.number));

  // Excel adjuntos → inventario de fin de mes
  type Report = { month: string; lastDay: string; invoice: string; invoiceDate: string; file: string; stock: Map<string, { desc: string; qty: number }> };
  const reports: Report[] = [];
  await Promise.all(invoices.map(async (inv: any) => {
    const atts = await bcFetchAll(odataUrl(`${ctx.apiBase}/documentAttachments`, {
      $filter: `parentType eq 'Purchase Invoice' and parentId eq ${inv.id}`, $select: 'id,fileName',
    }), ctx.token).catch(() => []);
    for (const a of atts.filter((a: any) => /\.xlsx?$/i.test(str(a.fileName)))) {
      try {
        const res = await fetch(`${ctx.apiBase}/documentAttachments(${a.id})/attachmentContent`, { headers: { Authorization: `Bearer ${ctx.token}` }, cache: 'no-store' });
        if (!res.ok) throw new Error(`BC ${res.status}`);
        const parsed = parseStorageExcel(new Uint8Array(await res.arrayBuffer()));
        if (!parsed) continue;   // otro Excel (p. ej. el informe de recuperaciones)
        reports.push({ month: parsed.lastDay.substring(0, 7), lastDay: parsed.lastDay, invoice: inv.number, invoiceDate: inv.postingDate, file: str(a.fileName), stock: parsed.stock });
      } catch (e: any) {
        warnings.push({ text: 'Could not read {file} of {invoice}: {error}', params: { file: str(a.fileName), invoice: inv.number, error: String(e?.message || e).substring(0, 160) } });
      }
    }
  }));
  // Un informe por mes (si hay dos, el de la factura más reciente)
  const byMonth = new Map<string, Report>();
  for (const r of reports.filter(r => r.month.startsWith(year)).sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate))) {
    if (byMonth.has(r.month)) warnings.push({ text: '{month}: two inventory files ({first}, {second}); the latest is used.', params: { month: r.month, first: byMonth.get(r.month)!.invoice, second: r.invoice } });
    byMonth.set(r.month, r);
  }
  const months = Array.from(byMonth.keys()).sort();
  const lastMonth = new Date().toISOString().substring(0, 7);
  const missing: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const mm = `${year}-${pad(m)}`;
    if (mm < lastMonth && !byMonth.has(mm)) missing.push(mm);
  }
  if (!months.length) return { year, months: [], missing, warnings, generatedAt: new Date().toISOString() };

  // Stock de BC en MAILFINISH / DESTR MAIL hasta el último fin de mes
  const maxEom = eom(months[months.length - 1]);
  const [entries, itemRows, map] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Item_Ledger_Entries_Excel`, {
      $filter: `(Location_Code eq '${LOC_GOOD}' or Location_Code eq '${LOC_DAMAGED}') and Posting_Date le ${maxEom}`,
      $select: 'Item_No,Location_Code,Posting_Date,Quantity',
    }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.apiBase}/items`, { $select: 'number,displayName' }), ctx.token),
    outputMap(),
  ]);
  const items = new Map<string, string>(itemRows.map((i: any) => [str(i.number), str(i.displayName)]));
  const withStock = new Set(entries.map((e: any) => str(e.Item_No)));
  const resolve = resolver(items, map, withStock);

  const out: MfMonth[] = months.map(month => {
    const r = byMonth.get(month)!;
    const end = eom(month);
    const mw: MfWarning[] = [];
    if (r.lastDay !== end) mw.push({ text: "The file's last day is {day}, not the end of the month.", params: { day: r.lastDay.split('-').reverse().join('/') } });
    const bc = new Map<string, number>();
    for (const e of entries) {
      if (str(e.Posting_Date).substring(0, 10) > end) continue;
      const k = `${str(e.Item_No)}|${str(e.Location_Code)}`;
      bc.set(k, (bc.get(k) || 0) + num(e.Quantity));
    }
    const rows = new Map<string, MfRow>();
    const row = (key: string, bcItem: string | null, description: string) => {
      if (!rows.has(key)) rows.set(key, { key, bcItem, codes: [], description, mfGood: 0, bcGood: 0, mfDamaged: 0, bcDamaged: 0 });
      return rows.get(key)!;
    };
    for (const [code, s] of r.stock) {
      const damaged = /_3$/.test(code);
      const base = code.replace(/_3$/, '');
      const desc = s.desc.replace(/\s*UNUSABLE\s*$/i, '');
      const item = resolve(base, desc);
      const x = row(item || `?${base}`, item, item ? items.get(item) || desc : desc);
      if (!x.codes.includes(code)) x.codes.push(code);
      if (damaged) x.mfDamaged += s.qty; else x.mfGood += s.qty;
    }
    for (const x of rows.values()) if (!x.bcItem) mw.push({ text: '{codes} ({description}): no item in BC.', params: { codes: x.codes.join(', '), description: x.description } });
    // Lo que BC tiene en esas locations, informado o no por Mailfinish
    for (const [k, qty] of bc) {
      if (Math.abs(qty) < 0.0001) continue;
      const [item, loc] = k.split('|');
      const x = row(item, item, items.get(item) || '');
      if (loc === LOC_DAMAGED) x.bcDamaged += qty; else x.bcGood += qty;
    }
    return {
      month, lastDay: r.lastDay, endOfMonth: end, invoice: r.invoice, invoiceDate: r.invoiceDate, file: r.file,
      rows: Array.from(rows.values()).sort((a, b) => a.key.localeCompare(b.key)), warnings: mw,
    };
  });
  return { year, months: out, missing, warnings, generatedAt: new Date().toISOString() };
}
