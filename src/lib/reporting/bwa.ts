import { bcFetchAll, bcFetchByEntryRanges, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from './cache';
import { cutoffDate, today } from './period';

// BWA (cuenta de resultados), igual que el Power BI "BWA", desde la API custom de BC:
// glEntriesUnion (movimientos contables de todas las sociedades, con marca de eliminación intercompany)
// + mappingAccounts (cuenta -> línea BWA, solo cuentas de resultados) + bwas (líneas; las de tipo
// Formula suman otras líneas, "1020|1040"). UK (GBP) y Group AG (CHF) se pasan a EUR con el tipo
// actual de Currencies_Excel. Importes con el signo invertido (ingresos en positivo).
//  - Columna de una sociedad: todos sus movimientos (también los de eliminación).
//  - Intercompany: solo los movimientos de eliminación. Consolidado: todo menos eliminación.

export const INTERCO = 'CRAZE Intercompany';
export const CONSOL = 'CRAZE Consolidated';

type Line = { code: string; description: string; formula: string[] | null; bold: boolean };
type Values = { month: number; ytd: number; prevYtd: number; prevMonth: number };

export async function bwaReport(ctx: BcContext, month: string, force = false) {
  const date = cutoffDate(month);
  return cached(`bwa:${date}`, date < today() ? 12 * HOUR : 2 * HOUR, async () => {
    const year = Number(date.substring(0, 4));
    const prevYearDate = `${year - 1}${date.substring(4)}`;
    const [bwas, mapping, currencies, entries] = await Promise.all([
      bcFetchAll(`${ctx.customApiBase}/bwas`, ctx.token),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/mappingAccounts`, { $select: 'gLAccountNo,incomeBalance,bwa' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Currencies_Excel`, { $select: 'Code,ExchangeRateAmt,ExchangeRateDate' }), ctx.token),
      bcFetchByEntryRanges(
        `${ctx.customApiBase}/glEntriesUnion`, ctx.token, 'entryNo',
        'company,gLAccountNo2,postingDate,amount,amountLCY,elimination',
        `postingDate ge ${year - 1}-01-01 and postingDate le ${date} and gLAccountNo2 ne ''`
      ),
    ]);

    const accountBwa = new Map<string, string>(
      mapping.filter((m: any) => m.incomeBalance === 'Income_x0020_Statement' && m.bwa).map((m: any) => [m.gLAccountNo, m.bwa])
    );
    const rate = (code: string) => currencies.find((c: any) => c.Code === code && c.ExchangeRateAmt)?.ExchangeRateAmt || 1;
    const rates = { GBP: rate('GBP'), CHF: rate('CHF') };

    const lines: Line[] = bwas.map((b: any) => ({
      code: b.code,
      description: b.description,
      formula: b.type2 === 'Formula' ? String(b.formula).split('|').filter(Boolean) : null,
      bold: b.type2 === 'Formula' || b.code === '1020',
    }));

    // Acumulado por columna, línea y periodo
    const monthKey = date.substring(0, 7);
    const prevMonthKey = prevYearDate.substring(0, 7);
    const acc = new Map<string, Values>();
    const add = (col: string, code: string, field: keyof Values, v: number) => {
      const k = `${col}|${code}`;
      const cur = acc.get(k) || { month: 0, ytd: 0, prevYtd: 0, prevMonth: 0 };
      cur[field] += v;
      acc.set(k, cur);
    };
    const companies = new Set<string>();
    for (const e of entries) {
      const code = accountBwa.get(e.gLAccountNo2);
      if (!code) continue;
      const fx = e.company.includes('UK') ? rates.GBP : e.company.includes('AG') ? rates.CHF : null;
      const eur = -(fx ? Math.round(e.amount * fx * 100) / 100 : e.amountLCY);
      const d: string = e.postingDate;
      const fields: (keyof Values)[] = [];
      if (d.startsWith(String(year)) && d <= date) fields.push('ytd');
      if (d.startsWith(monthKey)) fields.push('month');
      if (d.startsWith(String(year - 1)) && d <= prevYearDate) fields.push('prevYtd');
      if (d.startsWith(prevMonthKey)) fields.push('prevMonth');
      if (fields.length === 0) continue;
      companies.add(e.company);
      const cols = [e.company, e.elimination ? INTERCO : CONSOL];
      for (const col of cols) for (const f of fields) add(col, code, f, eur);
    }

    const columns = [
      ...Array.from(companies).sort((a, b) => (a === 'CRAZE' ? -1 : b === 'CRAZE' ? 1 : a.localeCompare(b))),
      INTERCO, CONSOL,
    ];
    const value = (col: string, line: Line): Values => {
      const codes = line.formula || [line.code];
      return codes.reduce((s, c) => {
        const v = acc.get(`${col}|${c}`);
        return v ? { month: s.month + v.month, ytd: s.ytd + v.ytd, prevYtd: s.prevYtd + v.prevYtd, prevMonth: s.prevMonth + v.prevMonth } : s;
      }, { month: 0, ytd: 0, prevYtd: 0, prevMonth: 0 });
    };

    return {
      date, prevYearDate, rates,
      columns,
      lines: lines.map(l => ({
        code: l.code, description: l.description, bold: l.bold,
        values: Object.fromEntries(columns.map(c => [c, value(c, l)])),
      })),
    };
  }, force);
}
