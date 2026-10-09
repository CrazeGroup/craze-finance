import * as XLSX from 'xlsx';
import { getDocumentProxy } from 'unpdf';

// D-FORCE (Craze Entertainment): la Gutschrift mensual de D-FORCE-ONE (PDF) y su exportación de Curasoft (Excel)
// se convierten en las líneas de tres documentos de BC, en el formato de los paquetes de configuración
// "D-FORCE" (tabla 37 Sales Line y tabla 39 Purchase Line):
// - Sales Invoice: anexos LI, LA, LDI y LDA del PDF (entregas y diferencias de entrega), por canal ("Sparte").
// - Sales Credit Memo: anexos RI y RA (devoluciones). Las devoluciones de Bahnhofsbuchhandel y del extranjero no
//   vuelven al almacén: llevan Return Reason Code NON-REC y una línea de contrapartida en negativo al final.
// - Purchase Invoice (proveedor D-FORCE): filas del Excel de comisiones (220), envíos (230), KVM (240) y
//   cargos de valor (250), agrupadas por revista y número; el PDF no trae el número de los envíos.

export const DFORCE_COMPANY = 'Craze Entertainment';
export const CUSTOMER_NO = '300353';
export const VENDOR_NO = 'VE-00111';
export const LOCATION = 'D-FORCE';
const SALES_VAT = '7% GOODS';
const PURCHASE_VAT = '7% SERVICE';
const NON_REC = 'NON-REC';

// Revistas de D-FORCE (Objekt / TitelNr) → artículo y proyecto de BC (sufijo _AAMM del número)
export const TITLES: Record<string, { name: string; item: string; project: string; special?: boolean }> = {
  '4191': { name: 'Galupy Magazin', item: '05995', project: '35420' },
  '4192': { name: 'INKEE Magazin', item: '05993', project: '38791' },
  '4193': { name: 'Galupy Special', item: '05994', project: '35420', special: true },
};

// Conceptos de la factura de compra: Vorgang del Excel → artículo de servicio y tarea del proyecto
const PURCHASE_TYPES: { vorgang: number; item: string; description: string; description2: string; task: string }[] = [
  { vorgang: 220, item: 'AA-00005', description: 'EXTERNAL SERVICES - Sales comissions', description2: 'Vertriebsprovisionen', task: '002.003' },
  { vorgang: 230, item: 'AA-00006', description: 'LOGISTIC COSTS - Outgoing freights', description2: 'Versandkosten', task: '002.001' },
  { vorgang: 240, item: 'AA-00010', description: 'LOGISTIC COSTS - Handling Costs', description2: 'KVM-Dienstleistungen', task: '002.002' },
  { vorgang: 250, item: 'AA-00006', description: 'LOGISTIC COSTS - Outgoing freights', description2: 'Wertmäßige Buchungen', task: '002.001' },
];

// Anexos del PDF con líneas de venta
const SALES_APPENDICES: Record<string, { doc: 'Invoice' | 'Credit Memo'; label: string }> = {
  LI: { doc: 'Invoice', label: 'Lieferungen Inland' },
  LA: { doc: 'Invoice', label: 'Lieferungen Ausland' },
  LDI: { doc: 'Invoice', label: 'Lieferdifferenzen Inland' },
  LDA: { doc: 'Invoice', label: 'Lieferdifferenzen Ausland' },
  RI: { doc: 'Credit Memo', label: 'Remissionen Inland' },
  RA: { doc: 'Credit Memo', label: 'Remissionen Ausland' },
};

export type SalesLine = {
  documentType: 'Invoice' | 'Credit Memo'; lineNo: number; no: string; description: string; description2: string;
  quantity: number; unitPrice: number; unitCost: number | null; amount: number; returnReason: string;
  project: string; task: string; appendix: string; title: string; issue: string;
};
export type PurchaseLine = {
  lineNo: number; no: string; description: string; description2: string; quantity: number; directUnitCost: number;
  project: string; task: string; lineAmount: number; title: string; issue: string;
};

const r2 = (v: number) => Math.round(v * 100) / 100;
// Número alemán "1.234,56" → 1234.56
const de = (s: string) => parseFloat(s.replace(/\./g, '').replace(',', '.'));

// "6/26" o (Ajahr 2026, Anr 6) → "2606"
const yymm = (issue: string) => { const [m, y] = issue.split('/'); return `${y.padStart(2, '0')}${m.padStart(2, '0')}`; };
function itemFor(title: string, issue: string) {
  const t = TITLES[title];
  if (!t) return null;
  const suffix = `${yymm(issue)}${t.special ? '_SPECIAL' : ''}`;
  return { item: `${t.item}_${suffix}`, project: `${t.project}_${suffix}` };
}

// ---------- PDF ----------

export type PdfLine = { appendix: string; title: string; sparte: string; issue: string; qty: number; price: number; amount: number };

// Filas de texto del PDF (elementos con la misma altura unidos de izquierda a derecha)
async function pdfRows(data: Uint8Array): Promise<string[][]> {
  const pdf = await getDocumentProxy(data);
  const out: string[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    const items = (tc.items as any[]).filter(i => i.str && i.str.trim()).map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] }));
    const rows: { y: number; items: typeof items }[] = [];
    for (const it of items) {
      const row = rows.find(r => Math.abs(r.y - it.y) < 2);
      if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y).forEach(r => out.push(r.items.sort((a, b) => a.x - b.x).map(i => i.s)));
  }
  return out;
}

export async function parsePdf(data: Uint8Array) {
  const rows = await pdfRows(data);
  const lines: PdfLine[] = [];
  let appendix = '', title = '', creditNo = '', netTotal: number | null = null, period = '';
  rows.forEach((cells, i) => {
    const text = cells.join(' ');
    const anlage = text.match(/^Anlage (\w+)$/);
    if (anlage) { appendix = anlage[1]; title = ''; return; }
    if (cells[0] === 'Objekt:' && cells[1]) { title = cells[1].split(' ')[0]; return; }
    if (cells[0] === 'Gutschrift-Nr.' || /Gutschrift-Nr\./.test(text)) {
      const next = rows[i + 1]; const idx = cells.indexOf('Gutschrift-Nr.');
      if (next && idx >= 0 && !creditNo) creditNo = next[idx] || '';
    }
    const lz = text.match(/Leistungszeitraum (\d{2}\.\d{2}\.\d{4}) bis (\d{2}\.\d{2}\.\d{4})/);
    if (lz) period = `${lz[1]} – ${lz[2]}`;
    if (cells[0] === 'Summe Netto:') netTotal = de(cells[1] ?? rows[i + 1]?.[0] ?? '');
    // Línea de venta: Sparte | Ausgabe | MwSt | Menge | Preis | Nettobetrag
    if (SALES_APPENDICES[appendix] && cells.length === 6 && /^\d{1,2}\/\d{2}$/.test(cells[1]) && /%$/.test(cells[2])) {
      lines.push({ appendix, title, sparte: cells[0], issue: cells[1], qty: de(cells[3]), price: de(cells[4]), amount: de(cells[5]) });
    }
  });
  return { creditNo, period, netTotal, lines };
}

// ---------- Excel ----------

export type ExcelRow = { title: string; issue: string; vorgang: number; text: string; country: string; qty: number; price: number; amount: number };

export function parseExcel(data: ArrayBuffer | Uint8Array) {
  const wb = XLSX.read(data, { type: 'array' });
  const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
  const header = (rows[0] || []).map((h: any) => String(h ?? '').trim());
  const col = (name: string) => header.indexOf(name);
  const C = { title: col('TitelNr'), year: col('Ajahr'), issue: col('Anr'), vorgang: col('Vorgang'), text: col('Buchungstext'), country: col('Land'), qty: col('Menge'), price: col('Einzelpreis'), amount: col('Nettobetrag'), invoice: col('RechnungsNr') };
  const missing = Object.entries(C).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) throw new Error(`El Excel no parece la exportación de Curasoft de D-FORCE (faltan columnas: ${missing.join(', ')}).`);
  const num = (v: any) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')) || 0);
  const out: ExcelRow[] = rows.slice(1).filter(r => r && r[C.vorgang] != null && r[C.title] != null).map(r => ({
    title: String(r[C.title]).trim(), issue: `${num(r[C.issue])}/${String(num(r[C.year])).slice(-2)}`,
    vorgang: num(r[C.vorgang]), text: String(r[C.text] ?? '').trim(), country: String(r[C.country] ?? '').trim(),
    qty: num(r[C.qty]), price: num(r[C.price]), amount: num(r[C.amount]),
  }));
  const invoiceNo = String(rows[1]?.[C.invoice] ?? '').trim();
  return { invoiceNo, rows: out };
}

// ---------- Documentos ----------

export function buildDocuments(pdf: Awaited<ReturnType<typeof parsePdf>>, excel: ReturnType<typeof parseExcel>) {
  const warnings: string[] = [];
  const unknownTitles = new Set<string>();

  // Ventas, en el orden del PDF
  const invoice: SalesLine[] = [];
  const credit: SalesLine[] = [];
  for (const l of pdf.lines) {
    const map = itemFor(l.title, l.issue);
    if (!map) { unknownTitles.add(l.title); continue; }
    const kind = SALES_APPENDICES[l.appendix];
    const base = { no: map.item, description: '', description2: l.sparte, unitPrice: l.price, unitCost: null, project: map.project, appendix: l.appendix, title: l.title, issue: l.issue };
    if (kind.doc === 'Invoice') {
      invoice.push({ ...base, documentType: 'Invoice', lineNo: 0, quantity: l.qty, amount: l.amount, returnReason: '', task: '001.001' });
    } else {
      // Devolución: en positivo; no recuperable (sin vuelta al almacén) si es de Bahnhofsbuchhandel o del extranjero
      const nonRec = l.appendix === 'RA' || /bahnhofsbuchhandel/i.test(l.sparte);
      credit.push({ ...base, documentType: 'Credit Memo', lineNo: 0, quantity: -l.qty, amount: -l.amount, returnReason: nonRec ? NON_REC : '', task: '001.003' });
    }
  }
  // Contrapartidas en negativo de las devoluciones no recuperables, al final del abono
  const reversals = credit.filter(l => l.returnReason === NON_REC).map(l => ({ ...l, description2: '', quantity: -l.quantity, amount: -l.amount, task: '' }));
  credit.push(...reversals);
  invoice.forEach((l, i) => { l.lineNo = (i + 1) * 10000; });
  credit.forEach((l, i) => { l.lineNo = (i + 1) * 10000; });

  // Compras, del Excel: por concepto, revista y número
  const purchase: PurchaseLine[] = [];
  const titleOrder = Object.keys(TITLES);
  for (const t of PURCHASE_TYPES) {
    const groups = new Map<string, { title: string; issue: string; amount: number }>();
    for (const r of excel.rows.filter(r => r.vorgang === t.vorgang)) {
      const key = `${r.title}|${r.issue}`;
      const g = groups.get(key) || { title: r.title, issue: r.issue, amount: 0 };
      g.amount += r.amount;
      groups.set(key, g);
    }
    const sorted = Array.from(groups.values()).sort((a, b) =>
      (titleOrder.indexOf(a.title) - titleOrder.indexOf(b.title)) || yymm(a.issue).localeCompare(yymm(b.issue)));
    for (const g of sorted) {
      const map = itemFor(g.title, g.issue);
      if (!map) { unknownTitles.add(g.title); continue; }
      const cost = r2(-g.amount);
      purchase.push({ lineNo: 0, no: t.item, description: t.description, description2: t.description2, quantity: 1, directUnitCost: cost, project: map.project, task: t.task, lineAmount: cost, title: g.title, issue: g.issue });
    }
  }
  purchase.forEach((l, i) => { l.lineNo = (i + 1) * 10000; });
  const unknownVorgang = Array.from(new Set(excel.rows.map(r => r.vorgang))).filter(v => ![10, 11, 20, 21, 160, 161].includes(v) && !PURCHASE_TYPES.some(t => t.vorgang === v));
  if (unknownVorgang.length) warnings.push(`El Excel tiene tipos de movimiento (Vorgang) que no se usan: ${unknownVorgang.join(', ')}.`);
  if (unknownTitles.size) warnings.push(`Revistas sin artículo/proyecto configurado (no se incluyen): ${Array.from(unknownTitles).join(', ')}.`);

  // Comprobaciones: ventas del PDF contra el Excel, y neto contra la Gutschrift
  const sum = (list: { amount: number }[]) => r2(list.reduce((s, l) => s + l.amount, 0));
  const excelSales = r2(excel.rows.filter(r => [10, 11, 20, 21, 160, 161].includes(r.vorgang)).reduce((s, r) => s + r.amount, 0));
  const pdfSales = r2(pdf.lines.reduce((s, l) => s + l.amount, 0));
  if (Math.abs(excelSales - pdfSales) > 0.05) warnings.push(`Las ventas y devoluciones del PDF (${pdfSales}) no cuadran con las del Excel (${excelSales}).`);
  if (excel.invoiceNo && pdf.creditNo && excel.invoiceNo !== pdf.creditNo) warnings.push(`El PDF (Gutschrift ${pdf.creditNo}) y el Excel (RechnungsNr ${excel.invoiceNo}) son de documentos distintos.`);
  // El neto de la Gutschrift abona todas las devoluciones: se compara antes de las contrapartidas NON-REC
  const returns = sum(credit.filter(l => l.description2));
  const totals = {
    invoice: sum(invoice), returns, nonRecReversals: sum(reversals), creditMemo: sum(credit),
    purchase: r2(purchase.reduce((s, l) => s + l.lineAmount, 0)), net: 0, pdfNet: pdf.netTotal,
  };
  totals.net = r2(totals.invoice - totals.returns - totals.purchase);
  if (pdf.netTotal != null && Math.abs(totals.net - pdf.netTotal) > 0.05) warnings.push(`El neto calculado (${totals.net}) no cuadra con la Summe Netto del PDF (${pdf.netTotal}).`);

  return { creditNo: pdf.creditNo || excel.invoiceNo, period: pdf.period, invoice, credit, purchase, totals, warnings };
}
