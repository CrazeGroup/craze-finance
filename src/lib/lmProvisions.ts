import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';
import { companyCurrency, findService, isTrue, num, str } from '@/lib/royalties';

// Provisiones de condiciones y de marketing por Customer Group, de la LM de BC (página 60000
// "AIT Documents LM Components", el mismo servicio que Royalties) entre dos fechas de registro.
// Se descartan las líneas Main Item (sus componentes ya llevan los importes), como en Royalties.
// Amazon Promotion = Provision Marketing de las líneas de clientes Amazon (grupo 023 en CRAZE); se separa del
// Marketing del resto, como en G/L (3072 01 Marketing excl. Amazon / 3072 02 Amazon Promotions).
const isAmazon = (customer: string) => /amazon/i.test(customer);
const FIELDS = {
  date: ['Posting_Date', 'postingDate'],
  main: ['Main_Item_CRZ', 'Main_Item', 'mainItem'],
  group: ['Customer_Group_Code', 'customerGroupCode', 'Customer_Group'],
  conditions: ['Provision_Conditions', 'provisionConditions'],
  marketing: ['Provision_Marketing', 'provisionMarketing'],
  turnover: ['Turnover_Sales_Provision', 'Net_Turnover', 'turnoverSalesProvision'],
  customer: ['Bill_to_Customer_Name', 'Sell_to_Customer_Name'],
  bonus: ['Provision_Bonus'],
  partner: ['Provision_Accounting_Partner'],
  skonto: ['Provision_Skonto'],
} as const;
type Key = keyof typeof FIELDS;

const r2 = (v: number) => Math.round(v * 100) / 100;

export async function lmProvisionsByGroup(ctx: BcContext, company: string, from: string, to: string, force = false) {
  return cached(`lmprov3:${company}:${from}:${to}`, to < today() ? 6 * HOUR : 1 * HOUR, async () => {
    const service = await findService(ctx);
    const sample = await bcFetchAll(odataUrl(service.url, { $top: '1' }), ctx.token);
    const keys = Object.keys(sample[0] || {});
    const F = Object.fromEntries((Object.keys(FIELDS) as Key[]).map(k => [k, keys.find(key => (FIELDS[k] as readonly string[]).some(c => c.toLowerCase() === key.toLowerCase())) || null])) as Record<Key, string | null>;
    const missing = (['date', 'group', 'conditions', 'marketing'] as Key[]).filter(k => !F[k]);
    if (sample.length && missing.length) {
      throw new Error(`El servicio "${service.name}" no tiene los campos ${missing.join(', ')}. Campos: ${keys.join(', ')}`);
    }
    const select = Object.values(F).filter(Boolean).join(',');
    const raw = sample.length
      ? await bcFetchAll(odataUrl(service.url, { $filter: `${F.date} ge ${from} and ${F.date} le ${to}`, $select: select }), ctx.token)
      : [];

    type G = { group: string; turnover: number; conditions: number; marketing: number; amazon: number; bonus: number; partner: number; skonto: number; lines: number; customers: Map<string, number> };
    const groups = new Map<string, G>();
    const mainSkipped = { lines: 0, conditions: 0, marketing: 0 };
    for (const r of raw) {
      const conditions = num(r[F.conditions!]), marketing = num(r[F.marketing!]);
      if (F.main && isTrue(r[F.main])) {
        mainSkipped.lines++; mainSkipped.conditions += conditions; mainSkipped.marketing += marketing;
        continue;
      }
      const group = str(r[F.group!]) || '(sin grupo)';
      const g = groups.get(group) || { group, turnover: 0, conditions: 0, marketing: 0, amazon: 0, bonus: 0, partner: 0, skonto: 0, lines: 0, customers: new Map() };
      const turnover = F.turnover ? num(r[F.turnover]) : 0;
      g.turnover += turnover;
      for (const k of ['bonus', 'partner', 'skonto'] as const) if (F[k]) g[k] += num(r[F[k]!]);
      const cust = F.customer ? str(r[F.customer]) : '';
      if (cust) g.customers.set(cust, (g.customers.get(cust) || 0) + Math.abs(turnover) + 0.001);
      g.conditions += conditions;
      const cust0 = F.customer ? str(r[F.customer]) : '';
      if (isAmazon(cust0)) g.amazon += marketing; else g.marketing += marketing;
      g.lines++;
      groups.set(group, g);
    }
    const rows = Array.from(groups.values())
      .map(({ customers, ...g }) => ({
        ...g, bonus: r2(g.bonus), partner: r2(g.partner), skonto: r2(g.skonto),
        // Cliente principal del grupo (mayor facturación) y nº de clientes, para reconocer el grupo
        customer: Array.from(customers.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '', customerCount: customers.size,
        turnover: r2(g.turnover), conditions: r2(g.conditions), marketing: r2(g.marketing), amazon: r2(g.amazon), total: r2(g.conditions + g.marketing + g.amazon) }))
      .filter(g => g.conditions || g.marketing || g.amazon || g.turnover)
      .sort((a, b) => b.total - a.total || a.group.localeCompare(b.group));
    const sum = (k: 'turnover' | 'conditions' | 'marketing' | 'amazon' | 'total') => r2(rows.reduce((s, r) => s + r[k], 0));
    return {
      company, from, to, currency: companyCurrency(company), service: service.name, fields: F,
      rows, total: { turnover: sum('turnover'), conditions: sum('conditions'), marketing: sum('marketing'), amazon: sum('amazon'), total: sum('total') },
      mainSkipped: { ...mainSkipped, conditions: r2(mainSkipped.conditions), marketing: r2(mainSkipped.marketing) },
    };
  }, force);
}
