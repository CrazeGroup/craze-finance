import { bcFetchAll, BcContext, getBcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';

// BWA Analytics en directo de BC para una empresa y un año (antes: 8 Excel subidos a mano):
// - Líneas BWA (API custom "bwas"; las de tipo Formula suman otras líneas) y cuenta → línea ("mappingAccounts",
//   solo cuentas de resultados), como el Reporting.
// - Importes por mes: movimientos contables del año (servicio General_Ledger_Entries_Excel) de esas cuentas,
//   con el signo invertido (ingresos en positivo), en la divisa local de la empresa.
// - Grupos: cada línea Formula es un grupo con sus líneas componentes y una fila "Total".
// - Desglose de cada línea (solo la primera vez que aparece): por cuenta contable y origen (proveedor/cliente, con
//   su nombre de BC); como máximo DETAIL_LIMIT filas por línea más una fila "Resto".

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
type Months = Record<string, number>;
type Detail = { Item: string; Description: string; Vendor: string; Values: Months; Total: number };
export type BwaRow = { BwaGroup: string; Level: string; Code: string; Values: Months; Total: number; IsPurchase: boolean; Detail: Detail[] };

const accountKey = (no: string) => String(no || '').replace(/\s+/g, '').toUpperCase();
const emptyMonths = (): Months => Object.fromEntries(MONTHS.map(m => [m, 0]));
const r2 = (v: number) => Math.round(v * 100) / 100;
const DETAIL_LIMIT = 100;

async function bwaDefinition(ctx: BcContext) {
  const [bwas, mapping] = await Promise.all([
    bcFetchAll(`${ctx.customApiBase}/bwas`, ctx.token),
    bcFetchAll(odataUrl(`${ctx.customApiBase}/mappingAccounts`, { $select: 'gLAccountNo,incomeBalance,bwa' }), ctx.token),
  ]);
  return { bwas, mapping };
}

export async function bwaAnalytics(ctx: BcContext, company: string, year: number, force = false) {
  const to = `${year}-12-31`;
  return cached(`bwaA:${company}:${year}`, to < today() ? 12 * HOUR : 2 * HOUR, async () => {
    // Definición de la BWA: la de la empresa o, si no tiene, la de CRAZE
    let def = await bwaDefinition(ctx);
    if (!def.bwas.length || !def.mapping.length) def = await bwaDefinition(await getBcContext('CRAZE'));

    const base = `${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`;
    const sample = await bcFetchAll(odataUrl(base, { $top: '1' }), ctx.token);
    const keys = Object.keys(sample[0] || {});
    const extra = ['Source_No', 'Source_Name', 'Source_Type'].filter(k => keys.includes(k));
    const [entries, accounts, vendors, customers] = await Promise.all([
      bcFetchAll(odataUrl(base, {
        $filter: `Posting_Date ge ${year}-01-01 and Posting_Date le ${to}`,
        $select: ['Posting_Date', 'G_L_Account_No', 'Description', 'Amount', ...extra].join(','),
      }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/glAccounts`, { $select: 'no,name' }), ctx.token).catch(() => [] as any[]),
      bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, { $select: 'number,displayName' }), ctx.token).catch(() => [] as any[]),
      bcFetchAll(odataUrl(`${ctx.apiBase}/customers`, { $select: 'number,displayName' }), ctx.token).catch(() => [] as any[]),
    ]);
    const vendorName = new Map(vendors.map((v: any) => [v.number, v.displayName]));
    const customerName = new Map(customers.map((c: any) => [c.number, c.displayName]));
    const sourceName = (e: any) => {
      const no = String(e.Source_No || '').trim();
      if (!no) return '';
      const t = String(e.Source_Type || '');
      const name = /vendor/i.test(t) ? vendorName.get(no) : /customer/i.test(t) ? customerName.get(no) : (vendorName.get(no) || customerName.get(no));
      return name ? `${name} (${no})` : no;
    };
    const accountName = new Map(accounts.map((a: any) => [accountKey(a.no), a.name]));
    const accountBwa = new Map<string, string>(def.mapping
      .filter((m: any) => m.incomeBalance === 'Income_x0020_Statement' && m.bwa)
      .map((m: any) => [accountKey(m.gLAccountNo), String(m.bwa)]));

    // Importes por línea BWA y mes, y desglose
    const byCode = new Map<string, Months>();
    const details = new Map<string, Map<string, Detail>>();
    for (const e of entries) {
      const code = accountBwa.get(accountKey(e.G_L_Account_No));
      if (!code) continue;
      const m = MONTHS[Number(String(e.Posting_Date).substring(5, 7)) - 1];
      if (!m) continue;
      const v = -(e.Amount || 0);
      const months = byCode.get(code) || emptyMonths();
      months[m] += v;
      byCode.set(code, months);
      const vendor = sourceName(e);
      const dk = `${e.G_L_Account_No}|${vendor}`;
      const dmap = details.get(code) || new Map<string, Detail>();
      const d = dmap.get(dk) || {
        Item: String(e.G_L_Account_No), Description: accountName.get(accountKey(e.G_L_Account_No)) || String(e.Description || '').trim(),
        Vendor: vendor || '(sin proveedor/cliente)', Values: emptyMonths(), Total: 0,
      };
      d.Values[m] += v;
      d.Total += v;
      dmap.set(dk, d);
      details.set(code, dmap);
    }

    type Line = { code: string; description: string; formula: string[] | null };
    const lines: Line[] = def.bwas.map((b: any) => ({
      code: String(b.code), description: String(b.description || b.code),
      formula: b.type2 === 'Formula' ? String(b.formula).split('|').filter(Boolean) : null,
    }));
    const lineByCode = new Map(lines.map(l => [l.code, l]));
    const values = (l: Line, seen = new Set<string>()): Months => {
      if (!l.formula) return byCode.get(l.code) || emptyMonths();
      const out = emptyMonths();
      for (const c of l.formula) {
        const sub = lineByCode.get(c);
        if (!sub || seen.has(c)) continue;
        const v = values(sub, new Set([...seen, l.code]));
        MONTHS.forEach(m => { out[m] += v[m]; });
      }
      return out;
    };
    const detailed = new Set<string>();
    const row = (group: string, l: Line, level: string): BwaRow => {
      const v = values(l);
      const rounded = Object.fromEntries(MONTHS.map(m => [m, r2(v[m])]));
      let det: Detail[] = [];
      if (!l.formula && !detailed.has(l.code)) {
        detailed.add(l.code);
        const all = Array.from(details.get(l.code)?.values() || [])
          .filter(d => Math.abs(d.Total) >= 0.005 || MONTHS.some(m => Math.abs(d.Values[m]) >= 0.005))
          .sort((a, b) => Math.abs(b.Total) - Math.abs(a.Total));
        det = all.slice(0, DETAIL_LIMIT);
        const rest = all.slice(DETAIL_LIMIT);
        if (rest.length) {
          const r: Detail = { Item: '', Description: `Resto (${rest.length} combinaciones)`, Vendor: '', Values: emptyMonths(), Total: 0 };
          rest.forEach(d => { MONTHS.forEach(m => { r.Values[m] += d.Values[m]; }); r.Total += d.Total; });
          det.push(r);
        }
        det = det.map(d => ({ ...d, Values: Object.fromEntries(MONTHS.map(m => [m, r2(d.Values[m])])), Total: r2(d.Total) }));
      }
      return { BwaGroup: group, Level: level, Code: l.code, Values: rounded, Total: r2(MONTHS.reduce((s, m) => s + v[m], 0)), IsPurchase: det.length > 0, Detail: det };
    };

    // Un grupo por línea Formula: sus componentes + Total; las líneas sueltas, en "Otras líneas"
    const out: BwaRow[] = [];
    const used = new Set<string>();
    for (const f of lines.filter(l => l.formula)) {
      const group = `${f.code} ${f.description}`;
      for (const c of f.formula!) {
        const sub = lineByCode.get(c);
        if (!sub) continue;
        out.push(row(group, sub, sub.description));
        used.add(c);
      }
      out.push(row(group, f, 'Total'));
      used.add(f.code);
    }
    for (const l of lines.filter(l => !used.has(l.code))) out.push(row('Otras líneas', l, l.description));

    const total = (code: string) => out.find(r => r.Code === code && (r.Level === 'Total' || !lineByCode.get(code)?.formula))?.Total ?? null;
    const kpis = ['1020', '1080', '1300', '1380']
      .map(code => ({ code, description: lineByCode.get(code)?.description || code, total: total(code) }))
      .filter(k => k.total !== null);
    return { year, company, rows: out, kpis, sourceFields: extra };
  }, force);
}
