import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from './cache';
import { cutoffDate, today } from './period';

// Provisiones del reporting: asientos contables PROV* (tabla 17, servicio General_Ledger_Entries_Excel).
// Cada mes se registra un documento nuevo que re-estima la provisión ("RST Konditionen 2026", "RST Lizenzen 2026"…)
// contra una cuenta de balance de provisión (3071 13 Konditionen, 3071 12 Lizenzen, 3071 08 KAM, 3072 01 Marketing,
// 3072 02 Amazon Promotions…). Por eso lo abierto no es el saldo de cada documento sino el de esa cuenta:
// - Serie de un documento = cuenta de provisiones (30xx) de su primer movimiento en una de ellas; los documentos PROV sin
//   cuenta 30xx (PROV1, PROV3: refacturación de royalties) no son dotaciones y no salen aquí (cuentan como consumo en Controlling).
// - Abierto de la serie = saldo de todos los movimientos PROV* del año en esa cuenta hasta la fecha de corte,
//   asignado al último documento de la serie; los anteriores quedan consumidos (abierto 0).
// - Original de cada documento = su primer movimiento en la cuenta de la serie. En la tabla, la fila de cada serie
//   (su último documento) lleva como original la dotación del año (suma de los originales de la serie) y
//   consumido = dotación − abierto.
// Importes con el signo de gasto (provisión dotada en positivo). P. ej. PROV-00049 (CRAZE, 30/09/2026):
// abierto 472.987,87 = saldo de la 3071 13 de toda la serie RST Konditionen.

type ProvType = 'konditions' | 'marketing' | 'amazon' | 'royalties' | 'incentives' | 'other';

// Todos los documentos que empiezan por PROV: PROV-00049… y también PROV1, PROV3… (refacturación de royalties)
export const PROVISION_DOC_PREFIX = 'PROV';
// Nº de cuenta sin espacios ("3071 13" = "307113")
export const accountKey = (no: string) => String(no || '').replace(/\s+/g, '').toUpperCase();
// Cuentas de provisiones (Rückstellungen 30xx: 3071 13, 3072 02…). Los documentos PROV sin cuenta 30xx no son dotaciones
// (p. ej. PROV1 / PROV3, refacturación de royalties contra 3401 01 / 1260 01: consumen PROV-ROYALTIES) y no forman serie.
const isBalanceAccount = (no: string) => /^30\d/.test(accountKey(no));
const isOtherBalanceAccount = (no: string) => /^[0-3]\d/.test(accountKey(no)) && !isBalanceAccount(no);

function provisionType(account: string, description: string): ProvType {
  const a = accountKey(account);
  const d = description.toUpperCase();
  if (a.includes('KONDITION') || a.startsWith('4769') || d.includes('KONDITION') || d.includes('CONDITION')) return 'konditions';
  if (a.includes('ROYALT') || a.startsWith('6837') || d.includes('ROYALT') || d.includes('LIZENZ')) return 'royalties';
  if (a.startsWith('6020') || d.includes('KAM') || d.includes('INCENTIV') || d.includes('BONUS')) return 'incentives';
  // Amazon Promotions (3072 02) va aparte de Marketing
  if (a.includes('AMZPROM') || a.startsWith('307202') || (d.includes('AMAZON') && !d.includes('EXCL'))) return 'amazon';
  if (a.includes('MARKETING') || a.startsWith('6600') || d.includes('MARKETING') || d.includes('PROMOTION')) return 'marketing';
  return 'other';
}

export type GlEntry = { Entry_No: number; Posting_Date: string; Document_No: string; G_L_Account_No: string; Description: string; Amount: number };
export type ProvisionRow = {
  doc: string; date: string; desc: string; account: string; series: string; t: ProvType; orig: number; cons: number; open: number; latest: boolean;
};

const r2 = (v: number) => Math.round(v * 100) / 100;

// Filas por documento a partir de los movimientos PROV* del año hasta la fecha de corte
export function buildProvisionRows(entries: GlEntry[], flaggedAccounts: Set<string>, date: string, year: string): ProvisionRow[] {
  const inScope = entries.filter(e =>
    String(e.Document_No || '').toUpperCase().startsWith(PROVISION_DOC_PREFIX) && e.Posting_Date <= date && e.Posting_Date.startsWith(year));
  const docs = new Map<string, GlEntry[]>();
  for (const e of inScope) docs.set(e.Document_No, [...(docs.get(e.Document_No) || []), e]);

  const rows: ProvisionRow[] = [];
  for (const [doc, list] of docs) {
    list.sort((a, b) => a.Entry_No - b.Entry_No);
    const firstBalance = list.find(e => isBalanceAccount(e.G_L_Account_No));
    if (!firstBalance) continue;   // sin cuenta de provisión: no es una dotación (traspasos, refacturación PROV1/PROV3…)
    const expense = list.find(e => flaggedAccounts.has(accountKey(e.G_L_Account_No)))
      || list.find(e => !isBalanceAccount(e.G_L_Account_No) && !isOtherBalanceAccount(e.G_L_Account_No));
    const date0 = list.reduce((m, e) => (e.Posting_Date < m ? e.Posting_Date : m), list[0].Posting_Date);
    rows.push({
      doc, date: date0, desc: firstBalance.Description || list[0].Description, account: firstBalance.G_L_Account_No,
      series: accountKey(firstBalance.G_L_Account_No),
      t: accountKey(firstBalance.G_L_Account_No) === '307202' ? 'amazon' : provisionType(expense?.G_L_Account_No || '', firstBalance.Description || ''),
      orig: r2(-firstBalance.Amount), cons: 0, open: 0, latest: false,
    });
  }
  // Saldo de cada cuenta de serie con todos los movimientos PROV* del año
  const seriesAccounts = new Set(rows.map(r => r.series));
  const balance = new Map<string, number>();
  for (const e of inScope) {
    const k = accountKey(e.G_L_Account_No);
    if (seriesAccounts.has(k)) balance.set(k, (balance.get(k) || 0) + e.Amount);
  }
  // El abierto de la serie va al último documento (fecha y nº más altos)
  for (const series of seriesAccounts) {
    const list = rows.filter(r => r.series === series).sort((a, b) => a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));
    const last = list[list.length - 1];
    last.open = r2(-(balance.get(series) || 0));
    last.latest = true;
  }
  rows.forEach(r => { r.cons = r2(r.orig - r.open); });
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));
}

export async function fetchProvisionData(ctx: BcContext, date: string) {
  const [accounts, entries] = await Promise.all([
    bcFetchAll(odataUrl(`${ctx.customApiBase}/glAccounts`, { $filter: 'provision eq true', $select: 'no,name' }), ctx.token),
    bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
      $filter: `startswith(Document_No,'${PROVISION_DOC_PREFIX}') and Posting_Date le ${date}`,
      $select: 'Entry_No,Posting_Date,Document_No,G_L_Account_No,Description,Amount',
    }), ctx.token),
  ]);
  return { accounts, entries: entries as GlEntry[], flagged: new Set<string>(accounts.map((a: any) => accountKey(a.no))) };
}

export async function provisionsReport(ctx: BcContext, company: string, month: string, force = false) {
  const date = cutoffDate(month);
  const year = date.substring(0, 4);
  return cached(`prov6:${company}:${date}`, date < today() ? 12 * HOUR : 1 * HOUR, async () => {
    const { entries, flagged } = await fetchProvisionData(ctx, date);
    const all = buildProvisionRows(entries, flagged, date, year);
    // Tabla: una fila por serie (su último documento) con la dotación del año; dotación del mes: documentos del mes
    const rows = all.filter(r => r.latest && r.open !== 0).map(r => {
      const orig = r2(all.filter(x => x.series === r.series).reduce((s, x) => s + x.orig, 0));
      return { ...r, orig, cons: r2(orig - r.open) };
    });
    const thisMonth = all.filter(r => r.date.startsWith(date.substring(0, 7)));

    const sumBy = (list: ProvisionRow[]) => ({
      orig: r2(list.reduce((s, r) => s + r.orig, 0)),
      cons: r2(list.reduce((s, r) => s + r.cons, 0)),
      open: r2(list.reduce((s, r) => s + r.open, 0)),
    });
    const types: ProvType[] = ['konditions', 'marketing', 'amazon', 'royalties', 'incentives', 'other'];

    return {
      date, year,
      ...sumBy(rows), n: rows.length,
      byType: types.map(t => ({ t, ...sumBy(rows.filter(r => r.t === t)) })).filter(t => t.orig || t.open),
      byMonth: Array.from(new Set(all.map(r => r.date.substring(0, 7)))).sort().map(m => ({ month: m, ...sumBy(all.filter(r => r.date.startsWith(m))) })),
      month: sumBy(thisMonth),
      rows,
    };
  }, force);
}
