import { bcFetchAll, odataUrl, type BcContext } from '@/lib/bcClient';
import { attachFile, bcRequest } from '@/lib/bcWrite';
import { readSetting } from '@/lib/reporting/cache';
import { CUSTOMER_NO, LOCATION, PURCHASE_VAT, SALES_VAT, VENDOR_NO, type PurchaseLine, type SalesLine } from '@/lib/dforce';
import type { JournalLine } from '@/lib/dforceProvisions';

// D-FORCE en BC (Craze Entertainment): crea sin registrar la Sales Invoice, el Sales Credit Memo y la Purchase Invoice
// de la Gutschrift, con el PDF y el Excel adjuntos, y las provisiones como líneas del General Journal Batch D-FORCE.
// - Cabecera y líneas por la API v2 (como OCR y Aduanas); el nº de la Gutschrift va en External Document No. (ventas)
//   y Vendor Invoice No. (compra), y sirve para no duplicar.
// - Project No., Project Task No., Project Task No.2 y Return Reason Code no están en las líneas de la API v2: se ponen
//   después por OData en un servicio web de líneas (ventas: líneas de las páginas 43/44 publicadas, campos AIT; compras:
//   Purchase Lines editable), buscado por nombre o fijado con el ajuste dforceLinesService { invoice, credit, purchase }.

export const JOURNAL_BATCH = 'D-FORCE';
export type DForceKind = 'invoice' | 'credit' | 'purchase' | 'journal';
type Attachment = { name: string; data: Uint8Array };

const DOCS = {
  invoice: { label: 'Sales Invoice', entity: 'salesInvoices', lines: 'salesInvoiceLines', parentType: 'Sales Invoice', side: 'sales' },
  credit: { label: 'Sales Credit Memo', entity: 'salesCreditMemos', lines: 'salesCreditMemoLines', parentType: 'Sales Credit Memo', side: 'sales' },
  purchase: { label: 'Purchase Invoice', entity: 'purchaseInvoices', lines: 'purchaseInvoiceLines', parentType: 'Purchase Invoice', side: 'purchase' },
} as const;
export const KIND_LABEL: Record<DForceKind, string> = { ...Object.fromEntries(Object.entries(DOCS).map(([k, d]) => [k, d.label])), journal: `Diario ${JOURNAL_BATCH}` } as Record<DForceKind, string>;

const q = (s: string) => s.replace(/'/g, "''");
const short = (e: any) => String(e?.message || e).substring(0, 200);

// Documentos de D-FORCE con ese nº de Gutschrift, en borrador o registrados (la API v2 devuelve los dos)
export async function existingDocs(ctx: BcContext, kind: Exclude<DForceKind, 'journal'>, ref: string) {
  const filter = kind === 'purchase'
    ? `vendorNumber eq '${VENDOR_NO}' and vendorInvoiceNumber eq '${q(ref)}'`
    : `customerNumber eq '${CUSTOMER_NO}' and externalDocumentNumber eq '${q(ref)}'`;
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/${DOCS[kind].entity}`, { $filter: filter, $select: 'number,status' }), ctx.token);
  return rows.map((r: any) => ({ no: String(r.number), posted: r.status !== 'Draft' }));
}

// ---------- Campos de línea fuera de la API v2 ----------

type Extras = { project: string; task: string; task2?: string; returnReason?: string };
// Ventas: el proyecto va en los campos de la extensión AIT (AIT_Job_No, AIT_Job_Task_No, AIT_Job_Task_No_2), como en
// todas las facturas y abonos de D-FORCE registrados; el Job No. estándar de las líneas de venta queda vacío.
// Compras: los estándar (Job_No, Job_Task_No).
const FIELD_PATTERNS: Record<'sales' | 'purchase', Record<keyof Extras, RegExp>> = {
  sales: {
    project: /^ait_?job_?no$/i,
    task: /^ait_?job_?task_?no$/i,
    task2: /^ait_?job_?task_?no_?2$/i,
    returnReason: /^return_?reason_?code$/i,
  },
  purchase: {
    project: /^(job|project)_?(no|number)$/i,
    task: /^(job|project)_?task_?(no|number)$/i,
    task2: /^(job|project)_?task_?(no|number)_?2$/i,
    returnReason: /^return_?reason_?code$/i,
  },
};
const FIELD_LABEL: Record<keyof Extras, string> = { project: 'Project No.', task: 'Project Task No.', task2: 'Project Task No.2', returnReason: 'Return Reason Code' };

// URL de @odata.editLink: BC la da relativa a la raíz del servicio, ya con Company('…'), o absoluta
function editUrl(ctx: BcContext, link: string) {
  if (/^https?:/.test(link)) return link;
  return /^Company\(/i.test(link) ? `${ctx.odataCompanyBase.replace(/\/Company\(.*$/, '')}/${link}` : `${ctx.odataCompanyBase}/${link}`;
}

async function odataGet(ctx: BcContext, url: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json;odata.metadata=full' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
  return res.json();
}

// Servicios OData candidatos: el del ajuste o, por nombre, en ventas las líneas de la página 43/44 publicada
// (Sales_Invoice_ExcelSalesLines, Sales_Credit_Memo_ExcelSalesLines: tienen los campos AIT) y en compras las de
// Purchase … Lines (purchaseDocumentLines, Purchase_Lines_Editable_Excel…; los "_Excel" no editables, al final)
async function lineServiceNames(ctx: BcContext, kind: Exclude<DForceKind, 'journal'>) {
  const side = DOCS[kind].side;
  const configured = await readSetting<Record<string, string>>('dforceLinesService', {});
  if (configured[kind]) return [configured[kind]];
  const root = ctx.odataCompanyBase.replace(/\/Company\(.*$/, '');
  const res = await fetch(root, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
  if (!res.ok) return [];
  const list: string[] = ((await res.json()).value || []).map((s: any) => s.name);
  if (side === 'sales') {
    const own = kind === 'invoice' ? /^sales_?invoice/i : /^sales_?cr(edit)?_?memo/i;
    return list.filter(n => own.test(n) && /sales_?lines$/i.test(n));
  }
  const pattern = /^purch(ase)?.?(document.?)?lines?/i;
  const late = (n: string) => Number(/excel/i.test(n) && !/editable/i.test(n));
  return list.filter(n => pattern.test(n) && !/posted|archiv|shipment|receipt/i.test(n)).sort((a, b) => late(a) - late(b));
}

// Pone en las líneas ya creadas los campos que la API v2 no tiene. byLine: Line No. → valores. Devuelve avisos.
async function setLineExtras(ctx: BcContext, kind: Exclude<DForceKind, 'journal'>, docNo: string, byLine: Map<number, Extras>) {
  const side = DOCS[kind].side;
  const wanted = new Set<keyof Extras>();
  byLine.forEach(e => (Object.keys(e) as (keyof Extras)[]).forEach(k => { if (e[k]) wanted.add(k); }));
  if (!wanted.size) return [];
  const fieldList = Array.from(wanted).map(k => FIELD_LABEL[k]).join(', ');
  const tried: string[] = [];
  for (const name of await lineServiceNames(ctx, kind)) {
    const base = `${ctx.odataCompanyBase}/${name}`;
    // Páginas publicadas (Document_No, Line_No) o de tipo API (documentNumber, lineNumber)
    let rows: any[] = [], error = '';
    for (const docField of ['Document_No', 'documentNumber', 'documentNo']) {
      try {
        rows = (await odataGet(ctx, odataUrl(base, { $filter: `${docField} eq '${q(docNo)}'` }))).value || [];
        error = '';
        break;
      } catch (e) { error ||= short(e); }
    }
    if (error) { tried.push(`${name}: ${error}`); continue; }
    if (!rows.length) { tried.push(`${name}: no devuelve las líneas de ${docNo}`); continue; }
    const keys = Object.keys(rows[0]);
    const field = (k: keyof Extras) => keys.find(x => FIELD_PATTERNS[side][k].test(x));
    const missing = Array.from(wanted).filter(k => !field(k));
    if (missing.includes('project') || missing.includes('task')) { tried.push(`${name}: sin ${missing.map(k => FIELD_LABEL[k]).join(', ')}`); continue; }

    const warnings: string[] = [];
    if (missing.length) warnings.push(`${docNo}: el servicio ${name} no tiene ${missing.map(k => FIELD_LABEL[k]).join(', ')}; rellénalo en BC.`);
    let done = 0, failed = 0, firstError = '';
    for (const r of rows) {
      const e = byLine.get(Number(r.Line_No ?? r.lineNumber ?? r.lineNo));
      const link = r['@odata.editLink'];
      if (!e || !link) continue;
      const url = editUrl(ctx, link);
      // El proyecto primero: la tarea se valida contra él
      const rest: Record<string, string> = {};
      for (const k of ['task', 'task2', 'returnReason'] as const) if (e[k] && field(k)) rest[field(k)!] = e[k]!;
      try {
        await bcRequest('PATCH', url, ctx.token, { [field('project')!]: e.project, ...rest });
        done++;
      } catch {
        try {
          await bcRequest('PATCH', url, ctx.token, { [field('project')!]: e.project });
          if (Object.keys(rest).length) await bcRequest('PATCH', url, ctx.token, rest);
          done++;
        } catch (err) { failed++; firstError ||= short(err); }
      }
      // Si la primera línea no se deja modificar, el servicio no sirve: probar el siguiente
      if (failed && !done) break;
    }
    if (failed && !done) { tried.push(`${name}: ${firstError}`); continue; }
    if (failed) warnings.push(`${docNo}: ${failed} líneas sin ${fieldList} (${firstError}); complétalas en BC.`);
    return warnings;
  }
  return [`${docNo}: no se han podido poner ${fieldList} en las líneas: ${tried.length ? tried.join(' · ') : 'no hay ningún servicio web OData de líneas publicado'}. ` +
    (side === 'sales'
      ? `Publica en "Servicios web" la página ${kind === 'invoice' ? '43 "Sales Invoice"' : '44 "Sales Credit Memo"'} (sus líneas tienen los campos AIT) `
      : 'Publica en "Servicios web" una página de líneas de compra editable con esos campos ') +
    `(o indica el servicio en el ajuste dforceLinesService) o rellénalos en BC.`];
}

// ---------- Ignore Custom Qty. Fields ----------
// Los artículos de revista tienen múltiplo de venta (05995_2608: 30) y BC rechaza las líneas con otras cantidades
// ("The multiple quantity for product … is 30") salvo que la cabecera tenga activado "Ignore Custom Qty. Fields"
// (AIT_Ignore_Custom_Qty_Fields, campo de extensión que la API v2 no tiene). Se activa antes de añadir las líneas por
// una página de cabecera de venta publicada en OData que lo tenga (ajuste dforceSalesHeaderService o por nombre).
const IGNORE_QTY = /ignore_?custom_?qty/i;

async function salesHeaderServices(ctx: BcContext, kind: 'invoice' | 'credit') {
  const configured = await readSetting<Record<string, string>>('dforceSalesHeaderService', {});
  if (configured[kind]) return [configured[kind]];
  const root = ctx.odataCompanyBase.replace(/\/Company\(.*$/, '');
  const res = await fetch(root, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
  if (!res.ok) return [];
  const list: string[] = ((await res.json()).value || []).map((s: any) => s.name);
  const own = kind === 'invoice' ? /invoice/i : /cr(edit)?_?memo/i;
  return list.filter(n => /^sales_?(invoice|cr(edit)?_?memo)/i.test(n) && own.test(n) && !/line|posted|archiv/i.test(n));
}

async function ignoreCustomQty(ctx: BcContext, kind: 'invoice' | 'credit', no: string) {
  const tried: string[] = [];
  for (const name of await salesHeaderServices(ctx, kind)) {
    const base = `${ctx.odataCompanyBase}/${name}`;
    try {
      const row = (await odataGet(ctx, odataUrl(base, { $filter: `No eq '${q(no)}'` }))).value?.[0];
      const field = row && Object.keys(row).find(k => IGNORE_QTY.test(k));
      if (!row) { tried.push(`${name}: no encuentra ${no}`); continue; }
      if (!field) { tried.push(`${name}: sin el campo Ignore Custom Qty. Fields`); continue; }
      if (row[field] === true) return;
      const link = row['@odata.editLink'];
      await bcRequest('PATCH', editUrl(ctx, link), ctx.token, { [field]: true });
      return;
    } catch (e) { tried.push(`${name}: ${short(e)}`); }
  }
  const page = kind === 'invoice' ? '43 "Sales Invoice"' : '44 "Sales Credit Memo"';
  throw new Error(`no se ha podido activar "Ignore Custom Qty. Fields" en ${no} (${tried.join(' · ') || 'no hay ninguna página publicada'}). ` +
    `Publica en "Servicios web" la página ${page} (nombre ${kind === 'invoice' ? 'SalesInvoice' : 'SalesCreditMemo'}).`);
}

// ---------- Documentos ----------

export type DocInput = { kind: Exclude<DForceKind, 'journal'>; ref: string; date: string; lines: (SalesLine | PurchaseLine)[] };

export async function createDocument(ctx: BcContext, input: DocInput, files: Attachment[]) {
  const d = DOCS[input.kind];
  const warnings: string[] = [];
  const sales = d.side === 'sales';
  const head = await bcRequest('POST', `${ctx.apiBase}/${d.entity}`, ctx.token, sales
    ? { customerNumber: CUSTOMER_NO, externalDocumentNumber: input.ref, postingDate: input.date, ...(input.kind === 'invoice' ? { invoiceDate: input.date } : { creditMemoDate: input.date }) }
    : { vendorNumber: VENDOR_NO, vendorInvoiceNumber: input.ref, invoiceDate: input.date, postingDate: input.date });
  const id: string = head.id, no: string = head.number;
  const headUrl = `${ctx.apiBase}/${d.entity}(${id})`;
  const extras = new Map<number, Extras>();
  try {
    // Antes de las líneas: sin "Ignore Custom Qty. Fields" BC exige el múltiplo de venta de cada revista
    if (input.kind !== 'purchase') await ignoreCustomQty(ctx, input.kind, no);
    // Las líneas estándar que BC añade al poner el cliente/proveedor no son de la Gutschrift: fuera
    const auto = await bcRequest('GET', `${headUrl}/${d.lines}?$select=id`, ctx.token);
    for (const l of auto?.value || []) await bcRequest('DELETE', `${headUrl}/${d.lines}(${l.id})`, ctx.token);
    let locationId = '';
    if (sales) {
      const loc = await bcRequest('GET', odataUrl(`${ctx.apiBase}/locations`, { $filter: `code eq '${LOCATION}'`, $select: 'id' }), ctx.token);
      locationId = loc?.value?.[0]?.id || '';
      if (!locationId) warnings.push(`No existe el almacén ${LOCATION} en BC: las líneas van sin Location Code.`);
    }
    for (const line of input.lines) {
      const body = sales
        ? (l => ({
          lineType: 'Item', lineObjectNumber: l.no, quantity: l.quantity, unitPrice: l.unitPrice, taxCode: SALES_VAT,
          ...(l.description ? { description: l.description } : {}), ...(l.description2 ? { description2: l.description2.substring(0, 50) } : {}),
          ...(locationId ? { locationId } : {}),
        }))(line as SalesLine)
        : (l => ({
          lineType: 'Item', lineObjectNumber: l.no, quantity: l.quantity, unitCost: l.directUnitCost, taxCode: PURCHASE_VAT,
          description: l.description, description2: l.description2.substring(0, 50),
        }))(line as PurchaseLine);
      const created = await bcRequest('POST', `${headUrl}/${d.lines}`, ctx.token, body);
      const s = line as SalesLine;
      // Líneas sin revista (cargos generales de la compra): sin proyecto ni tarea
      if (line.project) extras.set(Number(created.sequence), { project: line.project, task: line.task, task2: s.task2 || undefined, returnReason: s.returnReason || undefined });
    }
  } catch (e) {
    // No dejar un documento a medias
    await bcRequest('DELETE', headUrl, ctx.token).catch(() => {});
    throw e;
  }
  try {
    warnings.push(...await setLineExtras(ctx, input.kind, no, extras));
  } catch (e) {
    warnings.push(`${no}: no se han podido poner proyecto y tarea en las líneas (${short(e)}); complétalos en BC.`);
  }
  for (const f of files) {
    try {
      await attachFile(ctx, id, f, d.parentType);
    } catch (e) {
      warnings.push(`${no}: no se ha podido adjuntar ${f.name} (${short(e)}); adjúntalo en BC.`);
    }
  }
  const after = await bcRequest('GET', headUrl, ctx.token).catch(() => null);
  return { id, no, lines: input.lines.length, net: after?.totalAmountExcludingTax ?? null, warnings };
}

// ---------- Diario de provisiones ----------

async function journalBatch(ctx: BcContext) {
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/journals`, { $filter: `code eq '${JOURNAL_BATCH}'`, $select: 'id,code' }), ctx.token);
  if (!rows.length) throw new Error(`No existe el General Journal Batch ${JOURNAL_BATCH} en la plantilla de diario general de la API de BC. Créalo en BC.`);
  return rows[0].id as string;
}

// Líneas que ya están en el lote con los mismos nº de documento y fecha (enviadas antes y sin registrar)
export async function existingJournalLines(ctx: BcContext, lines: JournalLine[]) {
  const id = await journalBatch(ctx);
  const rows = await bcFetchAll(odataUrl(`${ctx.apiBase}/journals(${id})/journalLines`, { $select: 'documentNumber,postingDate' }), ctx.token);
  const ours = new Set(lines.map(l => `${l.documentNo}|${l.postingDate}`));
  return Array.from(new Set(rows.filter((r: any) => ours.has(`${r.documentNumber}|${r.postingDate}`)).map((r: any) => String(r.documentNumber))));
}

// Añade las líneas al lote D-FORCE (sin registrar) y adjunta los ficheros a la primera
export async function createJournalLines(ctx: BcContext, lines: JournalLine[], files: Attachment[]) {
  const id = await journalBatch(ctx);
  const base = `${ctx.apiBase}/journals(${id})/journalLines`;
  const created: string[] = [];
  const warnings: string[] = [];
  try {
    for (const l of lines) {
      const r = await bcRequest('POST', base, ctx.token, {
        accountType: 'G/L Account', accountNumber: l.accountNo, postingDate: l.postingDate, documentNumber: l.documentNo,
        description: l.description.substring(0, 100), amount: l.amount, balanceAccountType: 'G/L Account', balancingAccountNumber: l.balAccountNo,
      });
      created.push(r.id);
    }
  } catch (e) {
    // No dejar el envío a medias
    for (const lineId of created) await bcRequest('DELETE', `${base}(${lineId})`, ctx.token).catch(() => {});
    throw e;
  }
  for (const f of files) {
    try {
      await attachFile(ctx, created[0], f, 'Journal');
    } catch (e) {
      warnings.push(`No se ha podido adjuntar ${f.name} a la primera línea del diario (${short(e)}); adjúntalo en BC.`);
    }
  }
  return { no: JOURNAL_BATCH, lines: created.length, net: null, warnings };
}
