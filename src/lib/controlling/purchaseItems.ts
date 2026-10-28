import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { hiddenByPairs, vendorCancelPairs } from './cancelledDocs';
import { cached, HOUR } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';

// Controlling · Compras por artículo: facturas (tablas 122/123) y abonos (124/125) de compra registrados entre dos
// fechas de registro, solo líneas de tipo Artículo, agrupados por artículo → proveedor → documento.
// - Artículo: descripción y grupo contable producto de su ficha (API v2 items) y, con la configuración contable
//   general (tabla 252, General_Posting_Setup_Excel), la Purch. Account / Purch. Credit Memo Account actuales
//   para cada grupo contable de negocio.
// - Proveedor: ficha (Vendor_Card_Excel): país, forma y términos de pago, grupo contable de negocio y Customer Group
//   asignado (Customer_Group_Code_BCT, descripción de la tabla 80008 Customer Group CRZ, API custom customerGroups).
// - Documento: cabecera (fechas, nº factura proveedor) y línea (coste unitario, grupo IVA, código de periodificación);
//   cuenta contable histórica = movimientos contables (tabla 17) de compra del documento con el mismo grupo contable
//   producto que la línea.
// - Se excluyen los artículos de tipo Inventario (ficha v2 items, type = Inventory).
// - Abonos: página 140 publicada en OData o, si no está, los movimientos contables de compra de cada abono (G/L Entries).
// - Se descartan los pares artículo/proveedor con tantos abonos como facturas (facturas corregidas) y los de neto 0 (p. ej. una factura y su abono).

const str = (v: any) => (v == null ? '' : String(v).trim());
const num = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const day = (v: any) => { const s = str(v).substring(0, 10); return s && !s.startsWith('0001') ? s : ''; };
const q = (s: string) => s.replace(/'/g, "''");

type Doc = {
  kind: 'Factura' | 'Abono'; documentNo: string; lineNo: number; documentDate: string; postingDate: string; vatDate: string;
  vendorDocNo: string; currency: string; quantity: number; directUnitCost: number; amount: number;
  vatProdPostingGroup: string; deferralCode: string; genProdPostingGroup: string; glAccounts: { no: string; name: string; amount: number }[];
};

async function serviceNames(url: string, token: string): Promise<string[]> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.value || []).map((s: any) => s.name || s.url).filter(Boolean);
}

// Abonos de compra registrados: página 140 "Posted Purchase Credit Memo" publicada en OData (cabecera y su subpágina
// de líneas, p. ej. Posted_Purchase_Credit_Memo_Excel / …PurchCrMemoLines). No sirven los servicios CS_ de Document Capture.
async function creditMemoServices(ctx: BcContext) {
  const odata = await serviceNames(ctx.odataCompanyBase.replace(/\/Company\(.*$/, ''), ctx.token);
  const crMemo = odata.filter(n => !/^CS_/i.test(n) && /purch/i.test(n) && /cr(edit)?_?\.?_?memo/i.test(n));
  const lines = crMemo.find(n => /line/i.test(n));
  const header = crMemo.filter(n => !/line/i.test(n)).sort((a, b) => a.length - b.length)[0];
  return { header, lines, candidates: crMemo };
}

// Diagnóstico: tiempo y nº de filas de cada lectura de BC por separado (?probe=1)
export async function probeSources(ctx: BcContext, from: string, to: string) {
  const dateFilter = (f: string) => `${f} ge ${from} and ${f} le ${to}`;
  const sources: Record<string, () => Promise<any[]>> = {
    purchInvLines: () => bcFetchAll(odataUrl(`${ctx.customApiBase}/purchInvLines`, { $filter: dateFilter('postingDate'), $select: 'documentNo,lineNo,type,no,postingDate' }), ctx.token),
    invHeaders: () => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Posted_Purchase_Invoice_Excel`, { $filter: dateFilter('Posting_Date'), $select: 'No,Document_Date' }), ctx.token),
    vendors: () => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Vendor_Card_Excel`, { $select: 'No,Name,Gen_Bus_Posting_Group' }), ctx.token),
    itemsV2: () => bcFetchAll(odataUrl(`${ctx.apiBase}/items`, { $select: 'number,displayName,generalProductPostingGroupCode' }), ctx.token),
    setup: () => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Posting_Setup_Excel`, { $select: 'Gen_Bus_Posting_Group,Gen_Prod_Posting_Group,Purch_Account' }), ctx.token),
    glPurchase: () => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, { $filter: `${dateFilter('Posting_Date')} and Gen_Posting_Type eq 'Purchase'`, $select: 'Entry_No,Document_No,G_L_Account_No,Gen_Prod_Posting_Group,Amount' }), ctx.token),
    glLEntries: () => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/G_LEntries`, { $filter: `${dateFilter('Posting_Date')} and Gen_Posting_Type eq 'Purchase'`, $select: 'Entry_No,Document_No,G_L_Account_No,Gen_Prod_Posting_Group,Amount' }), ctx.token),
  };
  const out: Record<string, unknown> = {};
  await Promise.all(Object.entries(sources).map(async ([k, f]) => {
    const t = Date.now();
    try { const rows = await f(); out[k] = { rows: rows.length, ms: Date.now() - t }; }
    catch (e: any) { out[k] = { error: String(e.message).substring(0, 300), ms: Date.now() - t }; }
  }));
  return out;
}

export async function purchaseItemsReport(ctx: BcContext, company: string, from: string, to: string, force = false) {
  return cached(`ctrl:purchItems5:${company}:${from}:${to}`, to < today() ? 6 * HOUR : 1 * HOUR, async () => {
    const warnings: string[] = [];
    const cm = await creditMemoServices(ctx);
    const dateFilter = (f: string) => `${f} ge ${from} and ${f} le ${to}`;

    const [invLines, invHeaders, vendors, items, setup, gl, cmHeaders, customerGroups] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.customApiBase}/purchInvLines`, {
        $filter: dateFilter('postingDate'),
        $select: 'documentNo,lineNo,buyFromVendorNo,type,no,description,quantity,directUnitCost,amount,vatProdPostingGroup,deferralCode,genProdPostingGroup,postingDate',
      }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Posted_Purchase_Invoice_Excel`, {
        $filter: dateFilter('Posting_Date'), $select: 'No,Buy_from_Vendor_No,Document_Date,VAT_Reporting_Date,Vendor_Invoice_No,Currency_Code',
      }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Vendor_Card_Excel`, {
        $select: 'No,Name,Country_Region_Code,Payment_Method_Code,Payment_Terms_Code,Gen_Bus_Posting_Group,Customer_Group_Code_BCT',
      }), ctx.token),
      // Ficha de artículo por la API v2 (la página Item_Card_Excel tarda más de 30 s)
      bcFetchAll(odataUrl(`${ctx.apiBase}/items`, { $select: 'number,displayName,generalProductPostingGroupCode,type' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Posting_Setup_Excel`, {
        $select: 'Gen_Bus_Posting_Group,Gen_Prod_Posting_Group,Purch_Account,Purch_Credit_Memo_Account',
      }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: `${dateFilter('Posting_Date')} and Gen_Posting_Type eq 'Purchase'`,
        $select: 'Entry_No,Document_No,Document_Type,Posting_Date,VAT_Reporting_Date,G_L_Account_No,G_L_Account_Name,Gen_Prod_Posting_Group,VAT_Prod_Posting_Group,Amount,Source_No,External_Document_No',
      }), ctx.token).catch(e => { warnings.push(`Movimientos contables no disponibles: ${e.message}`); return [] as any[]; }),
      cm.header
        ? bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/${cm.header}`, { $filter: dateFilter('Posting_Date') }), ctx.token).catch(e => { warnings.push(`Abonos (${cm.header}): ${e.message}`); return [] as any[]; })
        // Sin la página 140: cabeceras de Document Capture (fecha del documento y nº de abono del proveedor)
        : bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/CS_PostedPurchaseCrMemos`, { $filter: dateFilter('PostingDate') }), ctx.token).catch(() => [] as any[]),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/customerGroups`, { $select: 'code,description' }), ctx.token).catch(() => [] as any[]),
    ]);

    // Líneas de abono de los abonos del periodo
    let cmLines: any[] = [];
    const glCreditMemos = !cm.header || !cm.lines;
    if (glCreditMemos) {
      warnings.push('Abonos de compra leídos de G/L Entries (movimientos de compra de cada abono por grupo contable producto): sin cantidad ni coste unitario. Para tener sus líneas, publica en BC la página 140 "Posted Purchase Credit Memo" como servicio web (p. ej. Posted_Purchase_Credit_Memo_Excel).');
    } else if (cmHeaders.length) {
      const docNos = cmHeaders.map(h => str(h.No));
      const chunks = Array.from({ length: Math.ceil(docNos.length / 40) }, (_, i) => docNos.slice(i * 40, i * 40 + 40));
      const parts = await Promise.all(chunks.map(c => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/${cm.lines}`, {
        $filter: c.map(n => `Document_No eq '${q(n)}'`).join(' or '),
      }), ctx.token).catch(e => { warnings.push(`Líneas de abono (${cm.lines}): ${e.message}`); return [] as any[]; })));
      cmLines = parts.flat();
    }

    const vendorBy = new Map(vendors.map(v => [str(v.No), v]));
    const groupName = new Map(customerGroups.map((g: any) => [str(g.code), str(g.description)]));
    const itemBy = new Map(items.map(i => [str(i.number), { Description: i.displayName, Gen_Prod_Posting_Group: i.generalProductPostingGroupCode, type: str(i.type) }]));
    // Artículos de tipo Inventario (mercancía) fuera: solo servicios y no inventariables
    const isInventory = (no: string) => itemBy.get(no)?.type === 'Inventory';
    const invHeaderBy = new Map(invHeaders.map(h => [str(h.No), h]));
    const cmHeaderBy = new Map(cmHeaders.map(h => [str(h.No), h]));
    const setupByProd = new Map<string, { bus: string; purch: string; crMemo: string }[]>();
    for (const s of setup) {
      const prod = str(s.Gen_Prod_Posting_Group);
      setupByProd.set(prod, [...(setupByProd.get(prod) || []), { bus: str(s.Gen_Bus_Posting_Group), purch: str(s.Purch_Account), crMemo: str(s.Purch_Credit_Memo_Account) }]);
    }
    const glByDoc = new Map<string, any[]>();
    for (const e of gl) glByDoc.set(str(e.Document_No), [...(glByDoc.get(str(e.Document_No)) || []), e]);
    // Cuentas contables del documento con el grupo contable producto de la línea
    const glAccounts = (docNo: string, prod: string) => {
      const acc = new Map<string, { no: string; name: string; amount: number }>();
      for (const e of glByDoc.get(docNo) || []) {
        if (str(e.Gen_Prod_Posting_Group) !== prod) continue;
        const no = str(e.G_L_Account_No);
        const a = acc.get(no) || { no, name: str(e.G_L_Account_Name), amount: 0 };
        a.amount += num(e.Amount);
        acc.set(no, a);
      }
      return Array.from(acc.values()).map(a => ({ ...a, amount: r2(a.amount) })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    };

    // Líneas normalizadas (abonos con importe y cantidad en negativo)
    type Line = Doc & { item: string; desc: string; vendor: string };
    let lines: Line[] = [];
    for (const l of invLines) {
      if (str(l.type) !== 'Item' || !str(l.no) || isInventory(str(l.no))) continue;
      const h = invHeaderBy.get(str(l.documentNo));
      lines.push({
        kind: 'Factura', item: str(l.no), desc: str(l.description), vendor: str(l.buyFromVendorNo) || str(h?.Buy_from_Vendor_No),
        documentNo: str(l.documentNo), lineNo: num(l.lineNo), documentDate: day(h?.Document_Date), postingDate: day(l.postingDate),
        vatDate: day(h?.VAT_Reporting_Date), vendorDocNo: str(h?.Vendor_Invoice_No), currency: str(h?.Currency_Code),
        quantity: num(l.quantity), directUnitCost: num(l.directUnitCost), amount: num(l.amount),
        vatProdPostingGroup: str(l.vatProdPostingGroup), deferralCode: str(l.deferralCode), genProdPostingGroup: str(l.genProdPostingGroup),
        glAccounts: glAccounts(str(l.documentNo), str(l.genProdPostingGroup)),
      });
    }
    // Abonos desde G/L Entries (sin la página 140): una línea por abono y grupo contable producto; el artículo es el que
    // tiene ese grupo (en los servicios coincide con el nº de artículo) o, si hay varios, el que el proveedor facturó
    if (glCreditMemos) {
      const prodItems = new Map<string, string[]>();
      for (const [no, it] of itemBy) if (it.type !== 'Inventory' && it.Gen_Prod_Posting_Group) prodItems.set(str(it.Gen_Prod_Posting_Group), [...(prodItems.get(str(it.Gen_Prod_Posting_Group)) || []), no]);
      const cmGroups = new Map<string, any[]>();
      for (const e of gl) {
        if (str(e.Document_Type).replace(/_x0020_/g, ' ') !== 'Credit Memo' || !str(e.Gen_Prod_Posting_Group)) continue;
        const k = `${str(e.Document_No)}|${str(e.Gen_Prod_Posting_Group)}`;
        cmGroups.set(k, [...(cmGroups.get(k) || []), e]);
      }
      for (const [k, list] of cmGroups) {
        const [docNo, prod] = k.split('|');
        const vendor = str(list.find(e => str(e.Source_No))?.Source_No);
        const candidates = prodItems.get(prod) || [];
        let item = candidates.length === 1 ? candidates[0] : '';
        if (!item && candidates.length) {
          const invoiced = lines.filter(l => l.vendor === vendor && l.genProdPostingGroup === prod && candidates.includes(l.item));
          item = invoiced[0]?.item || '';
        }
        if (!item) continue;
        const h = cmHeaderBy.get(docNo);
        const amount = list.reduce((t, e) => t + num(e.Amount), 0);
        lines.push({
          kind: 'Abono', item, desc: str(itemBy.get(item)?.Description), vendor: vendor || str(h?.VendorNo),
          documentNo: docNo, lineNo: 0, documentDate: day(h?.DocDate), postingDate: day(list[0].Posting_Date),
          vatDate: day(list[0].VAT_Reporting_Date), vendorDocNo: str(h?.VendorCrMemoNo) || str(list[0].External_Document_No), currency: str(h?.CurrCode),
          quantity: 0, directUnitCost: 0, amount,
          vatProdPostingGroup: str(list[0].VAT_Prod_Posting_Group), deferralCode: '', genProdPostingGroup: prod,
          glAccounts: glAccounts(docNo, prod),
        });
      }
    }
    for (const l of cmLines) {
      if (str(l.Type) !== 'Item' || !str(l.No) || isInventory(str(l.No))) continue;
      const h = cmHeaderBy.get(str(l.Document_No));
      if (!h) continue;
      const amount = num(l.Line_Amount ?? l.Amount) - num(l.Invoice_Discount_Amount ?? l.Inv_Discount_Amount);
      lines.push({
        kind: 'Abono', item: str(l.No), desc: str(l.Description), vendor: str(h.Buy_from_Vendor_No ?? h.VendorNo),
        documentNo: str(l.Document_No), lineNo: num(l.Line_No), documentDate: day(h.Document_Date ?? h.DocDate), postingDate: day(h.Posting_Date ?? h.PostingDate),
        vatDate: day(h.VAT_Reporting_Date), vendorDocNo: str(h.Vendor_Cr_Memo_No ?? h.VendorCrMemoNo), currency: str(h.Currency_Code ?? h.CurrCode),
        quantity: -num(l.Quantity), directUnitCost: num(l.Direct_Unit_Cost), amount: -amount,
        vatProdPostingGroup: str(l.VAT_Prod_Posting_Group), deferralCode: str(l.Deferral_Code), genProdPostingGroup: str(l.Gen_Prod_Posting_Group),
        glAccounts: glAccounts(str(l.Document_No), str(l.Gen_Prod_Posting_Group)),
      });
    }

    // Factura + abono que la anula entera (mismo artículo y proveedor, suman 0): no se muestran
    const pairs = await vendorCancelPairs(ctx, from, to).catch(() => []);
    const amountsByItemVendor = new Map<string, Map<string, number>>();
    for (const l of lines) {
      const k = `${l.item}|${l.vendor}`;
      const m = amountsByItemVendor.get(k) || new Map<string, number>();
      m.set(l.documentNo, (m.get(l.documentNo) || 0) + l.amount);
      amountsByItemVendor.set(k, m);
    }
    const hiddenByItemVendor = new Map(Array.from(amountsByItemVendor.entries()).map(([k, m]) => [k, hiddenByPairs(pairs, m)]));
    const cancelledPairs = Array.from(hiddenByItemVendor.values()).reduce((t, h) => t + h.size / 2, 0);
    lines = lines.filter(l => !hiddenByItemVendor.get(`${l.item}|${l.vendor}`)?.has(l.documentNo));

    // Artículo → proveedor → documentos
    const byItem = new Map<string, Map<string, Line[]>>();
    for (const l of lines) {
      const v = byItem.get(l.item) || new Map<string, Line[]>();
      v.set(l.vendor, [...(v.get(l.vendor) || []), l]);
      byItem.set(l.item, v);
    }
    let excludedZero = 0, excludedEqual = 0;
    const out = Array.from(byItem.entries()).map(([itemNo, byVendor]) => {
      const card = itemBy.get(itemNo);
      const prod = str(card?.Gen_Prod_Posting_Group);
      const vendorsOut = Array.from(byVendor.entries()).map(([vendorNo, docs]) => {
        const v = vendorBy.get(vendorNo);
        const bus = str(v?.Gen_Bus_Posting_Group);
        const cfg = (setupByProd.get(prod) || []).find(s => s.bus === bus);
        return {
          vendorNo, name: str(v?.Name), customerGroupCode: str(v?.Customer_Group_Code_BCT), customerGroupName: groupName.get(str(v?.Customer_Group_Code_BCT)) || '',
          country: str(v?.Country_Region_Code), paymentMethod: str(v?.Payment_Method_Code),
          paymentTerms: str(v?.Payment_Terms_Code), genBusPostingGroup: bus,
          currentPurchAccount: cfg?.purch || '', currentCrMemoAccount: cfg?.crMemo || '',
          net: r2(docs.reduce((s, d) => s + d.amount, 0)), quantity: r2(docs.reduce((s, d) => s + d.quantity, 0)),
          invoices: docs.filter(d => d.kind === 'Factura').length, creditMemos: docs.filter(d => d.kind === 'Abono').length,
          docs: docs.sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.documentNo.localeCompare(b.documentNo))
            .map(({ item: _i, desc: _d, vendor: _v, ...d }) => ({ ...d, amount: r2(d.amount) })),
        };
      }).filter(v => {
        if (Math.abs(v.net) < 0.005) { excludedZero++; return false; }
        // Tantas facturas como abonos: las facturas se han corregido (abonado) y el proveedor no cuenta
        if (v.creditMemos > 0 && v.invoices === v.creditMemos) { excludedEqual++; return false; }
        return true;
      }).sort((a, b) => b.net - a.net);
      return {
        itemNo, description: str(card?.Description) || byVendor.values().next().value?.[0]?.desc || '',
        genProdPostingGroup: prod, setup: setupByProd.get(prod) || [],
        net: r2(vendorsOut.reduce((s, v) => s + v.net, 0)), quantity: r2(vendorsOut.reduce((s, v) => s + v.quantity, 0)),
        vendors: vendorsOut,
      };
    }).filter(i => i.vendors.length).sort((a, b) => b.net - a.net);

    return {
      company, from, to, items: out, excludedZero, excludedEqual, cancelledPairs, warnings,
      counts: { invoiceLines: lines.filter(l => l.kind === 'Factura').length, creditMemoLines: lines.filter(l => l.kind === 'Abono').length, glEntries: gl.length },
      creditMemoService: cm.header ? { header: cm.header, lines: cm.lines } : null,
    };
  }, force);
}
