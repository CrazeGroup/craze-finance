import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from './cache';
import { cutoffDate, today } from './period';

// Provisiones, igual que el Power BI "Provisions": asientos contables (tabla 17, servicio
// General_Ledger_Entries_Excel) con nº de documento PROV-*, en cuentas marcadas como provisión.
// Por documento: original = importe del primer movimiento; abierto = suma de todos sus movimientos
// hasta la fecha de cierre; consumido = original - abierto. Se listan los documentos con importe abierto.

type ProvType = 'konditions' | 'marketing' | 'royalties' | 'incentives' | 'other';

function provisionType(account: string, description: string): ProvType {
  const a = account.toUpperCase();
  const d = description.toUpperCase();
  if (a.includes('KONDITION') || a.startsWith('4769') || d.includes('KONDITION') || d.includes('CONDITION')) return 'konditions';
  if (a.includes('ROYALT') || a.startsWith('6837') || d.includes('ROYALT')) return 'royalties';
  if (a.startsWith('6020') || d.includes('KAM') || d.includes('INCENTIV')) return 'incentives';
  if (a.includes('MARKETING') || a.startsWith('6600') || d.includes('MARKETING') || d.includes('PROMOTION')) return 'marketing';
  return 'other';
}

export async function provisionsReport(ctx: BcContext, company: string, month: string, force = false) {
  const date = cutoffDate(month);
  const year = date.substring(0, 4);
  return cached(`prov:${company}:${date}`, date < today() ? 12 * HOUR : 1 * HOUR, async () => {
    const [accounts, entries] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.customApiBase}/glAccounts`, { $filter: 'provision eq true', $select: 'no,name' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: `startswith(Document_No,'PROV') and Posting_Date le ${date}`,
        $select: 'Entry_No,Posting_Date,Document_No,G_L_Account_No,Description,Amount',
      }), ctx.token),
    ]);
    const provisionAccounts = new Set(accounts.map((a: any) => a.no));

    const docs = new Map<string, any[]>();
    for (const e of entries) {
      if (!provisionAccounts.has(e.G_L_Account_No)) continue;
      const list = docs.get(e.Document_No) || [];
      list.push(e);
      docs.set(e.Document_No, list);
    }

    const rows = Array.from(docs.entries()).map(([doc, list]) => {
      list.sort((a, b) => a.Entry_No - b.Entry_No);
      const first = list[0];
      const open = Math.round(list.reduce((s, e) => s + e.Amount, 0) * 100) / 100;
      return {
        doc, date: first.Posting_Date, desc: first.Description, account: first.G_L_Account_No,
        t: provisionType(first.G_L_Account_No, first.Description),
        orig: first.Amount, cons: first.Amount - open, open,
      };
    })
      // Año del informe y con importe abierto (mismo filtro que la tabla del Power BI)
      .filter(r => r.date.startsWith(year) && r.open !== 0)
      .sort((a, b) => a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));

    const sumBy = (list: typeof rows) => ({
      orig: list.reduce((s, r) => s + r.orig, 0),
      cons: list.reduce((s, r) => s + r.cons, 0),
      open: list.reduce((s, r) => s + r.open, 0),
    });
    const types: ProvType[] = ['konditions', 'marketing', 'royalties', 'incentives', 'other'];
    const thisMonth = rows.filter(r => r.date.startsWith(date.substring(0, 7)));

    return {
      date, year,
      ...sumBy(rows), n: rows.length,
      byType: types.map(t => ({ t, ...sumBy(rows.filter(r => r.t === t)) })).filter(t => t.orig || t.open),
      byMonth: Array.from(new Set(rows.map(r => r.date.substring(0, 7)))).sort().map(m => ({ month: m, ...sumBy(rows.filter(r => r.date.startsWith(m))) })),
      month: sumBy(thisMonth),
      rows,
    };
  }, force);
}
