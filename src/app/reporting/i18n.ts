// Textos y formatos del reporting en castellano, inglés y alemán

export type Lang = 'es' | 'en' | 'de';
export const LANGS: Lang[] = ['es', 'en', 'de'];

const es = {
  title: 'Reporting mensual',
  closing: 'Cierre {month} · datos a {date}',
  operational: 'Operacional', management: 'Dirección', month: 'Mes',
  exportPdf: 'Exportar PDF', refresh: 'Actualizar datos', refreshing: 'Actualizando…',
  loading: 'Cargando…', selectCompany: 'Selecciona una empresa concreta en el menú lateral.',
  keyPointsOp: 'Puntos clave · Operacional', keyPointsDir: 'Puntos clave · Dirección',
  aiNote: 'Generado con IA a partir de las cifras del informe', regenerate: 'Regenerar',
  aiUnavailable: 'La IA no ha respondido a tiempo. Pulsa Regenerar en unos minutos.',
  aiWaiting: 'Se generarán cuando terminen de cargar los datos…', aiGenerating: 'Generando puntos clave…',
  total: 'Total', items: 'partidas', invoicesN: '{n} facturas',
  footer: 'Fuentes: Business Central (Value Entries, Customer y Vendor Ledger Entries, G/L Entries, BWA) y Cashflow de Craze Finance. Preparado por Dep. Administración y Contabilidad.',

  invTitle: 'Valor de inventario por Location Code', invSource: 'Business Central · movimientos de valor · a {date}',
  kpiInvValue: 'Valor inventario {date}', unitsRefs: '{qty} uds · {n} referencias',
  kpiVariation: 'Variación vs {date}', kpiAfterDep: 'Tras depreciación 2023', afterDepSub: 'Valor neto de la provisión de obsolescencia 2023',
  kpiShare: 'Peso de {loc}', mainWarehouse: 'Almacén principal',
  valueByLoc: 'Valor por location', locDetail: 'Detalle por location', location: 'Location', value: 'Valor', pctTotal: '% total', refAt: 'Ref. {date}',
  locNote: 'Valor por location = unidades en cada location × coste unitario de la referencia (como la página Inventory Value CRZ).',
  topUp: 'Top 10 productos que suben inventario', topDown: 'Top 10 productos que bajan inventario',
  code: 'Código', product: 'Producto', unitsAt: 'Uds {date}', valueAt: 'Valor {date}', deltaValue: 'Δ valor',
  remapNote: 'La referencia {a} → {b} cambió de código; se ha emparejado por descripción.',
  glNote: 'La cuenta contable {acc} está en {gl} a {date} frente a {inv} del inventario: diferencia de {diff} a conciliar.',

  purTitle: 'Compras de inventario · CHINA TRF', purSource: 'Vendor Ledger Entries · facturas con forma de pago CHINA TRF',
  kpiPurMonth: 'Compras CHINA TRF {month}', variationVs: 'Variación {v} ({p})', kpiAvg12: 'Media mensual 12 meses', kpiVendors: 'Proveedores',
  purChart: 'Facturas CHINA TRF por mes de registro', last12: '(últimos 12 meses, €)', purList: 'Facturas registradas en {month}',
  date: 'Fecha', document: 'Documento', vendor: 'Proveedor', amount: 'Importe', due: 'Vencimiento',

  uniTitle: 'Cartera de clientes sin seguro · Amazon, Aldi, Lidl', uniSource: 'Customer Ledger Entries · abierto a {date}',
  kpiUniTotal: 'Total sin seguro', uniSub: 'Amazon + Aldi + Lidl', overdueAt: 'Vencido a {date}: {v} ({p})',
  byEntity: '{name} · por sociedad', nItems: '({n} partidas)', customer: 'Cliente', pending: 'Pendiente', pctGroup: '% grupo',

  costTitle: 'Variación del coste medio · productos tipo Inventario', costSource: 'Inventario {a} vs {b} · coste unitario = valor / unidades',
  bridge: 'Puente de valor de inventario', priceEffect: 'Efecto precio', volumeMix: 'Volumen / mix',
  costTable: 'Productos con cambio de coste unitario > 0,5 %', costAt: 'Coste {date}', deltaPct: 'Δ %', effect: 'Efecto €',
  costNote: 'Coste medio por unidad: {a} → {b} ({p}). Efecto precio {pe} y volumen/mix {ve}. {n} de {m} referencias cambian de coste unitario ({up} suben, {down} bajan).',

  arTitle: 'Cartera de clientes abierta', arSource: 'Customer Ledger Entries · abierto a {date} · sin intercompany',
  kpiAr: 'Cartera clientes abierta (sin intercompany)', nOpen: '{n} partidas abiertas', kpiOverdue: 'Vencido a {date}', pctOfTotal: '{p} del total',
  byPM: 'Por forma de pago', pendingCollection: '(€ pendiente de cobro)', notDue: 'No vencido', overdueLegend: 'Vencido a {date}',
  pmDetail: 'Detalle por forma de pago', paymentMethod: 'Forma de pago', overdue: 'Vencido', noPM: '(sin forma de pago)',

  amzTitle: 'Amazon · cartera abierta', amzSource: 'Customer Ledger Entries · todas las sociedades Amazon · abierto a {date}',
  kpiAmzTotal: 'Total abierto Amazon', amzSub: '{n} partidas · {p} de la cartera', kpiNotDue: 'No vencido', notDueSub: '{p} · vence {months}',
  kpiOverdueNet: 'Vencido (neto)', overdueNetSub: 'Facturas vencidas compensadas con abonos y deducciones',
  kpiOld: 'Partidas > 90 días', oldSub: 'Facturas {a} · abonos/deducciones {b}',
  ageChart: 'Antigüedad de la cartera', ageSub: '(facturas y deducciones por tramo de vencimiento)', invoicesCharges: 'Facturas / cargos', creditsDeductions: 'Abonos / deducciones',
  age_notDue: 'No vencido', age_d1_30: '1–30 días', age_d31_60: '31–60 días', age_d61_90: '61–90 días', age_d90: '>90 días',
  byEntityAmz: 'Por sociedad Amazon', entity: 'Sociedad', open: 'Abierto', overdueNet: 'Vencido neto', byDocType: 'Por tipo de documento', type: 'Tipo',
  dt_invoice: 'Facturas', dt_refund: 'Devoluciones de pago (refund)', dt_other: 'Ajustes / sin tipo', dt_payment: 'Pagos sin aplicar', dt_creditMemo: 'Abonos',

  mkTitle: 'MARKANT', mkSource: 'Customer Ledger Entries · forma de pago MARKANT · abierto a {date}',
  kpiMk1: '1 · Total abierto MARKANT', kpiMk2: '2 · Con fecha de pago confirmada', kpiMk3: '3 · Sin fecha de pago confirmada', nPct: '{n} partidas · {p}',
  mkChart: 'Cobros confirmados por fecha', mkChartSub: '(ledger vs previsión cashflow)', confirmedLedger: 'Confirmado en ledger', forecastCashflow: 'Previsto en cashflow',
  unconfTop: 'Sin fecha confirmada · principales clientes', totalUnconf: 'Total sin fecha',

  apTitle: 'Cartera de proveedores abierta', apSource: 'Vendor Ledger Entries · abierto a {date}',
  kpiAp: 'Cartera proveedores abierta', kpiCn1: '1 · CHINA TRF total abierto', cnSub1: '{n} facturas · {p} del total',
  kpiCn2: '2 · Con fecha de pago programada', kpiCn3: '3 · Sin fecha de pago programada', nInvPct: '{n} facturas · {p}', overdueAtCol: 'Vencido {date}',
  cnDueChart: 'CHINA TRF · vencimientos por mes', cnDueSub: '(rojo = ya vencido a {date})', cnSched: 'CHINA TRF · pagos programados', schedDate: 'Fecha programada',
  totalScheduled: 'Total programado', cnByVendor: 'CHINA TRF · por proveedor',

  provTitle: 'Provisiones {year} · enero a {month}', provSource: 'G/L Entries · documentos PROV- · original, consumido y abierto',
  kpiProvOrig: 'Provisión original', nEntries: '{n} asientos', kpiConsumed: 'Consumido', consumedSub: '{p} de lo provisionado',
  kpiOpen: 'Abierto', openSub: '{p} sin consumir', kpiMonthProv: 'Dotación {month}', monthOpenSub: 'Abierto del mes: {v}',
  byProvType: 'Por tipo de provisión', typeSummary: 'Resumen por tipo', original: 'Original', pctConsumed: '% consumo', provDetail: 'Detalle por documento', description: 'Descripción',
  pt_konditions: 'Konditions', pt_marketing: 'Marketing', pt_royalties: 'Royalties', pt_incentives: 'Incentivos', pt_other: 'Otros',

  bwaTitle: 'BWA · cuenta de resultados', bwaSource: 'Business Central · BWA (glEntriesUnion + mapping de cuentas) · GBP {gbp} · CHF {chf}',
  consolidated: 'Consolidado · todas las sociedades', ytdTo: '(acumulado a {month})', periodYtd: 'Enero – {month} (acumulado)', periodMonth: '{month} (mes)',
  pctSales: '% ventas', bwaLine: 'BWA', yoyTitle: '{company} · año contra año', yoySub: '(BWA enero – {month})',
  col_interco: 'Interco.', col_consol: 'Consol.',

  cfTitle: 'Cashflow · previsión {company} EUR', cfSource: 'Cashflow de Craze Finance a {date} · límite de descubierto {limit}',
  kpiStart: 'Saldo inicial {date}', marginToLimit: 'Margen hasta el límite: {v}', kpiMin: 'Mínimo previsto', minOver: '{date} · {v} sobre el límite', minWithin: '{date} · dentro del límite',
  kpiEnd: 'Saldo final {date}', kpiBreach: 'Días con saldo bajo {limit}', noBreach: 'Sin superar el límite',
  cfChart: 'Saldo diario previsto vs límite', balanceL: 'Saldo previsto', limitL: 'Límite {limit}', cfTable: 'Entradas y salidas por bloque y mes', block: 'Bloque',
  cat_markant: 'Cobros Markant', cat_customers: 'Otros cobros clientes', cat_china: 'Pagos proveedores China', cat_paymentRuns: 'Payment runs (otros proveedores)',
  cat_customs: 'EUSt / Aduanas', cat_banks: 'Bancos (préstamos)', cat_otherOut: 'Otros pagos', netFlow: 'Flujo neto',
};

type Dict = typeof es;

const en: Dict = {
  title: 'Monthly reporting',
  closing: '{month} close · data as of {date}',
  operational: 'Operations', management: 'Management', month: 'Month',
  exportPdf: 'Export PDF', refresh: 'Refresh data', refreshing: 'Refreshing…',
  loading: 'Loading…', selectCompany: 'Select a specific company in the side menu.',
  keyPointsOp: 'Key points · Operations', keyPointsDir: 'Key points · Management',
  aiNote: 'AI-generated from the report figures', regenerate: 'Regenerate',
  aiUnavailable: 'The AI did not respond in time. Press Regenerate in a few minutes.',
  aiWaiting: 'Will be generated once the data has loaded…', aiGenerating: 'Generating key points…',
  total: 'Total', items: 'items', invoicesN: '{n} invoices',
  footer: 'Sources: Business Central (Value Entries, Customer and Vendor Ledger Entries, G/L Entries, BWA) and Craze Finance cashflow. Prepared by Accounting & Administration.',

  invTitle: 'Inventory value by location code', invSource: 'Business Central · value entries · as of {date}',
  kpiInvValue: 'Inventory value {date}', unitsRefs: '{qty} units · {n} SKUs',
  kpiVariation: 'Change vs {date}', kpiAfterDep: 'After 2023 write-down', afterDepSub: 'Net of the 2023 obsolescence provision',
  kpiShare: 'Share of {loc}', mainWarehouse: 'Main warehouse',
  valueByLoc: 'Value by location', locDetail: 'Detail by location', location: 'Location', value: 'Value', pctTotal: '% total', refAt: 'Ref. {date}',
  locNote: 'Value by location = units in each location × unit cost of the SKU (as in the Inventory Value CRZ page).',
  topUp: 'Top 10 SKUs with rising inventory', topDown: 'Top 10 SKUs with falling inventory',
  code: 'Code', product: 'Product', unitsAt: 'Units {date}', valueAt: 'Value {date}', deltaValue: 'Δ value',
  remapNote: 'SKU {a} → {b} changed code; matched by description.',
  glNote: 'G/L account {acc} stands at {gl} on {date} vs {inv} in the inventory report: a difference of {diff} to reconcile.',

  purTitle: 'Inventory purchases · CHINA TRF', purSource: 'Vendor Ledger Entries · invoices with payment method CHINA TRF',
  kpiPurMonth: 'CHINA TRF purchases {month}', variationVs: 'Change {v} ({p})', kpiAvg12: '12-month monthly average', kpiVendors: 'Vendors',
  purChart: 'CHINA TRF invoices by posting month', last12: '(last 12 months, €)', purList: 'Invoices posted in {month}',
  date: 'Date', document: 'Document', vendor: 'Vendor', amount: 'Amount', due: 'Due date',

  uniTitle: 'Uninsured receivables · Amazon, Aldi, Lidl', uniSource: 'Customer Ledger Entries · open as of {date}',
  kpiUniTotal: 'Total uninsured', uniSub: 'Amazon + Aldi + Lidl', overdueAt: 'Overdue at {date}: {v} ({p})',
  byEntity: '{name} · by entity', nItems: '({n} items)', customer: 'Customer', pending: 'Outstanding', pctGroup: '% group',

  costTitle: 'Average cost change · inventory items', costSource: 'Inventory {a} vs {b} · unit cost = value / units',
  bridge: 'Inventory value bridge', priceEffect: 'Price effect', volumeMix: 'Volume / mix',
  costTable: 'SKUs with unit cost change > 0.5%', costAt: 'Cost {date}', deltaPct: 'Δ %', effect: 'Effect €',
  costNote: 'Average cost per unit: {a} → {b} ({p}). Price effect {pe}, volume/mix {ve}. {n} of {m} SKUs change unit cost ({up} up, {down} down).',

  arTitle: 'Open customer receivables', arSource: 'Customer Ledger Entries · open as of {date} · excl. intercompany',
  kpiAr: 'Open receivables (excl. intercompany)', nOpen: '{n} open items', kpiOverdue: 'Overdue at {date}', pctOfTotal: '{p} of total',
  byPM: 'By payment method', pendingCollection: '(€ outstanding)', notDue: 'Not due', overdueLegend: 'Overdue at {date}',
  pmDetail: 'Detail by payment method', paymentMethod: 'Payment method', overdue: 'Overdue', noPM: '(no payment method)',

  amzTitle: 'Amazon · open receivables', amzSource: 'Customer Ledger Entries · all Amazon entities · open as of {date}',
  kpiAmzTotal: 'Total open Amazon', amzSub: '{n} items · {p} of receivables', kpiNotDue: 'Not due', notDueSub: '{p} · due {months}',
  kpiOverdueNet: 'Overdue (net)', overdueNetSub: 'Overdue invoices offset by credits and deductions',
  kpiOld: 'Items > 90 days', oldSub: 'Invoices {a} · credits/deductions {b}',
  ageChart: 'Receivables ageing', ageSub: '(invoices and deductions by due bucket)', invoicesCharges: 'Invoices / charges', creditsDeductions: 'Credits / deductions',
  age_notDue: 'Not due', age_d1_30: '1–30 days', age_d31_60: '31–60 days', age_d61_90: '61–90 days', age_d90: '>90 days',
  byEntityAmz: 'By Amazon entity', entity: 'Entity', open: 'Open', overdueNet: 'Net overdue', byDocType: 'By document type', type: 'Type',
  dt_invoice: 'Invoices', dt_refund: 'Payment refunds', dt_other: 'Adjustments / no type', dt_payment: 'Unapplied payments', dt_creditMemo: 'Credit memos',

  mkTitle: 'MARKANT', mkSource: 'Customer Ledger Entries · payment method MARKANT · open as of {date}',
  kpiMk1: '1 · Total open MARKANT', kpiMk2: '2 · With confirmed payment date', kpiMk3: '3 · Without confirmed payment date', nPct: '{n} items · {p}',
  mkChart: 'Confirmed collections by date', mkChartSub: '(ledger vs cashflow forecast)', confirmedLedger: 'Confirmed in ledger', forecastCashflow: 'Cashflow forecast',
  unconfTop: 'No confirmed date · main customers', totalUnconf: 'Total without date',

  apTitle: 'Open vendor payables', apSource: 'Vendor Ledger Entries · open as of {date}',
  kpiAp: 'Open payables', kpiCn1: '1 · CHINA TRF total open', cnSub1: '{n} invoices · {p} of total',
  kpiCn2: '2 · With scheduled payment date', kpiCn3: '3 · Without scheduled payment date', nInvPct: '{n} invoices · {p}', overdueAtCol: 'Overdue {date}',
  cnDueChart: 'CHINA TRF · due by month', cnDueSub: '(red = already overdue at {date})', cnSched: 'CHINA TRF · scheduled payments', schedDate: 'Scheduled date',
  totalScheduled: 'Total scheduled', cnByVendor: 'CHINA TRF · by vendor',

  provTitle: 'Provisions {year} · January to {month}', provSource: 'G/L Entries · PROV- documents · original, used and open',
  kpiProvOrig: 'Original provision', nEntries: '{n} entries', kpiConsumed: 'Used', consumedSub: '{p} of provisioned',
  kpiOpen: 'Open', openSub: '{p} unused', kpiMonthProv: 'Booked in {month}', monthOpenSub: 'Open from the month: {v}',
  byProvType: 'By provision type', typeSummary: 'Summary by type', original: 'Original', pctConsumed: '% used', provDetail: 'Detail by document', description: 'Description',
  pt_konditions: 'Conditions', pt_marketing: 'Marketing', pt_royalties: 'Royalties', pt_incentives: 'Incentives', pt_other: 'Other',

  bwaTitle: 'BWA · income statement', bwaSource: 'Business Central · BWA (glEntriesUnion + account mapping) · GBP {gbp} · CHF {chf}',
  consolidated: 'Consolidated · all entities', ytdTo: '(year to {month})', periodYtd: 'January – {month} (YTD)', periodMonth: '{month} (month)',
  pctSales: '% sales', bwaLine: 'BWA', yoyTitle: '{company} · year on year', yoySub: '(BWA January – {month})',
  col_interco: 'Interco.', col_consol: 'Consol.',

  cfTitle: 'Cashflow · {company} EUR forecast', cfSource: 'Craze Finance cashflow as of {date} · overdraft limit {limit}',
  kpiStart: 'Opening balance {date}', marginToLimit: 'Headroom to limit: {v}', kpiMin: 'Forecast low', minOver: '{date} · {v} beyond the limit', minWithin: '{date} · within the limit',
  kpiEnd: 'Closing balance {date}', kpiBreach: 'Days below {limit}', noBreach: 'Limit never breached',
  cfChart: 'Forecast daily balance vs limit', balanceL: 'Forecast balance', limitL: 'Limit {limit}', cfTable: 'Inflows and outflows by block and month', block: 'Block',
  cat_markant: 'Markant collections', cat_customers: 'Other customer receipts', cat_china: 'China vendor payments', cat_paymentRuns: 'Payment runs (other vendors)',
  cat_customs: 'Import VAT / customs', cat_banks: 'Banks (loans)', cat_otherOut: 'Other payments', netFlow: 'Net flow',
};

const de: Dict = {
  title: 'Monatsreporting',
  closing: 'Abschluss {month} · Daten zum {date}',
  operational: 'Operativ', management: 'Geschäftsführung', month: 'Monat',
  exportPdf: 'PDF exportieren', refresh: 'Daten aktualisieren', refreshing: 'Aktualisiere…',
  loading: 'Wird geladen…', selectCompany: 'Bitte im Seitenmenü eine einzelne Gesellschaft wählen.',
  keyPointsOp: 'Kernpunkte · Operativ', keyPointsDir: 'Kernpunkte · Geschäftsführung',
  aiNote: 'Mit KI aus den Zahlen des Reports erstellt', regenerate: 'Neu erstellen',
  aiUnavailable: 'Die KI hat nicht rechtzeitig geantwortet. Bitte in ein paar Minuten neu erstellen.',
  aiWaiting: 'Wird erstellt, sobald die Daten geladen sind…', aiGenerating: 'Kernpunkte werden erstellt…',
  total: 'Summe', items: 'Posten', invoicesN: '{n} Rechnungen',
  footer: 'Quellen: Business Central (Wertposten, Debitoren- und Kreditorenposten, Sachposten, BWA) und Cashflow aus Craze Finance. Erstellt von Buchhaltung & Verwaltung.',

  invTitle: 'Lagerwert nach Lagerort', invSource: 'Business Central · Wertposten · zum {date}',
  kpiInvValue: 'Lagerwert {date}', unitsRefs: '{qty} Stk. · {n} Artikel',
  kpiVariation: 'Veränderung ggü. {date}', kpiAfterDep: 'Nach Abwertung 2023', afterDepSub: 'Nach Abzug der Obsoleszenz-Abwertung 2023',
  kpiShare: 'Anteil {loc}', mainWarehouse: 'Hauptlager',
  valueByLoc: 'Wert nach Lagerort', locDetail: 'Details nach Lagerort', location: 'Lagerort', value: 'Wert', pctTotal: '% gesamt', refAt: 'Ref. {date}',
  locNote: 'Wert je Lagerort = Menge im Lagerort × Einstandspreis des Artikels (wie die Seite Inventory Value CRZ).',
  topUp: 'Top 10 Artikel mit Bestandsanstieg', topDown: 'Top 10 Artikel mit Bestandsrückgang',
  code: 'Artikel', product: 'Bezeichnung', unitsAt: 'Stk. {date}', valueAt: 'Wert {date}', deltaValue: 'Δ Wert',
  remapNote: 'Artikel {a} → {b} hat die Nummer gewechselt; per Beschreibung zugeordnet.',
  glNote: 'Sachkonto {acc} steht zum {date} bei {gl} gegenüber {inv} laut Lagerbewertung: Differenz von {diff} abzustimmen.',

  purTitle: 'Wareneinkauf · CHINA TRF', purSource: 'Kreditorenposten · Rechnungen mit Zahlungsform CHINA TRF',
  kpiPurMonth: 'Einkauf CHINA TRF {month}', variationVs: 'Veränderung {v} ({p})', kpiAvg12: 'Monatsdurchschnitt 12 Monate', kpiVendors: 'Lieferanten',
  purChart: 'CHINA-TRF-Rechnungen nach Buchungsmonat', last12: '(letzte 12 Monate, €)', purList: 'Gebuchte Rechnungen {month}',
  date: 'Datum', document: 'Beleg', vendor: 'Lieferant', amount: 'Betrag', due: 'Fälligkeit',

  uniTitle: 'Unversicherte Forderungen · Amazon, Aldi, Lidl', uniSource: 'Debitorenposten · offen zum {date}',
  kpiUniTotal: 'Summe unversichert', uniSub: 'Amazon + Aldi + Lidl', overdueAt: 'Überfällig zum {date}: {v} ({p})',
  byEntity: '{name} · nach Gesellschaft', nItems: '({n} Posten)', customer: 'Kunde', pending: 'Offen', pctGroup: '% Gruppe',

  costTitle: 'Veränderung der Durchschnittskosten · Lagerartikel', costSource: 'Lager {a} vs. {b} · Stückkosten = Wert / Menge',
  bridge: 'Lagerwert-Überleitung', priceEffect: 'Preiseffekt', volumeMix: 'Menge / Mix',
  costTable: 'Artikel mit Stückkostenänderung > 0,5 %', costAt: 'Kosten {date}', deltaPct: 'Δ %', effect: 'Effekt €',
  costNote: 'Durchschnittskosten je Stück: {a} → {b} ({p}). Preiseffekt {pe}, Menge/Mix {ve}. {n} von {m} Artikeln ändern die Stückkosten ({up} steigen, {down} sinken).',

  arTitle: 'Offene Forderungen', arSource: 'Debitorenposten · offen zum {date} · ohne Intercompany',
  kpiAr: 'Offene Forderungen (ohne Intercompany)', nOpen: '{n} offene Posten', kpiOverdue: 'Überfällig zum {date}', pctOfTotal: '{p} der Summe',
  byPM: 'Nach Zahlungsform', pendingCollection: '(€ offen)', notDue: 'Nicht fällig', overdueLegend: 'Überfällig zum {date}',
  pmDetail: 'Details nach Zahlungsform', paymentMethod: 'Zahlungsform', overdue: 'Überfällig', noPM: '(ohne Zahlungsform)',

  amzTitle: 'Amazon · offene Forderungen', amzSource: 'Debitorenposten · alle Amazon-Gesellschaften · offen zum {date}',
  kpiAmzTotal: 'Summe offen Amazon', amzSub: '{n} Posten · {p} der Forderungen', kpiNotDue: 'Nicht fällig', notDueSub: '{p} · fällig {months}',
  kpiOverdueNet: 'Überfällig (netto)', overdueNetSub: 'Überfällige Rechnungen saldiert mit Gutschriften und Abzügen',
  kpiOld: 'Posten > 90 Tage', oldSub: 'Rechnungen {a} · Gutschriften/Abzüge {b}',
  ageChart: 'Altersstruktur', ageSub: '(Rechnungen und Abzüge nach Fälligkeitsband)', invoicesCharges: 'Rechnungen / Belastungen', creditsDeductions: 'Gutschriften / Abzüge',
  age_notDue: 'Nicht fällig', age_d1_30: '1–30 Tage', age_d31_60: '31–60 Tage', age_d61_90: '61–90 Tage', age_d90: '>90 Tage',
  byEntityAmz: 'Nach Amazon-Gesellschaft', entity: 'Gesellschaft', open: 'Offen', overdueNet: 'Überfällig netto', byDocType: 'Nach Belegart', type: 'Art',
  dt_invoice: 'Rechnungen', dt_refund: 'Erstattungen', dt_other: 'Korrekturen / ohne Art', dt_payment: 'Nicht ausgeglichene Zahlungen', dt_creditMemo: 'Gutschriften',

  mkTitle: 'MARKANT', mkSource: 'Debitorenposten · Zahlungsform MARKANT · offen zum {date}',
  kpiMk1: '1 · Summe offen MARKANT', kpiMk2: '2 · Mit bestätigtem Zahlungsdatum', kpiMk3: '3 · Ohne bestätigtes Zahlungsdatum', nPct: '{n} Posten · {p}',
  mkChart: 'Bestätigte Zahlungseingänge nach Datum', mkChartSub: '(Posten vs. Cashflow-Planung)', confirmedLedger: 'Bestätigt in Posten', forecastCashflow: 'Geplant im Cashflow',
  unconfTop: 'Ohne bestätigtes Datum · wichtigste Kunden', totalUnconf: 'Summe ohne Datum',

  apTitle: 'Offene Verbindlichkeiten', apSource: 'Kreditorenposten · offen zum {date}',
  kpiAp: 'Offene Verbindlichkeiten', kpiCn1: '1 · CHINA TRF offen gesamt', cnSub1: '{n} Rechnungen · {p} der Summe',
  kpiCn2: '2 · Mit geplantem Zahlungsdatum', kpiCn3: '3 · Ohne geplantes Zahlungsdatum', nInvPct: '{n} Rechnungen · {p}', overdueAtCol: 'Überfällig {date}',
  cnDueChart: 'CHINA TRF · Fälligkeiten nach Monat', cnDueSub: '(rot = zum {date} bereits überfällig)', cnSched: 'CHINA TRF · geplante Zahlungen', schedDate: 'Geplantes Datum',
  totalScheduled: 'Summe geplant', cnByVendor: 'CHINA TRF · nach Lieferant',

  provTitle: 'Rückstellungen {year} · Januar bis {month}', provSource: 'Sachposten · Belege PROV- · gebildet, verbraucht und offen',
  kpiProvOrig: 'Gebildete Rückstellung', nEntries: '{n} Buchungen', kpiConsumed: 'Verbraucht', consumedSub: '{p} der Rückstellung',
  kpiOpen: 'Offen', openSub: '{p} nicht verbraucht', kpiMonthProv: 'Zuführung {month}', monthOpenSub: 'Davon offen: {v}',
  byProvType: 'Nach Art der Rückstellung', typeSummary: 'Übersicht nach Art', original: 'Gebildet', pctConsumed: '% Verbrauch', provDetail: 'Details nach Beleg', description: 'Beschreibung',
  pt_konditions: 'Konditionen', pt_marketing: 'Marketing', pt_royalties: 'Lizenzen', pt_incentives: 'Incentives', pt_other: 'Sonstige',

  bwaTitle: 'BWA · Gewinn- und Verlustrechnung', bwaSource: 'Business Central · BWA (glEntriesUnion + Kontenzuordnung) · GBP {gbp} · CHF {chf}',
  consolidated: 'Konsolidiert · alle Gesellschaften', ytdTo: '(kumuliert bis {month})', periodYtd: 'Januar – {month} (kumuliert)', periodMonth: '{month} (Monat)',
  pctSales: '% Umsatz', bwaLine: 'BWA', yoyTitle: '{company} · Vorjahresvergleich', yoySub: '(BWA Januar – {month})',
  col_interco: 'Interco.', col_consol: 'Konsol.',

  cfTitle: 'Cashflow · Planung {company} EUR', cfSource: 'Cashflow aus Craze Finance zum {date} · Kontokorrentlimit {limit}',
  kpiStart: 'Anfangssaldo {date}', marginToLimit: 'Spielraum bis Limit: {v}', kpiMin: 'Geplanter Tiefstand', minOver: '{date} · {v} über dem Limit', minWithin: '{date} · innerhalb des Limits',
  kpiEnd: 'Endsaldo {date}', kpiBreach: 'Tage unter {limit}', noBreach: 'Limit nie überschritten',
  cfChart: 'Geplanter Tagessaldo vs. Limit', balanceL: 'Geplanter Saldo', limitL: 'Limit {limit}', cfTable: 'Zu- und Abflüsse nach Block und Monat', block: 'Block',
  cat_markant: 'Eingänge Markant', cat_customers: 'Sonstige Kundeneingänge', cat_china: 'Zahlungen China-Lieferanten', cat_paymentRuns: 'Zahlläufe (sonstige Lieferanten)',
  cat_customs: 'EUSt / Zoll', cat_banks: 'Banken (Darlehen)', cat_otherOut: 'Sonstige Zahlungen', netFlow: 'Netto-Cashflow',
};

const DICTS: Record<Lang, Dict> = { es, en, de };
export type TKey = keyof Dict;

const LOCALE: Record<Lang, string> = { es: 'es-ES', en: 'en-GB', de: 'de-DE' };

export function makeT(lang: Lang) {
  const dict = DICTS[lang];
  const t = (key: TKey, vars?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ''));
  const locale = LOCALE[lang];
  const nf = (digits: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

  // Importe completo: 11.986.213 € / €11,986,213
  const eur = (v: number | null | undefined, digits = 0) =>
    v === null || v === undefined || isNaN(v) ? '–' : new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);

  // Importe abreviado: 14,23 M€ / €14.23M / 14,23 Mio. € ; 616 k€ / €616k / 616 T€
  const short = (v: number | null | undefined) => {
    if (v === null || v === undefined || isNaN(v)) return '–';
    const a = Math.abs(v);
    const [n, unit] = a >= 1e6 ? [v / 1e6, 'M'] : a >= 1e3 ? [v / 1e3, 'k'] : [v, ''];
    const num = nf(unit === 'M' ? 2 : 0).format(n);
    if (lang === 'en') return `${num.startsWith('-') ? '-' : ''}€${num.replace('-', '')}${unit}`;
    if (lang === 'de') return unit === 'M' ? `${num} Mio. €` : unit === 'k' ? `${num} T€` : `${num} €`;
    return unit ? `${num} ${unit}€` : `${num} €`;
  };
  const num = (v: number, digits = 0) => nf(digits).format(v || 0);
  const pct = (v: number, digits = 1) => `${nf(digits).format(v || 0)} %`.replace(' %', lang === 'en' ? '%' : ' %');
  const date = (iso: string | null | undefined) => {
    if (!iso) return '–';
    const [y, m, d] = iso.substring(0, 10).split('-');
    return lang === 'en' ? `${d}/${m}/${y}` : `${d}.${m}.${y}`;
  };
  const shortDate = (iso: string) => { const [, m, d] = iso.substring(0, 10).split('-'); return lang === 'en' ? `${d}/${m}` : `${d}.${m}`; };
  const monthName = (ym: string, style: 'long' | 'short' = 'long') => {
    const [y, m] = ym.split('-').map(Number);
    const s = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, { month: style, year: style === 'long' ? 'numeric' : '2-digit', timeZone: 'UTC' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  // Solo el mes ("septiembre" / "September" / "September"), en minúscula en castellano
  const monthOnly = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    const s = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' });
    return lang === 'es' ? s.toLowerCase() : s.charAt(0).toUpperCase() + s.slice(1);
  };
  const monthText = (ym: string) => (lang === 'es' ? monthName(ym).toLowerCase() : monthName(ym));
  return { t, eur, short, num, pct, date, shortDate, monthName, monthOnly, monthText, locale, lang };
}

export type Fmt = ReturnType<typeof makeT>;
