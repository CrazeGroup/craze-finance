import { bcFetchAll, bcFetchByEntryRanges, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';

// Controlling · BWA (Power BI): recreación del Power BI "BWA" (páginas Annual, Monthly, Annual - Detail y Exchg_Cur)
// con sus mismas consultas de BC (API custom craze/integrations, empresa CRAZE):
// - glEntriesUnion: movimientos contables de todas las sociedades (gLAccountNo2 = cuenta de mapeo, marca elimination).
// - mappingAccounts: cuenta → línea BWA (bwa), nivel (level) y descripción del nivel; solo Income Statement.
// - bwas: líneas BWA; las de tipo Formula suman otras líneas ("1020|1040"). Descripción en mayúsculas en las
//   Formula y en la 1020 (como el Power Query).
// - Currencies_Excel (OData): GBP (UK) y CHF (Group AG) a EUR con el tipo actual, redondeado a 2 decimales.
// Importes con el signo invertido (−SUM(amountEUR), ingresos en positivo). Aquí se agregan por sociedad × eliminación
// × cuenta × mes; la página calcula las columnas (sociedad = todos sus movimientos, Intercompany = eliminación,
// Consolidated = todo menos eliminación).

export type BwaLine = { code: string; description: string; formula: string[] | null; highlight: 'high' | 'med' | null };
export type BwaAccount = { account: string; bwa: string; level: string; description: string };

// Filas resaltadas del Power BI (columna calculada bwas[highlightRow])
const HIGH = ['SALES REVENUES', 'GROSS MARGIN', 'EBITDA', 'EBIT', 'NET INCOME'];

export async function bwaPbiData(ctx: BcContext, year: number, force = false) {
  const closed = year < new Date().getFullYear();
  return cached(`bwa-pbi:${year}`, closed ? 12 * HOUR : 1 * HOUR, async () => {
    const [bwas, mapping, currencies, entries] = await Promise.all([
      bcFetchAll(`${ctx.customApiBase}/bwas`, ctx.token),
      bcFetchAll(odataUrl(`${ctx.customApiBase}/mappingAccounts`, { $select: 'gLAccountNo,description,incomeBalance,bwa,level' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Currencies_Excel`, { $select: 'Code,Description,ExchangeRateAmt,ExchangeRateDate' }), ctx.token),
      bcFetchByEntryRanges(
        `${ctx.customApiBase}/glEntriesUnion`, ctx.token, 'entryNo',
        'company,gLAccountNo2,postingDate,amount,amountLCY,elimination',
        `postingDate ge ${year - 1}-01-01 and postingDate le ${year}-12-31 and gLAccountNo2 ne ''`
      ),
    ]);

    const accounts: BwaAccount[] = mapping
      .filter((m: any) => m.incomeBalance === 'Income_x0020_Statement' && m.bwa)
      .map((m: any) => ({ account: String(m.gLAccountNo), bwa: String(m.bwa), level: String(m.level || ''), description: String(m.description || '') }))
      .sort((a: BwaAccount, b: BwaAccount) => `${a.bwa}.${a.level}`.localeCompare(`${b.bwa}.${b.level}`));
    const byAccount = new Map(accounts.map(a => [a.account, a]));

    const fx = currencies.filter((c: any) => (c.Code === 'GBP' || c.Code === 'CHF') && c.ExchangeRateAmt)
      .map((c: any) => ({ code: String(c.Code), description: String(c.Description || ''), rate: Number(c.ExchangeRateAmt), date: String(c.ExchangeRateDate || '').substring(0, 10) }));
    const rate = (code: string) => fx.find(c => c.code === code)?.rate ?? null;
    const rates = { GBP: rate('GBP'), CHF: rate('CHF') };

    const lines: BwaLine[] = bwas.map((b: any) => {
      const formula = b.type2 === 'Formula' ? String(b.formula || '').split('|').filter(Boolean) : null;
      const description = formula || b.code === '1020' ? String(b.description).toUpperCase() : String(b.description);
      return { code: String(b.code), description, formula, highlight: HIGH.includes(description) ? 'high' : formula ? 'med' : null };
    });

    // Agregado: "sociedad|eliminación|cuenta|YYYY-MM" → importe EUR con signo invertido
    const cells: Record<string, number> = {};
    const companies = new Set<string>();
    for (const e of entries) {
      const acc = byAccount.get(String(e.gLAccountNo2));
      if (!acc) continue;
      const company = String(e.company);
      const r = company.includes('UK') ? rates.GBP : company.includes('AG') ? rates.CHF : null;
      const eur = r ? Math.round(Number(e.amount) * r * 100) / 100 : Number(e.amountLCY);
      const k = `${company}|${e.elimination ? 1 : 0}|${acc.account}|${String(e.postingDate).substring(0, 7)}`;
      cells[k] = (cells[k] || 0) - eur;
      companies.add(company);
    }
    return {
      year, rates, currencies: fx, lines, accounts,
      companies: Array.from(companies).sort((a, b) => (a === 'CRAZE' ? -1 : b === 'CRAZE' ? 1 : a.localeCompare(b))),
      cells: Object.entries(cells).map(([k, v]) => { const [c, el, a, m] = k.split('|'); return [c, Number(el), a, m, Math.round(v * 100) / 100] as const; }),
    };
  }, force);
}
