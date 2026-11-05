import { bcFetchAll, BcContext, getBcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';

// Controlling · Intercompany: cada factura de venta registrada de una empresa del grupo a otra tiene que estar como
// factura de compra registrada en la otra empresa con el mismo nº (Vendor Invoice No.), importe sin IVA, divisa (en
// blanco = divisa local de cada empresa), fecha y artículos/cantidades. En las ventas de CRAZE GmbH a CRAZE Toys (UK)
// y Group AG (drop shipment), el External Document No. es la factura de venta final de esa empresa al cliente, que
// debe tener los mismos artículos y cantidades.
// Cabeceras: API v2 salesInvoices / purchaseInvoices; líneas: API custom salesInvoiceLines / purchInvLines.

export const IC_COMPANIES = [
  { name: 'CRAZE', lcy: 'EUR', re: /^craze\s*gmbh\b(?!.*b2c)/i },
  { name: 'Craze Iberia SL', lcy: 'EUR', re: /iberia/i },
  { name: 'Craze UK', lcy: 'GBP', re: /toys|\buk\b/i },
  { name: 'CRAZE Group AG', lcy: 'CHF', re: /group\s*ag/i },
  { name: 'Craze Entertainment', lcy: 'EUR', re: /entertainment/i },
];
const DROP_SHIP_TARGETS = ['Craze UK', 'CRAZE Group AG'];

const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const q = (v: string) => v.replace(/'/g, "''");
const d10 = (v: any) => { const x = s(v).substring(0, 10); return x && x !== '0001-01-01' ? x : ''; };
const lcyOf = (company: string) => IC_COMPANIES.find(c => c.name === company)?.lcy || 'EUR';
// Empresa del grupo a la que corresponde un cliente / proveedor por su nombre (solo nombres que empiezan por "CRAZE")
export const groupCompanyOf = (name: string) => (/^craze\b/i.test(name.trim()) ? IC_COMPANIES.find(c => c.re.test(name))?.name || null : null);
// Nº de documento normalizado para emparejar (sin espacios ni puntuación final, en mayúsculas)
const norm = (v: any) => s(v).toUpperCase().replace(/[\s.,;]+$/g, '').replace(/^\s+/, '');
const shift = (date: string, days: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().substring(0, 10); };
const chunk = <T,>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

type Line = { no: string; description: string; quantity: number; amount: number };
// Líneas de varios documentos (filtro por nº en bloques), agrupadas por documento
async function linesOf(ctx: BcContext, entity: 'salesInvoiceLines' | 'purchInvLines' | 'salesCrMemoLines', docs: string[]) {
  const out = new Map<string, Line[]>();
  const parts = chunk(Array.from(new Set(docs.filter(Boolean))), 25);
  for (let i = 0; i < parts.length; i += 6) {
    const res = await Promise.all(parts.slice(i, i + 6).map(c => bcFetchAll(odataUrl(`${ctx.customApiBase}/${entity}`, {
      $filter: c.map(d => `documentNo eq '${q(d)}'`).join(' or '),
      $select: 'documentNo,type,no,description,quantity,amount',
    }), ctx.token)));
    for (const l of res.flat()) {
      if (!s(l.no) || !n(l.quantity)) continue;
      const list = out.get(s(l.documentNo)) || [];
      list.push({ no: s(l.no), description: s(l.description), quantity: n(l.quantity), amount: n(l.amount) });
      out.set(s(l.documentNo), list);
    }
  }
  return out;
}

// Cantidad por artículo (suma de líneas) y diferencias entre dos documentos
const qtyByItem = (lines: Line[] = []) => lines.reduce((m, l) => m.set(l.no, (m.get(l.no) || 0) + l.quantity), new Map<string, number>());
// Equivalencias aceptadas: en la compra de Craze Entertainment el foilbag de GmbH ("PACKAGING - Empty Foilbag …")
// se registra como AA-00049 (Packaging/Foilbag, cantidad 1)
const FOILBAG = /foil\s*bag/i;
const FOILBAG_ITEM = 'AA-00049';
function compareLines(a: Line[] = [], b: Line[] = [], allowFoilbag = false) {
  const qa = qtyByItem(a), qb = qtyByItem(b);
  const amt = (lines: Line[], no: string) => Math.round(lines.filter(l => l.no === no).reduce((t, l) => t + l.amount, 0) * 100) / 100;
  const items = Array.from(new Set([...qa.keys(), ...qb.keys()])).sort();
  const foilbagEquivalent = allowFoilbag && qb.has(FOILBAG_ITEM) && a.some(l => FOILBAG.test(l.description) && !qb.has(l.no));
  const rows = items.map(no => {
    const description = (a.find(l => l.no === no) || b.find(l => l.no === no))?.description || '';
    const equivalent = foilbagEquivalent && (no === FOILBAG_ITEM || (FOILBAG.test(description) && !qb.has(no)));
    return { no, description, a: qa.get(no) || 0, b: qb.get(no) || 0, aAmount: amt(a, no), bAmount: amt(b, no), ...(equivalent ? { equivalent: `Foilbag = ${FOILBAG_ITEM}` } : {}) };
  });
  return { rows, ok: rows.every(r => r.equivalent || Math.abs(r.a - r.b) < 0.0001) };
}

export type IcRow = {
  // (líneas: equivalent = equivalencia aceptada, p. ej. foilbag = AA-00049)
  source: string; target: string; invoiceNo: string; postingDate: string; invoiceDate: string; customer: string;
  currency: string; amount: number; externalDocNo: string;
  purchase: null | { no: string; vendorInvoiceNo: string; postingDate: string; invoiceDate: string; vendor: string; currency: string; amount: number };
  lines: { no: string; description: string; a: number; b: number; aAmount: number; bAmount: number; equivalent?: string }[];
  final: null | { no: string; customer: string; postingDate: string; currency: string; amount: number; found: boolean; lines: { no: string; description: string; a: number; b: number; aAmount: number; bAmount: number }[] };
  issues: string[];
  // Incidencias ya subsanadas con abonos y facturas nuevas (se mantienen las incidencias como comentario)
  corrected?: string[];
};

export async function intercompanyReport(source: string, from: string, to: string, force = false) {
  return cached(`intercompany10:${source}:${from}:${to}`, to < today() ? 12 * HOUR : HOUR, async () => {
    const ctx = await getBcContext(source);
    const sales = (await bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, {
      $filter: `postingDate ge ${from} and postingDate le ${to}`,
      $select: 'number,externalDocumentNumber,invoiceDate,postingDate,customerNumber,customerName,currencyCode,totalAmountExcludingTax,status',
    }), ctx.token)).filter((x: any) => s(x.status) !== 'Draft');
    const icAll = sales.map((x: any) => ({ x, target: groupCompanyOf(s(x.customerName)) })).filter(r => r.target && r.target !== source) as { x: any; target: string }[];
    // Facturas a importe 0 que luego se han abonado: se excluyen de la lista junto con su abono
    const memos = (await bcFetchAll(odataUrl(`${ctx.apiBase}/salesCreditMemos`, {
      $filter: `postingDate ge ${from} and postingDate le ${shift(to, 120)}`,
      $select: 'number,invoiceNumber,externalDocumentNumber,customerName,postingDate,totalAmountExcludingTax,status',
    }), ctx.token).catch(() => [] as any[])).filter((m: any) => s(m.status) !== 'Draft' && groupCompanyOf(s(m.customerName)));
    // Un abono se relaciona con la factura por su nº (invoiceNumber) o por el mismo External Document No. y empresa
    const creditedBy = new Map<string, any>();
    for (const m of memos) {
      const target = groupCompanyOf(s(m.customerName));
      if (s(m.invoiceNumber)) creditedBy.set(`no:${norm(m.invoiceNumber)}`, m);
      // Por External Document No. solo los abonos que no indican otra factura (los que sí, abonan esa otra factura)
      if (s(m.externalDocumentNumber) && !s(m.invoiceNumber)) creditedBy.set(`ext:${target}|${norm(m.externalDocumentNumber)}`, m);
    }
    const excluded: { invoiceNo: string; creditMemoNo: string; target: string; postingDate: string; externalDocNo: string; creditMemoAmount: number }[] = [];
    const ic = icAll.filter(r => {
      const m = Math.abs(n(r.x.totalAmountExcludingTax)) < 0.005
        ? creditedBy.get(`no:${norm(r.x.number)}`) || (s(r.x.externalDocumentNumber) ? creditedBy.get(`ext:${r.target}|${norm(r.x.externalDocumentNumber)}`) : null)
        : null;
      if (m) excluded.push({ invoiceNo: s(r.x.number), creditMemoNo: s(m.number), target: r.target, postingDate: d10(r.x.postingDate), externalDocNo: s(r.x.externalDocumentNumber), creditMemoAmount: n(m.totalAmountExcludingTax) });
      return !m;
    });
    const warnings: string[] = [];
    const salesLines = await linesOf(ctx, 'salesInvoiceLines', ic.map(r => s(r.x.number)));

    // Por empresa destino: sus compras al proveedor que es la empresa origen y, en drop shipment, sus ventas finales
    // Todas las demás empresas (también sin ventas: así salen sus compras al origen sin factura de venta)
    const targets = IC_COMPANIES.map(c => c.name).filter(c => c !== source);
    const byTarget = new Map<string, {
      purchases: Map<string, any>; unmatched: any[]; purchLines: Map<string, Line[]>; finals: Map<string, any>; finalLines: Map<string, Line[]>;
      drafts: Map<string, string>; purchMemos: Map<string, any[]>;
      finalGroups: Map<string, any[]>; finalMemos: Map<string, any[]>; finalMemoLines: Map<string, Line[]>;
    }>();
    await Promise.all(targets.map(async t => {
      try {
        const tctx = await getBcContext(t);
        const allPurch = (await bcFetchAll(odataUrl(`${tctx.apiBase}/purchaseInvoices`, {
          $filter: `postingDate ge ${shift(from, -45)} and postingDate le ${shift(to, 90)}`,
          $select: 'number,vendorInvoiceNumber,invoiceDate,postingDate,vendorNumber,vendorName,currencyCode,totalAmountExcludingTax,status',
        }), tctx.token)).filter((p: any) => groupCompanyOf(s(p.vendorName)) === source);
        const purch = allPurch.filter((p: any) => s(p.status) !== 'Draft');
        // Compras en borrador (sin registrar) por Vendor Invoice No.
        const drafts = new Map<string, string>(allPurch.filter((p: any) => s(p.status) === 'Draft').map((p: any) => [norm(p.vendorInvoiceNumber), s(p.number)]));
        // Abonos de compra al origen, por la factura de compra que abonan
        const purchMemos = new Map<string, any[]>();
        for (const m of (await bcFetchAll(odataUrl(`${tctx.apiBase}/purchaseCreditMemos`, {
          $filter: `postingDate ge ${shift(from, -45)} and postingDate le ${shift(to, 120)}`,
          $select: 'number,invoiceNumber,vendorName,postingDate,totalAmountExcludingTax,status',
        }), tctx.token).catch(() => [] as any[])).filter((m: any) => s(m.status) !== 'Draft' && s(m.invoiceNumber) && groupCompanyOf(s(m.vendorName)) === source)) {
          purchMemos.set(s(m.invoiceNumber), [...(purchMemos.get(s(m.invoiceNumber)) || []), m]);
        }
        const purchases = new Map(purch.map((p: any) => [norm(p.vendorInvoiceNumber), p]));
        const mine = ic.filter(r => r.target === t);
        const matchedNos = mine.map(r => purchases.get(norm(r.x.number))?.number).filter(Boolean) as string[];
        const salesNos = new Set(mine.map(r => norm(r.x.number)));
        // Compras al origen dentro del periodo sin factura de venta del origen en el periodo
        const unmatched = purch.filter((p: any) => d10(p.postingDate) >= from && d10(p.postingDate) <= to && !salesNos.has(norm(p.vendorInvoiceNumber)));
        // Drop shipment: la venta final se busca por nº de factura o por su External Document No. (= el de GmbH)
        const finals = new Map<string, any>();
        // Todas las ventas finales de cada External Document No. (repartidas o sustituidas) y sus abonos
        const finalGroups = new Map<string, any[]>();
        const finalMemos = new Map<string, any[]>();
        let finalMemoLines = new Map<string, Line[]>();
        if (DROP_SHIP_TARGETS.includes(t) && source === 'CRAZE' && mine.length) {
          const tSales = (await bcFetchAll(odataUrl(`${tctx.apiBase}/salesInvoices`, {
            $filter: `postingDate ge ${shift(from, -45)} and postingDate le ${shift(to, 90)}`,
            $select: 'number,externalDocumentNumber,postingDate,customerName,currencyCode,totalAmountExcludingTax,status',
          }), tctx.token)).filter((r: any) => s(r.status) !== 'Draft' && !groupCompanyOf(s(r.customerName)));
          const byNo = new Map(tSales.map((r: any) => [norm(r.number), r]));
          const byExt = new Map<string, any>();
          for (const r of tSales) if (norm(r.externalDocumentNumber) && !byExt.has(norm(r.externalDocumentNumber))) byExt.set(norm(r.externalDocumentNumber), r);
          for (const r of mine) {
            const ext = norm(r.x.externalDocumentNumber);
            const f = ext ? byNo.get(ext) || byExt.get(ext) : null;
            if (f) finals.set(norm(r.x.number), f);
            if (ext && !finalGroups.has(ext)) finalGroups.set(ext, tSales.filter((x: any) => norm(x.number) === ext || norm(x.externalDocumentNumber) === ext));
          }
          const groupNos = new Set(Array.from(finalGroups.values()).flat().map((x: any) => s(x.number)));
          if (groupNos.size) {
            for (const m of (await bcFetchAll(odataUrl(`${tctx.apiBase}/salesCreditMemos`, {
              $filter: `postingDate ge ${shift(from, -45)} and postingDate le ${shift(to, 120)}`,
              $select: 'number,invoiceNumber,customerName,postingDate,totalAmountExcludingTax,status',
            }), tctx.token).catch(() => [] as any[])).filter((m: any) => s(m.status) !== 'Draft' && groupNos.has(s(m.invoiceNumber)))) {
              finalMemos.set(s(m.invoiceNumber), [...(finalMemos.get(s(m.invoiceNumber)) || []), m]);
            }
            if (finalMemos.size) finalMemoLines = await linesOf(tctx, 'salesCrMemoLines', Array.from(finalMemos.values()).flat().map((m: any) => s(m.number)));
          }
        }
        const finalDocs = new Set([...Array.from(finals.values()), ...Array.from(finalGroups.values()).flat()].map((f: any) => s(f.number)));
        const [purchLines, finalLines] = await Promise.all([
          linesOf(tctx, 'purchInvLines', matchedNos),
          finalDocs.size ? linesOf(tctx, 'salesInvoiceLines', Array.from(finalDocs)) : Promise.resolve(new Map<string, Line[]>()),
        ]);
        byTarget.set(t, { purchases, unmatched, purchLines, finals, finalLines, drafts, purchMemos, finalGroups, finalMemos, finalMemoLines });
      } catch (e: any) {
        warnings.push(`${t}: ${String(e.message).substring(0, 200)}`);
      }
    }));

    // Facturas del origen anuladas con un abono por el importe completo, y la factura que las sustituye (mismo destino y
    // External Document No.)
    const cancelledBy = new Map<string, any>();
    for (const { x } of ic) {
      const m = creditedBy.get(`no:${norm(x.number)}`);
      if (m && Math.abs(n(m.totalAmountExcludingTax) - n(x.totalAmountExcludingTax)) < 0.05) cancelledBy.set(s(x.number), m);
    }
    const replacementOf = (no: string, target: string, ext: string) => ext
      ? ic.find(r => r.target === target && s(r.x.number) !== no && !cancelledBy.has(s(r.x.number)) && norm(r.x.externalDocumentNumber) === norm(ext))
      : undefined;
    const fmtA = (v: number) => v.toFixed(2);
    // Drop shipment: facturas del origen al destino con el mismo External Document No. aunque sean de fuera del periodo
    // (un mismo pedido facturado por separado), con sus líneas
    const outside = new Map<string, any[]>();
    if (source === 'CRAZE') {
      const exts = Array.from(new Set(ic.filter(r => DROP_SHIP_TARGETS.includes(r.target) && s(r.x.externalDocumentNumber)).map(r => s(r.x.externalDocumentNumber))));
      const inIc = new Set(ic.map(r => s(r.x.number)));
      for (const part of chunk(exts, 15)) {
        const found = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, {
          $filter: part.map(e => `externalDocumentNumber eq '${q(e)}'`).join(' or '),
          $select: 'number,externalDocumentNumber,postingDate,customerName,totalAmountExcludingTax,status',
        }), ctx.token).catch(() => [] as any[]);
        for (const x of found.filter((x: any) => s(x.status) !== 'Draft' && !inIc.has(s(x.number)) && groupCompanyOf(s(x.customerName)))) {
          const k = `${groupCompanyOf(s(x.customerName))}|${norm(x.externalDocumentNumber)}`;
          outside.set(k, [...(outside.get(k) || []), x]);
        }
      }
      const extraNos = Array.from(outside.values()).flat().map((x: any) => s(x.number));
      if (extraNos.length) for (const [k, v] of await linesOf(ctx, 'salesInvoiceLines', extraNos)) salesLines.set(k, v);
    }
    // Suma de líneas (cantidad por artículo) de varios documentos, restando los abonos
    const netLines = (plus: (Line[] | undefined)[], minus: (Line[] | undefined)[] = []) =>
      [...plus.flatMap(l => l || []), ...minus.flatMap(l => (l || []).map(x => ({ ...x, quantity: -x.quantity, amount: -x.amount })))];

    const rows: IcRow[] = ic.map(({ x, target }) => {
      const tg = byTarget.get(target);
      const no = s(x.number);
      const currency = s(x.currencyCode) || lcyOf(source);
      const amount = n(x.totalAmountExcludingTax);
      const issues: string[] = [];
      const corrected: string[] = [];
      const cancel = cancelledBy.get(no);
      const replacement = cancel ? replacementOf(no, target, s(x.externalDocumentNumber)) : undefined;
      if (cancel) corrected.push(`Anulada con el abono ${s(cancel.number)}${replacement ? ` y sustituida por ${s(replacement.x.number)} (${fmtA(n(replacement.x.totalAmountExcludingTax))})` : ''}`);
      const p = tg?.purchases.get(norm(no));
      let purchase: IcRow['purchase'] = null;
      let lines: IcRow['lines'] = [];
      if (!tg) issues.push(`No se ha podido leer ${target}`);
      else if (!p) {
        const draft = tg.drafts.get(norm(no));
        issues.push(`Sin factura de compra en ${target} con Vendor Invoice No. ${no}${draft ? ` (está en borrador, sin registrar: ${draft})` : ''}`);
        // Factura que sustituye a otra anulada: la compra puede estar registrada con el nº de la anulada y este importe
        const old = ic.find(r => r.target === target && cancelledBy.has(s(r.x.number)) && s(r.x.number) !== no && norm(r.x.externalDocumentNumber) === norm(x.externalDocumentNumber) && norm(x.externalDocumentNumber));
        const op = old && tg.purchases.get(norm(old.x.number));
        if (old && op && Math.abs(n(op.totalAmountExcludingTax) - amount) < 0.05 && !tg.purchMemos.has(s(op.number))) {
          corrected.push(`Sustituye a ${s(old.x.number)} (anulada con ${s(cancelledBy.get(s(old.x.number)).number)}); la compra está registrada con el nº de la anulada: ${s(op.number)} por ${fmtA(n(op.totalAmountExcludingTax))}${draft ? `. Ojo: no registres el borrador ${draft}, se duplicaría` : ''}`);
        }
      } else {
        purchase = {
          no: s(p.number), vendorInvoiceNo: s(p.vendorInvoiceNumber), postingDate: d10(p.postingDate), invoiceDate: d10(p.invoiceDate),
          vendor: s(p.vendorName), currency: s(p.currencyCode) || lcyOf(target), amount: n(p.totalAmountExcludingTax),
        };
        // Un punto final de más (factura corregida al introducirla) se da por bueno
        if (purchase.vendorInvoiceNo.replace(/\.+$/, '') !== no) issues.push(`Vendor Invoice No. escrito distinto (${purchase.vendorInvoiceNo})`);
        if (Math.abs(purchase.amount - amount) > 0.05) {
          issues.push(`Importe distinto (${amount.toFixed(2)} vs ${purchase.amount.toFixed(2)})`);
          // Compra abonada en el destino
          const pm = tg.purchMemos.get(purchase.no) || [];
          if (pm.length) corrected.push(`Compra abonada con ${pm.map((m: any) => `${s(m.number)} (${fmtA(n(m.totalAmountExcludingTax))})`).join(', ')}`);
        }
        if (purchase.currency !== currency) issues.push(`Divisa distinta (${currency} vs ${purchase.currency})`);
        if (purchase.invoiceDate !== d10(x.invoiceDate)) issues.push(`Fecha distinta (${d10(x.invoiceDate)} vs ${purchase.invoiceDate})`);
        const cmp = compareLines(salesLines.get(no), tg.purchLines.get(purchase.no), target === 'Craze Entertainment');
        lines = cmp.rows;
        if (!cmp.ok) issues.push('Artículos o cantidades distintos en la compra');
      }
      let final: IcRow['final'] = null;
      if (source === 'CRAZE' && DROP_SHIP_TARGETS.includes(target) && tg) {
        const ext = s(x.externalDocumentNumber);
        const f = tg.finals.get(norm(no));
        if (!ext) issues.push('Sin External Document No. (factura final del drop shipment)');
        else if (!f) issues.push(`Sin factura de venta final en ${target} con nº o External Document No. ${ext}`);
        const cmp = compareLines(salesLines.get(no), f ? tg.finalLines.get(s(f.number)) : []);
        final = {
          no: f ? s(f.number) : ext, customer: s(f?.customerName), postingDate: d10(f?.postingDate), currency: s(f?.currencyCode) || lcyOf(target),
          amount: n(f?.totalAmountExcludingTax), found: !!f, lines: cmp.rows,
        };
        if (f && !cmp.ok) {
          issues.push('Artículos o cantidades distintos en la venta final');
          // Corregido con abonos y facturas nuevas: todas las facturas del origen al destino con ese External Document No.
          // frente a todas las ventas finales con ese nº (menos sus abonos) cuadran en artículos y cantidades
          const group = tg.finalGroups.get(norm(ext)) || [];
          const memos = group.flatMap((g: any) => tg.finalMemos.get(s(g.number)) || []);
          const mineAll = [
            ...ic.filter(r => r.target === target && !cancelledBy.has(s(r.x.number)) && norm(r.x.externalDocumentNumber) === norm(ext)).map(r => r.x),
            ...(outside.get(`${target}|${norm(ext)}`) || []).filter((x: any) => !creditedBy.has(`no:${norm(x.number)}`)),
          ];
          if (group.length > 1 || memos.length || mineAll.length > 1) {
            const net = compareLines(
              netLines(mineAll.map((x: any) => salesLines.get(s(x.number)))),
              netLines(group.map((g: any) => tg.finalLines.get(s(g.number))), memos.map((m: any) => tg.finalMemoLines.get(s(m.number)))),
            );
            const others = mineAll.filter((x: any) => s(x.number) !== no).map((x: any) => s(x.number));
            if (!net.ok) {
              // Facturado por separado pero aún con diferencias: qué artículos no cuadran en el conjunto
              const diff = net.rows.filter(d => Math.abs(d.a - d.b) > 0.0001).map(d => `${d.no} ${d.description} (${d.a} de ${source}, ${d.b} en las ventas finales)`);
              issues[issues.length - 1] = `Artículos o cantidades distintos en la venta final: con todas las facturas de ${ext} (${[no, ...others].join(', ')} de ${source}; ${group.map((g: any) => s(g.number)).join(', ') || '–'}${memos.length ? ` menos ${memos.map((m: any) => s(m.number)).join(', ')}` : ''} en ${target}) no cuadra: ${diff.join(' · ')}`;
            }
            if (net.ok) {
              corrected.push(`Venta final ${ext} corregida: ${group.map((g: any) => `${s(g.number)} (${fmtA(n(g.totalAmountExcludingTax))})`).join(', ')}${memos.length ? ` menos los abonos ${memos.map((m: any) => `${s(m.number)} (${fmtA(n(m.totalAmountExcludingTax))})`).join(', ')}` : ''}${others.length ? `, junto con ${others.join(', ')} de ${source}` : ''}: cuadran los artículos y cantidades`);
            }
          }
        }
      }
      return {
        source, target, invoiceNo: no, postingDate: d10(x.postingDate), invoiceDate: d10(x.invoiceDate), customer: s(x.customerName),
        currency, amount, externalDocNo: s(x.externalDocumentNumber), purchase, lines, final, issues,
        // Subsanada solo si cada incidencia tiene su corrección (anulada: todas)
        ...(corrected.length && (cancel || corrected.length >= issues.length) ? { corrected } : {}),
      };
    });

    // Compras al origen en otras empresas sin factura de venta del origen en el periodo
    const orphanPurchases = Array.from(byTarget.entries()).flatMap(([t, tg]) => tg.unmatched.map((p: any) => ({
      target: t, no: s(p.number), vendorInvoiceNo: s(p.vendorInvoiceNumber), postingDate: d10(p.postingDate), invoiceDate: d10(p.invoiceDate),
      vendor: s(p.vendorName), currency: s(p.currencyCode) || lcyOf(t), amount: n(p.totalAmountExcludingTax),
    })));
    return { source, from, to, rows, orphanPurchases, excludedCredited: excluded, warnings };
  }, force);
}
