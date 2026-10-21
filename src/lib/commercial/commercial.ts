import { bcFetchAll, BcContext, getBcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';

// Commercial Analysis: recreación del Power BI "Commercial Analysis" leyendo BC en directo.
// Sell-in = facturado (componentes LM, custom documentsLMComponents) + pedidos abiertos (OData Sales_Lines_Excel,
// pendiente de servir); presupuesto y forecast = custom budgetItems/budgetUnits y forecastItems/forecastUnits;
// sell-out = OData SellOuts_CRZ (por GTIN) + SellIn_B2C. Los datos maestros (artículos, Customer Groups, KAM,
// dimensiones) salen de CRAZE GmbH, como en el Power BI.
// Los hechos se agregan por empresa × mes × Customer Group × KAM × país × artículo para que la página pueda filtrar y
// agrupar en el navegador.

export const COMPANIES = [
  { abbr: 'GmbH', bc: 'CRAZE', currency: 'EUR' },
  { abbr: 'UK', bc: 'Craze UK', currency: 'GBP' },
  { abbr: 'Swiss', bc: 'CRAZE Group AG', currency: 'CHF' },
  { abbr: 'Asia', bc: 'CRAZE Macau LTD', currency: 'USD' },
] as const;
export type CompanyAbbr = typeof COMPANIES[number]['abbr'];

const s = (v: any) => (v == null ? '' : String(v).trim());
const n = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const d10 = (v: any) => { const x = s(v).substring(0, 10); return x && x !== '0001-01-01' ? x : ''; };
const EXCLUDED_GROUP = '223';   // intercompañía (filtro del Power BI)

// ---------- Datos maestros ----------

export type Item = { no: string; desc: string; raw: string; root: string; rootUnits: number; line: string; license: string; royalty: string; bu: string; gtin: string };
export type Dims = {
  items: Item[];
  rawDesc: Record<string, string>;                 // descripción de cada Raw Article / Article To Root
  groups: { code: string; desc: string; dim: string; kam: string }[];
  kamByGroupBu: Record<string, string>;            // "grupo_BU" → KAM
  kams: Record<string, string>;                    // código → nombre
  dimensions: Record<string, string>;              // código → nombre (dimensión CUSTOMER)
};

export async function commercialDims(force = false): Promise<Dims> {
  return cached('commercial:dims', 6 * HOUR, async () => {
    const ctx = await getBcContext('CRAZE');
    const [items, groups, kamGroups, kams, dims] = await Promise.all([
      // API custom items (la página Item_Card_Excel tarda más de 30 s)
      bcFetchAll(odataUrl(`${ctx.customApiBase}/items`, {
        $select: 'no,description,gtin,rawArticle,itemToRoot,itemToRootUnits,line,license,businessUnit',
      }), ctx.token, 55_000),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/customerGroups`, { $select: 'code,description,customerDimensionCode,salespersonCode' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/salesperonCustomerGroups`, { $select: 'customerGroupCode,code,businessUnitCode' }), ctx.token).catch(() => [] as any[]),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/AIT_14_Salespeople`, { $select: 'Code,Name' }), ctx.token).catch(() => [] as any[]),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Dimension_Values_Excel`, { $select: 'Dimension_Code,Code,Name' }), ctx.token).catch(() => [] as any[]),
    ]);
    const list: Item[] = items
      .filter((i: any) => s(i.line) && s(i.businessUnit) !== 'PUBLISHING')
      .map((i: any) => ({
        no: s(i.no), desc: s(i.description), raw: s(i.rawArticle), root: s(i.itemToRoot),
        rootUnits: n(i.itemToRootUnits) || 1, line: s(i.line), license: s(i.license),
        royalty: '', bu: s(i.businessUnit), gtin: s(i.gtin),
      }));
    // Descripción del artículo base: la del artículo con ese nº (o nº + DE / EN), como Distinct_ArtNo del Power BI
    const byNo = new Map(list.map(i => [i.no, i.desc]));
    const rawDesc: Record<string, string> = {};
    for (const code of new Set(list.flatMap(i => [i.raw, i.root]).filter(Boolean))) {
      rawDesc[code] = byNo.get(code) || byNo.get(`${code}DE`) || byNo.get(`${code}EN`) || list.find(i => i.raw === code)?.desc || '';
    }
    return {
      items: list, rawDesc,
      groups: groups.map((g: any) => ({ code: s(g.code), desc: s(g.description), dim: s(g.customerDimensionCode), kam: s(g.salespersonCode) })),
      kamByGroupBu: Object.fromEntries(kamGroups.map((k: any) => [`${s(k.customerGroupCode)}_${s(k.businessUnitCode)}`, s(k.code)])),
      kams: Object.fromEntries(kams.map((k: any) => [s(k.Code), s(k.Name)])),
      dimensions: Object.fromEntries(dims.filter((d: any) => /customer/i.test(s(d.Dimension_Code))).map((d: any) => [s(d.Code), s(d.Name)])),
    };
  }, force);
}

// ---------- Hechos ----------

// Medidas de cada fila agregada (en este orden)
export const MEASURES = ['inv', 'invEur', 'invQty', 'so', 'soEur', 'soQty', 'bdg', 'bdgEur', 'bdgQty', 'fc', 'fcEur', 'fcQty'] as const;
// Fila: [mes 1-12, parte del mes (0 = hasta el día de hoy, 1 = después), clase (0 normal, 1 Main Item, 2 componente),
//        Customer Group, KAM, país de venta (ficha de cliente), país de envío, artículo, ...medidas]
export type FactRow = [number, number, number, string, string, string, string, string, ...number[]];

async function rateToEur(ctx: BcContext, currency: string) {
  if (currency === 'EUR') return () => 1;
  // Currency Exchange Rates de la empresa → EUR por 1 unidad de su divisa local, por fecha
  const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Currency_Exchange_Rates`, { $select: 'Currency_Code,Starting_Date,Exchange_Rate_Amount,Relational_Exch_Rate_Amount' }), ctx.token).catch(() => [] as any[]);
  const list = rows.filter((r: any) => s(r.Currency_Code) === 'EUR' || s(r.Currency_Code) === currency)
    .map((r: any) => ({ code: s(r.Currency_Code), date: d10(r.Starting_Date), rate: n(r.Exchange_Rate_Amount) / (n(r.Relational_Exch_Rate_Amount) || 1) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return (date: string) => {
    // Tabla de la propia empresa (divisa local X): la fila EUR da Exchange_Rate_Amount EUR por Relational_Exch_Rate_Amount X
    const eur = list.filter(r => r.code === 'EUR' && r.date <= date).pop() || list.find(r => r.code === 'EUR');
    return eur?.rate || 1;
  };
}

export async function commercialFacts(abbr: CompanyAbbr, year: number, force = false) {
  const company = COMPANIES.find(c => c.abbr === abbr)!;
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const live = to >= today();
  // Años cerrados: una vez al día (la parte "hasta hoy" del mes actual cambia cada día para el año anterior)
  return cached(`commercial:facts:${abbr}:${year}${live ? '' : `:${today()}`}`, live ? HOUR : 24 * HOUR, async () => {
    const dims = await commercialDims();
    const itemBy = new Map(dims.items.map(i => [i.no, i]));
    const groupBy = new Map(dims.groups.map(g => [g.code, g]));
    const ctx = await getBcContext(company.bc);
    const cutDay = Number(today().substring(8, 10));
    const cutMonth = Number(today().substring(5, 7));
    const warnings: string[] = [];
    // Presupuesto y forecast solo de GmbH y UK (el Power BI combina budgetUnits_GmbH/_UK y forecastUnits_GmbH/_UK)
    const plans = abbr === 'GmbH' || abbr === 'UK';
    const none = Promise.resolve([] as any[]);
    const safe = <T,>(label: string, p: Promise<T[]>) => p.catch((e: any) => { warnings.push(`${label}: ${String(e.message).substring(0, 160)}`); return [] as T[]; });

    const [lm, salesLines, customers, bItems, bUnits, fItems, fUnits, fx] = await Promise.all([
      safe('Facturado (LM)', bcFetchAll(odataUrl(`${ctx.customApiBase}/documentsLMComponents`, {
        $filter: `postingDate ge ${from} and postingDate le ${to}`,
        $select: 'postingDate,sellToCustomerNo,no,quantity,lineAmount,lineAmountLCY,lineAmountEUR,component,mainItemCRZ,shipToCountryRegionCode,customerGroupCode,productLineCode,royaltyCode',
      }), ctx.token, 55_000)),
      live ? safe('Pedidos abiertos', bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Sales_Lines_Excel`, {
        $filter: `Document_Type ne 'Invoice' and Type eq 'Item'`,
        $select: 'Document_Type,Sell_to_Customer_No,No,Quantity,Outstanding_Quantity,Line_Amount,Shipment_Date',
      }), ctx.token)) : Promise.resolve([] as any[]),
      safe('Clientes', bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Customer_Card_Excel`, { $select: 'No,Country_Region_Code,Customer_Group_Code_CRZ,Currency_Code' }), ctx.token)),
      plans ? safe('Presupuesto', bcFetchAll(odataUrl(`${ctx.customApiBase}/budgetItems`, { $filter: `postingDate ge ${from} and postingDate le ${to}` }), ctx.token)) : none,
      plans ? safe('Presupuesto (uds.)', bcFetchAll(odataUrl(`${ctx.customApiBase}/budgetUnits`, { $filter: `postingDate ge ${from} and postingDate le ${to}` }), ctx.token)) : none,
      plans ? safe('Forecast', bcFetchAll(odataUrl(`${ctx.customApiBase}/forecastItems`, { $filter: `postingDate ge ${from} and postingDate le ${to}` }), ctx.token)) : none,
      plans ? safe('Forecast (uds.)', bcFetchAll(odataUrl(`${ctx.customApiBase}/forecastUnits`, { $filter: `postingDate ge ${from} and postingDate le ${to}` }), ctx.token)) : none,
      rateToEur(ctx, company.currency),
    ]);
    const custBy = new Map(customers.map((c: any) => [s(c.No), { country: s(c.Country_Region_Code), group: s(c.Customer_Group_Code_CRZ) }]));
    const kamOf = (group: string, item: Item | undefined) =>
      dims.kamByGroupBu[`${group}_${item?.bu || ''}`] || groupBy.get(group)?.kam || '';

    const rows = new Map<string, FactRow>();
    const add = (date: string, cls: number, group: string, cust: string, ship: string, itemNo: string, measure: number, value: number) => {
      if (!value || !date.startsWith(String(year))) return;
      const item = itemBy.get(itemNo);
      if (!item || group === EXCLUDED_GROUP) return;   // solo artículos con línea de producto (no PUBLISHING), sin intercompañía
      const m = Number(date.substring(5, 7));
      const part = m === cutMonth && Number(date.substring(8, 10)) > cutDay ? 1 : 0;
      const sell = custBy.get(cust)?.country || '';
      const kam = kamOf(group, item);
      const key = `${m}|${part}|${cls}|${group}|${kam}|${sell}|${ship}|${itemNo}`;
      let r = rows.get(key);
      if (!r) { r = [m, part, cls, group, kam, sell, ship, itemNo, ...MEASURES.map(() => 0)] as FactRow; rows.set(key, r); }
      (r as number[])[8 + measure] += value;
    };
    const I = (k: typeof MEASURES[number]) => MEASURES.indexOf(k);

    // Royalty Code de cada artículo (de la LM; la API de artículos no lo publica)
    const itemRoyalty: Record<string, string> = {};
    for (const l of lm) {
      if (s(l.royaltyCode) && !itemRoyalty[s(l.no)]) itemRoyalty[s(l.no)] = s(l.royaltyCode);
      const date = d10(l.postingDate);
      if (!s(l.productLineCode)) continue;
      const cls = l.component ? 2 : l.mainItemCRZ ? 1 : 0;
      const group = s(l.customerGroupCode);
      const local = company.abbr === 'Swiss' ? n(l.lineAmountLCY) : company.abbr === 'GmbH' ? n(l.lineAmountEUR) : n(l.lineAmount);
      add(date, cls, group, s(l.sellToCustomerNo), s(l.shipToCountryRegionCode), s(l.no), I('inv'), local);
      add(date, cls, group, s(l.sellToCustomerNo), s(l.shipToCountryRegionCode), s(l.no), I('invEur'), n(l.lineAmountEUR));
      add(date, cls, group, s(l.sellToCustomerNo), s(l.shipToCountryRegionCode), s(l.no), I('invQty'), n(l.quantity));
    }
    // Pedidos abiertos: pendiente de servir (importe × cantidad pendiente / cantidad), por fecha de envío; devoluciones en negativo
    for (const l of salesLines) {
      const date = d10(l.Shipment_Date);
      const qty = n(l.Quantity), out = n(l.Outstanding_Quantity);
      if (!qty || !out) continue;
      const sign = /return|credit/i.test(s(l.Document_Type)) ? -1 : 1;
      const amount = sign * n(l.Line_Amount) * (out / qty);
      const cust = s(l.Sell_to_Customer_No);
      const group = custBy.get(cust)?.group || '';
      add(date, 0, group, cust, '', s(l.No), I('so'), amount);
      add(date, 0, group, cust, '', s(l.No), I('soEur'), amount * fx(date));
      add(date, 0, group, cust, '', s(l.No), I('soQty'), sign * out);
    }
    // Presupuesto y forecast: importe (…Items) y unidades (…Units), en la divisa de la empresa
    const plan = (list: any[], measure: 'bdg' | 'fc' | 'bdgQty' | 'fcQty', field: 'amount' | 'quantity') => {
      for (const b of list) {
        const date = d10(b.postingDate);
        const v = n(b[field]);
        add(date, 0, s(b.customerGroupCode), '', '', s(b.itemNo), I(measure), v);
        if (field === 'amount') add(date, 0, s(b.customerGroupCode), '', '', s(b.itemNo), I(measure === 'bdg' ? 'bdgEur' : 'fcEur'), v * fx(date));
      }
    };
    plan(bItems, 'bdg', 'amount'); plan(bUnits, 'bdgQty', 'quantity');
    plan(fItems, 'fc', 'amount'); plan(fUnits, 'fcQty', 'quantity');

    return {
      company: abbr, currency: company.currency, year, cutoff: today(),
      rows: Array.from(rows.values()).map(r => r.map((v, i) => (i >= 8 ? Math.round((v as number) * 100) / 100 : v))),
      itemRoyalty,
      counts: { lm: lm.length, salesLines: salesLines.length, budget: bItems.length, forecast: fItems.length },
      warnings,
    };
  }, force);
}
