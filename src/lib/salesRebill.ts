import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { bcRequest } from '@/lib/bcWrite';
import { readSetting, writeSetting } from '@/lib/reporting/cache';

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
  const done = await readSetting<{ creditMemo?: string; invoice?: string }>(`rebill:${company}:${no}`, {});
  return {
    invoice: no, customer: s(h.customerNumber), customerName: s(h.customerName), currency: s(h.currencyCode),
    externalDocumentNumber: s(h.externalDocumentNumber), oldNet: n(h.totalAmountExcludingTax),
    newNet: Math.round(lines.reduce((t, l) => t + l.newNet, 0) * 100) / 100, lines, warnings,
    done: done.creditMemo || done.invoice ? done : undefined,
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
async function copyLines(ctx: BcContext, srcId: string, base: string, linesEntity: string, price: (l: any) => { unitPrice: number; discountPercent: number }) {
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
      if (s(l.taxCode)) body.taxCode = s(l.taxCode);
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

export async function runRebill(ctx: BcContext, company: string, no: string, markup: number) {
  const plan = await planRebill(ctx, company, no, markup);
  const key = `rebill:${company}:${no}`;
  const done: { creditMemo?: string; invoice?: string } = { ...(plan.done || {}) };
  const warnings = [...plan.warnings];
  const h = await invoiceOf(ctx, no);

  // 1) Abono corrector (copia de la factura, liquidado contra ella)
  if (!done.creditMemo) {
    const existing = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesCreditMemos`, { $filter: `invoiceNumber eq '${q(no)}' and status eq 'Draft'`, $select: 'number' }), ctx.token).catch(() => [] as any[]);
    if (existing.length) {
      done.creditMemo = s(existing[0].number);
      warnings.push(`Ya había un abono sin registrar para ${no}: ${done.creditMemo}.`);
    } else {
      try {
        await bcRequest('POST', `${ctx.apiBase}/salesInvoices(${h.id})/Microsoft.NAV.makeCorrectiveCreditMemo`, ctx.token);
        const created = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesCreditMemos`, { $filter: `invoiceNumber eq '${q(no)}' and status eq 'Draft'`, $select: 'number' }), ctx.token);
        done.creditMemo = s(created[created.length - 1]?.number) || '(creado)';
      } catch (e: any) {
        // Factura ya cerrada (cobrada / liquidada): BC no hace el abono corrector; se crea una copia del abono sin liquidar
        if (!/invoice is closed/i.test(String(e?.message))) throw e;
        const cm = await postPruned(ctx, `${ctx.apiBase}/salesCreditMemos`, headerOf(h));
        const base = `${ctx.apiBase}/salesCreditMemos(${cm.id})`;
        try {
          await copyLines(ctx, h.id, base, 'salesCreditMemoLines', l => ({ unitPrice: n(l.unitPrice), discountPercent: n(l.discountPercent) }));
        } catch (err) { await bcRequest('DELETE', base, ctx.token).catch(() => {}); throw err; }
        done.creditMemo = s(cm.number);
        warnings.push(`${no} ya está cerrada en BC: el abono ${done.creditMemo} es una copia sin liquidar contra la factura (aplícalo a mano si hace falta).`);
      }
    }
    await writeSetting(key, done);
  }

  // 2) Factura nueva con el precio = coste + markup
  if (!done.invoice) {
    const inv = await postPruned(ctx, `${ctx.apiBase}/salesInvoices`, headerOf(h));
    const base = `${ctx.apiBase}/salesInvoices(${inv.id})`;
    const bySeq = new Map(plan.lines.map(l => [l.sequence, l]));
    try {
      await copyLines(ctx, h.id, base, 'salesInvoiceLines', l => {
        const p = bySeq.get(n(l.sequence));
        return p?.newPrice != null ? { unitPrice: p.newPrice, discountPercent: 0 } : { unitPrice: n(l.unitPrice), discountPercent: n(l.discountPercent) };
      });
    } catch (e) {
      await bcRequest('DELETE', base, ctx.token).catch(() => {});
      throw e;
    }
    done.invoice = s(inv.number);
    await writeSetting(key, done);
  }
  warnings.push(...[...notes].map(x => `${no}: ${x}.`));
  notes.clear();
  return { ...plan, done, warnings };
}
