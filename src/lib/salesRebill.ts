import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { bcRequest } from '@/lib/bcWrite';
import { readSetting, writeSetting } from '@/lib/reporting/cache';
import { editUrl, ignoreCustomQty, odataGet, salesHeaderServices } from '@/lib/dforceBc';

// Combinación de IVA de la factura bloqueada o que ya no existe (NO VAT…): VAT Bus. NAC y VAT Prod. OHNE MWST
export const FALLBACK_VAT_BUS = 'NAC';
export const FALLBACK_VAT_PROD = 'OHNE MWST';

// VAT Bus. Posting Group de la cabecera (no está en v2): por la página 43/44 publicada en OData
async function setVatBus(ctx: BcContext, kind: 'invoice' | 'credit', no: string, group: string) {
  const tried: string[] = [];
  for (const name of await salesHeaderServices(ctx, kind)) {
    try {
      const row = (await odataGet(ctx, odataUrl(`${ctx.odataCompanyBase}/${name}`, { $filter: `No eq '${q(no)}'` }))).value?.[0];
      const field = row && Object.keys(row).find(k => /^vat_?bus_?posting_?group$/i.test(k));
      if (!row || !field) { tried.push(`${name}: ${row ? 'sin el campo VAT Bus. Posting Group' : `no encuentra ${no}`}`); continue; }
      if (row[field] !== group) await bcRequest('PATCH', editUrl(ctx, row['@odata.editLink']), ctx.token, { [field]: group });
      return;
    } catch (e: any) { tried.push(`${name}: ${String(e?.message).substring(0, 160)}`); }
  }
  throw new Error(`no se ha podido poner VAT Bus. Posting Group ${group} en ${no} (${tried.join(' · ') || 'no hay página de cabecera de venta publicada'})`);
}

// Refacturación por precio: por cada factura de venta registrada, sin registrar nada:
//  1) Sales Credit Memo corrector (acción estándar de BC "Create Corrective Credit Memo", v2
//     salesInvoices(id)/Microsoft.NAV.makeCorrectiveCreditMemo: copia todos los campos y queda liquidado contra la factura);
//  2) Sales Invoice nueva, copia de la original (cliente, envío, divisa, condiciones, External Document No., líneas con
//     su almacén, unidad e IVA) con Unit Price = coste unitario de la línea (Unit Cost (LCY) de la factura) × (1 + markup)
//     y sin descuento de línea.
// Lo creado se guarda en el setting rebill:<empresa>:<factura> para no duplicarlo si se vuelve a lanzar.

const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => Number(v) || 0;
const q = (v: string) => v.replace(/'/g, "''");
const r5 = (v: number) => Math.round(v * 100000) / 100000;

export type RebillLine = {
  sequence: number; type: string; no: string; description: string; uom: string; qty: number;
  oldPrice: number; discount: number; unitCost: number; newPrice: number | null; oldNet: number; newNet: number;
};
export type RebillPlan = {
  invoice: string; customer: string; customerName: string; currency: string; externalDocumentNumber: string;
  oldNet: number; newNet: number; lines: RebillLine[]; warnings: string[];
  done?: { creditMemo?: string; invoice?: string };
  // Lo que impide crear los documentos (artículos o cliente bloqueados, grupos de IVA que no existen…)
  blockers: string[];
  vatFallback?: boolean;
};

const HEADER_FIELDS = [
  'customerNumber', 'billToCustomerNumber', 'shipToName', 'shipToContact', 'shipToAddressLine1', 'shipToAddressLine2', 'shipToCity',
  'shipToCountry', 'shipToState', 'shipToPostCode', 'currencyCode', 'paymentTermsId', 'shipmentMethodId', 'salesperson',
  'externalDocumentNumber', 'customerPurchaseOrderReference', 'phoneNumber', 'email',
];

async function invoiceOf(ctx: BcContext, no: string) {
  const [h] = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, { $filter: `number eq '${q(no)}'` }), ctx.token);
  if (!h) throw new Error(`No existe la factura ${no}`);
  if (/draft/i.test(s(h.status))) throw new Error(`${no} no está registrada`);
  return h;
}

export async function planRebill(ctx: BcContext, company: string, no: string, markup: number): Promise<RebillPlan> {
  const h = await invoiceOf(ctx, no);
  const [v2Lines, custom, ledger] = await Promise.all([
    bcFetchAll(`${ctx.apiBase}/salesInvoices(${h.id})/salesInvoiceLines`, ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/salesInvoiceLines`, { $filter: `documentNo eq '${q(no)}'` }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/custLedgerEntries`, { $filter: `documentNo eq '${q(no)}'`, $select: 'documentNo,amount,amountLCY' }), ctx.token).catch(() => [] as any[]),
  ]);
  const warnings: string[] = [];
  const costBySeq = new Map<number, number>(custom.map((l: any) => [n(l.lineNo), n(l.unitCostLCY)]));
  // Coste en divisa local → divisa de la factura
  const e = ledger.find((x: any) => n(x.amount));
  const fx = s(h.currencyCode) && e ? n(e.amountLCY) / n(e.amount) : 1;
  if (s(h.currencyCode) && !e) warnings.push(`Factura en ${h.currencyCode} sin tipo de cambio: el coste se usa tal cual (LCY).`);
  const lines: RebillLine[] = v2Lines.sort((a: any, b: any) => n(a.sequence) - n(b.sequence)).map((l: any) => {
    const type = s(l.lineType), qty = n(l.quantity), seq = n(l.sequence);
    const isItem = type === 'Item';
    const unitCost = isItem ? (costBySeq.get(seq) ?? 0) / (fx || 1) : 0;
    if (isItem && qty && !unitCost) warnings.push(`Línea ${seq} (${s(l.lineObjectNumber)}): sin coste unitario en la factura; se deja su precio.`);
    const newPrice = isItem && qty && unitCost ? r5(unitCost * (1 + markup)) : null;
    const oldNet = n(l.netAmount ?? l.amountExcludingTax);
    return {
      sequence: seq, type, no: s(l.lineObjectNumber), description: s(l.description), uom: s(l.unitOfMeasureCode), qty,
      oldPrice: n(l.unitPrice), discount: n(l.discountPercent), unitCost: r5(unitCost), newPrice,
      oldNet, newNet: newPrice !== null ? Math.round(newPrice * qty * 100) / 100 : oldNet,
    };
  });
  // Lo creado antes solo cuenta si sigue en BC sin registrar (si se ha borrado, se vuelve a crear)
  const saved = await readSetting<{ creditMemo?: string; invoice?: string }>(`rebill:${company}:${no}`, {});
  const done: { creditMemo?: string; invoice?: string } = {};
  if (saved.creditMemo) {
    const x = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesCreditMemos`, { $filter: `number eq '${q(saved.creditMemo)}' and status eq 'Draft'`, $select: 'number' }), ctx.token).catch(() => []);
    if (x.length) done.creditMemo = saved.creditMemo;
  }
  if (saved.invoice) {
    const x = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, { $filter: `number eq '${q(saved.invoice)}' and status eq 'Draft'`, $select: 'number' }), ctx.token).catch(() => []);
    if (x.length) done.invoice = saved.invoice;
  }
  if ((saved.creditMemo || saved.invoice) && (saved.creditMemo !== done.creditMemo || saved.invoice !== done.invoice)) await writeSetting(`rebill:${company}:${no}`, done);
  // Comprobaciones previas: cliente, artículos y grupos de IVA de las líneas
  const blockers: string[] = [];
  const itemNos = [...new Set(lines.filter(l => l.type === 'Item' && l.no).map(l => l.no))];
  const [cust, items, taxGroups] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.apiBase}/customers`, { $filter: `number eq '${q(s(h.customerNumber))}'`, $select: 'number,blocked' }), ctx.token),
    itemNos.length ? bcFetchAll(odataUrl(`${ctx.apiBase}/items`, { $filter: itemNos.map(x => `number eq '${q(x)}'`).join(' or '), $select: 'number,blocked,taxGroupCode' }), ctx.token) : Promise.resolve([]),
    bcFetchAll(odataUrl(`${ctx.apiBase}/taxGroups`, { $select: 'code' }), ctx.token).catch(() => [] as any[]),
  ]);
  if (s(cust[0]?.blocked) && !/^\s*$|^_x0020_$/.test(s(cust[0]?.blocked))) blockers.push(`cliente ${h.customerNumber} bloqueado (${cust[0].blocked})`);
  for (const no2 of itemNos) {
    const it = items.find((x: any) => s(x.number) === no2);
    if (!it) blockers.push(`artículo ${no2} no existe`);
    else if (it.blocked === true) blockers.push(`artículo ${no2} bloqueado`);
  }
  const codes = new Set(taxGroups.map((x: any) => s(x.code)));
  for (const t of new Set(v2Lines.map((l: any) => s(l.taxCode)).filter(Boolean))) {
    if (codes.size && !codes.has(t as string)) {
      if (!codes.has(FALLBACK_VAT_PROD)) blockers.push(`el grupo de IVA ${t} no existe en BC y tampoco ${FALLBACK_VAT_PROD}`);
      else warnings.push(`IVA ${t} bloqueado o inexistente: abono y factura nueva con ${FALLBACK_VAT_BUS} / ${FALLBACK_VAT_PROD}.`);
    }
  }
  const vatFallback = warnings.some(w => w.includes(FALLBACK_VAT_PROD));
  return {
    vatFallback, invoice: no, customer: s(h.customerNumber), customerName: s(h.customerName), currency: s(h.currencyCode),
    externalDocumentNumber: s(h.externalDocumentNumber), oldNet: n(h.totalAmountExcludingTax),
    newNet: Math.round(lines.reduce((t, l) => t + l.newNet, 0) * 100) / 100, lines, warnings,
    done: done.creditMemo || done.invoice ? done : undefined, blockers,
  };
}

// POST quitando los campos que esa entidad de v2 no tiene (los abonos no llevan dirección de envío…)
async function postPruned(ctx: BcContext, url: string, body: Record<string, unknown>) {
  const b = { ...body };
  for (let i = 0; i < 15; i++) {
    try { return await bcRequest('POST', url, ctx.token, b); } catch (e: any) {
      const m = String(e?.message).match(/property '(\w+)' does not exist|Control '(\w+)' is read-only/);
      const f = m?.[1] || m?.[2];
      if (!f || !(f in b)) throw e;
      delete b[f];
    }
  }
  throw new Error('No se ha podido crear el documento');
}

// Copia las líneas de la factura original en un documento nuevo (price: precio nuevo por línea, o el original)
async function copyLines(ctx: BcContext, srcId: string, base: string, linesEntity: string, price: (l: any) => { unitPrice: number; discountPercent: number }, vatFallback = false) {
  const auto = await bcRequest('GET', `${base}/${linesEntity}?$select=id`, ctx.token);
  for (const l of auto?.value || []) await bcRequest('DELETE', `${base}/${linesEntity}(${l.id})`, ctx.token);
  const src = await bcFetchAll(`${ctx.apiBase}/salesInvoices(${srcId})/salesInvoiceLines`, ctx.token);
  for (const l of src.sort((a: any, b: any) => n(a.sequence) - n(b.sequence))) {
    const type = s(l.lineType);
    const body: Record<string, unknown> = { lineType: type || 'Comment', description: s(l.description) };
    if (s(l.description2)) body.description2 = s(l.description2);
    if (type && type !== 'Comment') {
      Object.assign(body, { lineObjectNumber: s(l.lineObjectNumber), quantity: n(l.quantity), ...price(l) });
      if (s(l.unitOfMeasureCode)) body.unitOfMeasureCode = s(l.unitOfMeasureCode);
      if (vatFallback) body.taxCode = FALLBACK_VAT_PROD;
      else if (s(l.taxCode)) body.taxCode = s(l.taxCode);
      if (s(l.locationId) && s(l.locationId) !== '00000000-0000-0000-0000-000000000000') body.locationId = s(l.locationId);
    }
    try {
      await bcRequest('POST', `${base}/${linesEntity}`, ctx.token, body);
    } catch (e: any) {
      // Grupo de IVA de la factura que ya no existe (NO VAT): el que BC ponga por defecto al artículo
      if (!body.taxCode || !/VAT Prod\. Posting Group/i.test(String(e?.message))) throw e;
      delete body.taxCode;
      await bcRequest('POST', `${base}/${linesEntity}`, ctx.token, body);
      notes.add(`el grupo de IVA ${s(l.taxCode)} de la factura original ya no existe: las líneas llevan el IVA por defecto del artículo, revísalo`);
    }
  }
}
const notes = new Set<string>();
const headerOf = (h: any) => {
  const head: Record<string, unknown> = {};
  for (const f of HEADER_FIELDS) if (h[f] !== undefined && h[f] !== null && h[f] !== '' && h[f] !== '00000000-0000-0000-0000-000000000000') head[f] = h[f];
  return head;
};

// Al cambiar el IVA BC recalcula el precio de las líneas del abono (pierde el descuento): se vuelven a poner el precio y el
// descuento de cada línea de la factura original (emparejadas en orden por artículo y cantidad)
export async function restorePrices(ctx: BcContext, invoiceId: string, cmId: string) {
  const [src, cl] = await Promise.all([
    bcFetchAll(`${ctx.apiBase}/salesInvoices(${invoiceId})/salesInvoiceLines`, ctx.token),
    bcFetchAll(`${ctx.apiBase}/salesCreditMemos(${cmId})/salesCreditMemoLines`, ctx.token),
  ]);
  const pending = src.filter((l: any) => s(l.lineType) && s(l.lineType) !== 'Comment').sort((a: any, b: any) => n(a.sequence) - n(b.sequence));
  for (const l of cl.filter((x: any) => s(x.lineType) && s(x.lineType) !== 'Comment').sort((a: any, b: any) => n(a.sequence) - n(b.sequence))) {
    const i = pending.findIndex((o: any) => s(o.lineObjectNumber) === s(l.lineObjectNumber) && n(o.quantity) === n(l.quantity));
    if (i < 0) continue;
    const o = pending.splice(i, 1)[0];
    if (n(o.unitPrice) !== n(l.unitPrice) || n(o.discountPercent) !== n(l.discountPercent))
      await bcRequest('PATCH', `${ctx.apiBase}/salesCreditMemos(${cmId})/salesCreditMemoLines(${l.id})`, ctx.token, { unitPrice: n(o.unitPrice), discountPercent: n(o.discountPercent) });
  }
}

// Abono y factura nueva con la fecha de la factura original (registro y documento; el vencimiento lo recalcula BC)
export async function setOriginalDates(ctx: BcContext, no: string, done: { creditMemo?: string; invoice?: string }) {
  const h = await invoiceOf(ctx, no);
  const posting = s(h.postingDate).substring(0, 10), docDate = s(h.invoiceDate).substring(0, 10) || posting;
  const out: string[] = [];
  const fix = async (entity: 'salesCreditMemos' | 'salesInvoices', num: string | undefined, dateField: string) => {
    if (!num) return;
    const [d] = await bcFetchAll(odataUrl(`${ctx.apiBase}/${entity}`, { $filter: `number eq '${q(num)}' and status eq 'Draft'`, $select: `id,postingDate,${dateField}` }), ctx.token);
    if (!d) { out.push(`${num} no encontrado`); return; }
    if (s(d.postingDate).substring(0, 10) !== posting || s(d[dateField]).substring(0, 10) !== docDate)
      await bcRequest('PATCH', `${ctx.apiBase}/${entity}(${d.id})`, ctx.token, { [dateField]: docDate, postingDate: posting });
    out.push(`${num} → ${posting}`);
  };
  await fix('salesCreditMemos', done.creditMemo, 'creditMemoDate');
  await fix('salesInvoices', done.invoice, 'invoiceDate');
  return out;
}

// Unit Cost (LCY) de cada línea del abono y de la factura nueva = el de la factura original (BC pone el coste actual del
// artículo, o el ajustado del movimiento liquidado). Se cambia por la página 43/44 publicada en OData (v2 no lo tiene).
export async function setOriginalCosts(ctx: BcContext, no: string, done: { creditMemo?: string; invoice?: string }) {
  const orig = await bcFetchAll(odataUrl(`${ctx.customApiBase}/salesInvoiceLines`, { $filter: `documentNo eq '${q(no)}'` }), ctx.token);
  const src = orig.filter((l: any) => s(l.type) === 'Item').sort((a: any, b: any) => n(a.lineNo) - n(b.lineNo));
  const out: string[] = [];
  for (const [kind, num] of [['credit', done.creditMemo], ['invoice', done.invoice]] as const) {
    if (!num) continue;
    const services = (await salesHeaderServices(ctx, kind)).map(x => `${x}SalesLines`);
    let rows: any[] | null = null, svc = '';
    for (const name of services) {
      try { rows = (await odataGet(ctx, odataUrl(`${ctx.odataCompanyBase}/${name}`, { $filter: `Document_No eq '${q(num)}'` }))).value || []; svc = name; break; } catch { /* siguiente */ }
    }
    if (!rows) { out.push(`${num}: no hay página de líneas publicada`); continue; }
    const pending = [...src];
    for (const r of rows.filter((x: any) => s(x.No) && s(x.Type) === 'Item').sort((a: any, b: any) => n(a.Line_No) - n(b.Line_No))) {
      const i = pending.findIndex((o: any) => s(o.no) === s(r.No) && Math.abs(n(o.quantity) - n(r.Quantity)) < 1e-6);
      if (i < 0) continue;
      const o = pending.splice(i, 1)[0];
      const cost = n(o.unitCostLCY);
      if (Math.abs(n(r.Unit_Cost_LCY) - cost) < 0.000001) continue;
      try {
        await bcRequest('PATCH', editUrl(ctx, r['@odata.editLink']), ctx.token, { Unit_Cost_LCY: cost });
        out.push(`${num} ${r.No}: ${n(r.Unit_Cost_LCY)} → ${cost}`);
      } catch (e: any) { out.push(`${num} ${r.No}: no se ha podido poner ${cost} (${String(e?.message).replace(/^BC PATCH [^:]*: /, '').substring(0, 160)})`); }
    }
    void svc;
  }
  return out;
}

export async function runRebill(ctx: BcContext, company: string, no: string, markup: number) {
  const plan = await planRebill(ctx, company, no, markup);
  if (plan.blockers.length) throw new Error(`No se crea nada para ${no}: ${plan.blockers.join(' · ')}`);
  const key = `rebill:${company}:${no}`;
  const done: { creditMemo?: string; invoice?: string } = { ...(plan.done || {}) };
  const warnings = [...plan.warnings];
  const h = await invoiceOf(ctx, no);

  // 1) Abono corrector (copia de la factura, liquidado contra ella)
  if (!done.creditMemo) {
    const drafts = () => bcFetchAll(odataUrl(`${ctx.apiBase}/salesCreditMemos`, { $filter: `invoiceNumber eq '${q(no)}' and status eq 'Draft'`, $select: 'id,number' }), ctx.token).catch(() => [] as any[]);
    let cm = (await drafts())[0];
    if (cm) warnings.push(`Ya había un abono sin registrar para ${no}: ${s(cm.number)} (se revisa).`);
    else {
      try {
        await bcRequest('POST', `${ctx.apiBase}/salesInvoices(${h.id})/Microsoft.NAV.makeCorrectiveCreditMemo`, ctx.token);
        const created = await drafts();
        cm = created[created.length - 1];
      } catch (e: any) {
        // Factura ya cerrada (cobrada / liquidada): BC no hace el abono corrector; se crea una copia del abono sin liquidar
        if (!/invoice is closed/i.test(String(e?.message))) throw e;
        const head = await postPruned(ctx, `${ctx.apiBase}/salesCreditMemos`, headerOf(h));
        const base = `${ctx.apiBase}/salesCreditMemos(${head.id})`;
        try {
          // Sin "Ignore Custom Qty. Fields" BC exige el múltiplo de venta del artículo (p. ej. 2000)
          await ignoreCustomQty(ctx, 'credit', s(head.number));
          if (plan.vatFallback) await setVatBus(ctx, 'credit', s(head.number), FALLBACK_VAT_BUS);
          await copyLines(ctx, h.id, base, 'salesCreditMemoLines', l => ({ unitPrice: n(l.unitPrice), discountPercent: n(l.discountPercent) }), plan.vatFallback);
        } catch (err) { await bcRequest('DELETE', base, ctx.token).catch(() => {}); throw err; }
        done.creditMemo = s(head.number);
        warnings.push(`${no} ya está cerrada en BC: el abono ${done.creditMemo} es una copia sin liquidar contra la factura (aplícalo a mano si hace falta).`);
      }
    }
    // Abono corrector (nuevo o el que ya había): IVA NAC / OHNE MWST si hace falta y precios de la factura original
    if (cm && !done.creditMemo) {
      const cmNo = s(cm.number);
      await ignoreCustomQty(ctx, 'credit', cmNo);
      if (plan.vatFallback) {
        const fixLines = async () => {
          const cl = await bcFetchAll(`${ctx.apiBase}/salesCreditMemos(${cm.id})/salesCreditMemoLines`, ctx.token);
          for (const l of cl) if (s(l.lineType) && s(l.lineType) !== 'Comment' && s(l.taxCode) !== FALLBACK_VAT_PROD)
            await bcRequest('PATCH', `${ctx.apiBase}/salesCreditMemos(${cm.id})/salesCreditMemoLines(${l.id})`, ctx.token, { taxCode: FALLBACK_VAT_PROD });
        };
        // Según la configuración de IVA, BC acepta primero la cabecera o primero las líneas
        try { await setVatBus(ctx, 'credit', cmNo, FALLBACK_VAT_BUS); await fixLines(); }
        catch { await fixLines(); await setVatBus(ctx, 'credit', cmNo, FALLBACK_VAT_BUS); }
      }
      await restorePrices(ctx, h.id, cm.id);
      done.creditMemo = cmNo;
    }
    await writeSetting(key, done);
  }

  // 2) Factura nueva con el precio = coste + markup
  if (!done.invoice) {
    const inv = await postPruned(ctx, `${ctx.apiBase}/salesInvoices`, headerOf(h));
    const base = `${ctx.apiBase}/salesInvoices(${inv.id})`;
    const bySeq = new Map(plan.lines.map(l => [l.sequence, l]));
    try {
      await ignoreCustomQty(ctx, 'invoice', s(inv.number));
      if (plan.vatFallback) await setVatBus(ctx, 'invoice', s(inv.number), FALLBACK_VAT_BUS);
      await copyLines(ctx, h.id, base, 'salesInvoiceLines', l => {
        const p = bySeq.get(n(l.sequence));
        return p?.newPrice != null ? { unitPrice: p.newPrice, discountPercent: 0 } : { unitPrice: n(l.unitPrice), discountPercent: n(l.discountPercent) };
      }, plan.vatFallback);
    } catch (e) {
      await bcRequest('DELETE', base, ctx.token).catch(() => {});
      throw e;
    }
    done.invoice = s(inv.number);
    await writeSetting(key, done);
  }
  try { warnings.push(...(await setOriginalCosts(ctx, no, done)).filter(x => x.includes('no se ha podido') || x.includes('no hay página'))); } catch (e: any) { warnings.push(`${no}: no se ha podido poner el coste unitario de la factura original (${String(e?.message).substring(0, 160)}).`); }
  try { await setOriginalDates(ctx, no, done); } catch (e: any) { warnings.push(`${no}: no se ha podido poner la fecha de la factura original (${String(e?.message).substring(0, 160)}).`); }
  warnings.push(...[...notes].map(x => `${no}: ${x}.`));
  notes.clear();
  return { ...plan, done, warnings };
}
