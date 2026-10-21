import { bcFetchAll, BcContext, getBcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';
import { hiddenByPairs, vendorCancelPairs } from './cancelledDocs';

// Controlling · BWA (Power BI): desglose de una cuenta de mapeo (gLAccountNo2) hasta documento y artículo.
// 1. glEntriesUnion (API custom en CRAZE, todas las sociedades): movimientos de la cuenta de mapeo en el periodo, con
//    la sociedad, su cuenta real (gLAccountNo), el nº de movimiento y la marca de eliminación.
// 2. G/L Entries de cada sociedad (OData General_Ledger_Entries_Excel), por las cuentas reales y el periodo, unidas
//    por Entry No.: tipo y nº de documento, origen (Source Code / Source Type / Source No.), descripción, contrapartida.
// 3. Nombres de proveedores y clientes (API v2 de cada sociedad).
// Las líneas de cada factura/abono (con el artículo) se piden aparte al desplegar el documento (documentLines).
// Importes en EUR con el signo invertido, como la tabla BWA (UK y Group AG con el tipo de Currencies_Excel).

export const INTERCO = 'CRAZE Intercompany';
export const CONSOL = 'CRAZE Consolidated';

export type DetailEntry = {
  company: string; entryNo: number; date: string; account: string; documentType: string; documentNo: string;
  sourceCode: string; sourceType: string; sourceNo: string; sourceName: string; description: string;
  externalDocNo: string; balAccount: string; amount: number; elimination: boolean;
};

const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const q = (v: string) => v.replace(/'/g, "''");
const docType = (v: any) => s(v).replace(/_x0020_/g, ' ').replace(/_/g, ' ');

async function partnerNames(ctx: BcContext) {
  return cached(`bwa-detail:partners:${ctx.companyName}`, 6 * HOUR, async () => {
    const [vendors, customers] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, { $select: 'number,displayName' }), ctx.token).catch(() => [] as any[]),
      bcFetchAll(odataUrl(`${ctx.apiBase}/customers`, { $select: 'number,displayName' }), ctx.token).catch(() => [] as any[]),
    ]);
    return {
      Vendor: Object.fromEntries(vendors.map(v => [s(v.number), s(v.displayName)])),
      Customer: Object.fromEntries(customers.map(c => [s(c.number), s(c.displayName)])),
    } as Record<string, Record<string, string>>;
  });
}

// scope: nombre de sociedad (todos sus movimientos), CRAZE Intercompany (eliminación) o CRAZE Consolidated (el resto)
export async function bwaAccountDetail(account2: string, scope: string, from: string, to: string, force = false) {
  const key = `bwa-detail2:${account2}:${scope}:${from}:${to}`;
  return cached(key, to < today() ? 12 * HOUR : HOUR, async () => {
    const crz = await getBcContext('CRAZE');
    const [union, currencies] = await Promise.all([
      bcFetchAll(odataUrl(`${crz.customApiBase}/glEntriesUnion`, {
        $filter: `gLAccountNo2 eq '${q(account2)}' and postingDate ge ${from} and postingDate le ${to}`
          + (scope !== INTERCO && scope !== CONSOL ? ` and company eq '${q(scope)}'` : ''),
        $select: 'company,entryNo,gLAccountNo,postingDate,documentNo,amount,amountLCY,elimination',
      }), crz.token),
      bcFetchAll(odataUrl(`${crz.odataCompanyBase}/Currencies_Excel`, { $select: 'Code,ExchangeRateAmt' }), crz.token),
    ]);
    const rate = (code: string) => currencies.find((c: any) => c.Code === code && c.ExchangeRateAmt)?.ExchangeRateAmt ?? null;
    const rates: Record<string, number | null> = { GBP: rate('GBP'), CHF: rate('CHF') };
    const rows = union.filter((e: any) => scope === INTERCO ? e.elimination : scope === CONSOL ? !e.elimination : true);

    // Detalle de cada sociedad desde sus G/L Entries
    const byCompany = new Map<string, any[]>();
    for (const e of rows) byCompany.set(s(e.company), [...(byCompany.get(s(e.company)) || []), e]);
    const warnings: string[] = [];
    const entries: DetailEntry[] = [];
    let cancelled = 0;
    await Promise.all(Array.from(byCompany.entries()).map(async ([company, list]) => {
      const fx = company.includes('UK') ? rates.GBP : company.includes('AG') ? rates.CHF : null;
      const eur = (e: any) => -(fx ? Math.round(n(e.amount) * fx * 100) / 100 : n(e.amountLCY));
      let gl = new Map<number, any>();
      let names: Record<string, Record<string, string>> = {};
      let hidden = new Set<string>();
      try {
        const ctx = await getBcContext(company);
        const accounts = Array.from(new Set(list.map(e => s(e.gLAccountNo))));
        const [glRows, partners, pairs] = await Promise.all([
          bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
            $filter: `Posting_Date ge ${from} and Posting_Date le ${to} and (${accounts.map(a => `G_L_Account_No eq '${q(a)}'`).join(' or ')})`,
            $select: 'Entry_No,Document_Type,Document_No,Description,Source_Type,Source_No,Source_Code,External_Document_No,Bal_Account_No',
          }), ctx.token),
          partnerNames(ctx),
          vendorCancelPairs(ctx, from, to).catch(() => []),
        ]);
        gl = new Map(glRows.map((g: any) => [n(g.Entry_No), g]));
        names = partners;
        // Factura + abono que la anula entera (los dos en esta cuenta y sumando 0): no se muestran
        const byDoc = new Map<string, number>();
        for (const e of list) byDoc.set(s(e.documentNo), (byDoc.get(s(e.documentNo)) || 0) + eur(e));
        hidden = hiddenByPairs(pairs, byDoc);
        cancelled += hidden.size / 2;
      } catch (e: any) {
        warnings.push(`${company}: no se ha podido leer el detalle de sus movimientos (${e.message}). Se muestran solo nº de documento e importe.`);
      }
      for (const e of list) {
        if (hidden.has(s(e.documentNo))) continue;
        const g = gl.get(n(e.entryNo));
        const sourceType = s(g?.Source_Type);
        const sourceNo = s(g?.Source_No);
        entries.push({
          company, entryNo: n(e.entryNo), date: s(e.postingDate).substring(0, 10), account: s(e.gLAccountNo),
          documentType: docType(g?.Document_Type), documentNo: s(e.documentNo) || s(g?.Document_No),
          sourceCode: s(g?.Source_Code), sourceType, sourceNo, sourceName: names[sourceType]?.[sourceNo] || '',
          description: s(g?.Description), externalDocNo: s(g?.External_Document_No), balAccount: s(g?.Bal_Account_No),
          amount: eur(e), elimination: !!e.elimination,
        });
      }
    }));
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.entryNo - b.entryNo);
    return { account: account2, scope, from, to, entries, warnings, cancelledPairs: cancelled };
  }, force);
}

// Líneas de una factura o abono registrados (compra o venta), con el artículo / cuenta de cada línea
export async function documentLines(company: string, documentNo: string, kind: 'purchInv' | 'purchCrMemo' | 'salesInv' | 'salesCrMemo') {
  return cached(`bwa-detail:lines:${company}:${kind}:${documentNo}`, 24 * HOUR, async () => {
    const ctx = await getBcContext(company);
    const entity = { purchInv: 'purchInvLines', purchCrMemo: 'purchCrMemoLines', salesInv: 'salesInvoiceLines', salesCrMemo: 'salesCrMemoLines' }[kind];
    const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/${entity}`, { $filter: `documentNo eq '${q(documentNo)}'` }), ctx.token);
    return rows.filter((r: any) => s(r.type) && s(r.type) !== ' ' && (n(r.quantity) || n(r.amount) || n(r.lineAmount))).map((r: any) => ({
      lineNo: n(r.lineNo), type: s(r.type).replace(/_x0020_/g, ' '), no: s(r.no), description: [s(r.description), s(r.description2)].filter(Boolean).join(' '),
      quantity: n(r.quantity), unitCost: n(r.directUnitCost ?? r.unitPrice), amount: n(r.amount ?? r.lineAmount),
      genProdPostingGroup: s(r.genProdPostingGroup), deferralCode: s(r.deferralCode),
    }));
  });
}
