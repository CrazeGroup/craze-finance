import { bcFetchAll, BcContext, getBcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';

// Commercial Analysis: recreación del Power BI "Commercial Analysis" leyendo BC en directo.
// Sell-in = facturado (componentes LM, custom documentsLMComponents) + pedidos abiertos (OData Sales_Lines_Excel, como
// el Power BI: Line_Amount entero de toda línea que no sea de factura, por Requested Delivery Date; las devoluciones por
// la fecha de registro de la Return Order); presupuesto y forecast = custom budgetItems/budgetUnits y forecastItems/forecastUnits;
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
  // Datos maestros: se renuevan una vez al día (o con el botón de actualizar)
  return cached('commercial:dims', 24 * HOUR, async () => {
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
  }, force, { refreshAfterMs: 24 * HOUR });
}

// ---------- Hechos ----------

// Medidas de cada fila agregada (en este orden)
export const MEASURES = ['inv', 'invEur', 'invQty', 'so', 'soEur', 'soQty', 'bdg', 'bdgEur', 'bdgQty', 'fc', 'fcEur', 'fcQty'] as const;
// Fila: [mes 1-12, parte del mes (0 = hasta el día de hoy, 1 = después), clase (0 normal, 1 Main Item, 2 componente),
//        Customer Group, KAM, país de venta (ficha de cliente), país de envío, artículo, ...medidas]
export type FactRow = [number, number, number, string, string, string, string, string, ...number[]];

// EUR por 1 unidad de la divisa, como la columna Currency_Exchg_EUR del Power BI: Currency Exchange Rates de CRAZE,
// 1 / Exchange_Rate_Amount de la última fecha de inicio <= la fecha; sin tipo = 1
async function rateToEur(currency: string) {
  if (currency === 'EUR') return () => 1;
  const crz = await getBcContext('CRAZE');
  const rows = await bcFetchAll(odataUrl(`${crz.odataCompanyBase}/Currency_Exchange_Rates`, {
    $select: 'Currency_Code,Starting_Date,Exchange_Rate_Amount', $filter: `Currency_Code eq '${currency}'`,
  }), crz.token).catch(() => [] as any[]);
  const list = rows.map((r: any) => ({ date: d10(r.Starting_Date), rate: n(r.Exchange_Rate_Amount) ? 1 / n(r.Exchange_Rate_Amount) : 1 }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return (date: string) => list.filter(r => r.date <= date).pop()?.rate ?? 1;
}

// Pedidos abiertos como Sales_Lines_Excel_<empresa> del Power BI: líneas que no son de factura, con cliente, fecha =
// Requested Delivery Date (Return Order: Posting Date de la devolución). En CRAZE, las líneas del almacén ASIA son de Asia.
// newToday: línea de un pedido de venta con Order Date de hoy (custom salesHeaders), para la columna "Δ hoy".
async function openSalesLines(ctx: BcContext, location: 'notAsia' | 'asia' | 'all') {
  const [lines, returns, todayOrders] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Sales_Lines_Excel`, {
      $filter: `Document_Type ne 'Invoice'${location === 'asia' ? ` and Location_Code eq 'ASIA'` : ''}`,
      $select: 'Document_Type,Document_No,Sell_to_Customer_No,No,Location_Code,Quantity,Line_Amount,AIT_Requested_Delivery_Date',
    }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Sales_Return_Order_Excel`, { $select: 'No,Posting_Date' }), ctx.token).catch(() => [] as any[]),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/salesHeaders`, { $filter: `documentType eq 'Order' and orderDate eq ${today()}`, $select: 'no' }), ctx.token).catch(() => [] as any[]),
  ]);
  const newOrders = new Set(todayOrders.map((h: any) => s(h.no)));
  const returnDate = new Map(returns.map((r: any) => [s(r.No), d10(r.Posting_Date)]));
  return lines
    .filter((l: any) => s(l.Sell_to_Customer_No) && (location !== 'notAsia' || s(l.Location_Code) !== 'ASIA'))
    .map((l: any) => ({
      date: s(l.Document_Type) === 'Return Order' ? returnDate.get(s(l.Document_No)) || '' : d10(l.AIT_Requested_Delivery_Date),
      cust: s(l.Sell_to_Customer_No), item: s(l.No), qty: n(l.Quantity), amount: n(l.Line_Amount),
      newToday: s(l.Document_Type) === 'Order' && newOrders.has(s(l.Document_No)),
    }));
}

export async function commercialFacts(abbr: CompanyAbbr, year: number, force = false) {
  const company = COMPANIES.find(c => c.abbr === abbr)!;
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const live = to >= today();
  // Guardado: el año en curso se renueva cada hora en segundo plano (para el cambio del día) y los años cerrados una vez al día (la parte
  // "hasta hoy" del mes actual cambia cada día para el año anterior); el botón de actualizar lo fuerza.
  return cached(`commercial:facts2:${abbr}:${year}${live ? '' : `:${today()}`}`, 24 * HOUR, async () => {
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
      // Pedidos abiertos de cualquier año (el Power BI no filtra: cada línea cuenta en el año de su fecha)
      safe('Pedidos abiertos', abbr === 'GmbH' ? openSalesLines(ctx, 'notAsia')
        : abbr === 'Asia' ? Promise.all([openSalesLines(ctx, 'all'), getBcContext('CRAZE').then(crz => openSalesLines(crz, 'asia'))]).then(([a, b]) => [...a, ...b])
        : openSalesLines(ctx, 'all')),
      // Ficha de cliente de CRAZE para todas las empresas (Customer_Card_Excel del Power BI)
      safe('Clientes', getBcContext('CRAZE').then(crz => bcFetchAll(odataUrl(`${crz.odataCompanyBase}/Customer_Card_Excel`, { $select: 'No,Country_Region_Code,Customer_Group_Code_CRZ,Currency_Code' }), crz.token))),
      plans ? safe('Presupuesto', bcFetchAll(odataUrl(`${ctx.customApiBase}/budgetItems`, { $filter: `postingDate ge ${from} and postingDate le ${to}` }), ctx.token)) : none,
      plans ? safe('Presupuesto (uds.)', bcFetchAll(odataUrl(`${ctx.customApiBase}/budgetUnits`, { $filter: `postingDate ge ${from} and postingDate le ${to}` }), ctx.token)) : none,
      plans ? safe('Forecast', bcFetchAll(odataUrl(`${ctx.customApiBase}/forecastItems`, { $filter: `postingDate ge ${from} and postingDate le ${to}` }), ctx.token)) : none,
      plans ? safe('Forecast (uds.)', bcFetchAll(odataUrl(`${ctx.customApiBase}/forecastUnits`, { $filter: `postingDate ge ${from} and postingDate le ${to}` }), ctx.token)) : none,
      rateToEur(company.currency),
    ]);
    const custBy = new Map(customers.map((c: any) => [s(c.No), { country: s(c.Country_Region_Code), group: s(c.Customer_Group_Code_CRZ) }]));
    const kamOf = (group: string, item: Item | undefined) =>
      dims.kamByGroupBu[`${group}_${item?.bu || ''}`] || groupBy.get(group)?.kam || '';

    const facts = new Map<string, FactRow>();
    const newRows = new Map<string, FactRow>();   // pedidos con Order Date de hoy
    const add = (date: string, cls: number, group: string, cust: string, ship: string, itemNo: string, measure: number, value: number, rows = facts) => {
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
    // Pedidos abiertos (Rev_SO / Uds_SO del Power BI): Line_Amount y Quantity enteros, sin signo, en la fecha de la línea
    for (const l of salesLines) {
      if (!l.date) continue;
      const group = custBy.get(l.cust)?.group || '';
      add(l.date, 0, group, l.cust, '', l.item, I('so'), l.amount);
      add(l.date, 0, group, l.cust, '', l.item, I('soEur'), l.amount * fx(l.date));
      add(l.date, 0, group, l.cust, '', l.item, I('soQty'), l.qty);
      if (l.newToday) {
        add(l.date, 0, group, l.cust, '', l.item, I('so'), l.amount, newRows);
        add(l.date, 0, group, l.cust, '', l.item, I('soEur'), l.amount * fx(l.date), newRows);
        add(l.date, 0, group, l.cust, '', l.item, I('soQty'), l.qty, newRows);
      }
    }
    // Presupuesto y forecast: importe (…Items) y unidades (…Units), en la divisa de la empresa
    const plan = (list: any[], measure: 'bdg' | 'fc' | 'bdgQty' | 'fcQty', field: 'amount' | 'quantity') => {
      for (const b of list) {
        const date = d10(b.postingDate);
        const v = n(b[field]);
        add(date, 0, s(b.customerGroupCode), '', '', s(b.itemNo), I(measure), v);
        // amountEUR de BC (como el Power BI); si no viene, al tipo de cambio
        if (field === 'amount') add(date, 0, s(b.customerGroupCode), '', '', s(b.itemNo), I(measure === 'bdg' ? 'bdgEur' : 'fcEur'), b.amountEUR != null ? n(b.amountEUR) : v * fx(date));
      }
    };
    plan(bItems, 'bdg', 'amount'); plan(bUnits, 'bdgQty', 'quantity');
    plan(fItems, 'fc', 'amount'); plan(fUnits, 'fcQty', 'quantity');

    const round = (m: Map<string, FactRow>) => Array.from(m.values()).map(r => r.map((v, i) => (i >= 8 ? Math.round((v as number) * 100) / 100 : v)));
    return {
      company: abbr, currency: company.currency, year, cutoff: today(),
      rows: round(facts),
      // Pedidos de venta con Order Date de hoy (columna "Δ hoy" de Sales Performance)
      delta: round(newRows),
      itemRoyalty,
      counts: { lm: lm.length, salesLines: salesLines.length, budget: bItems.length, forecast: fItems.length },
      warnings,
    };
  }, force, { refreshAfterMs: live ? HOUR : 24 * HOUR });
}
