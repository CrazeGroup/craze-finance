import { getCashflow } from '@/lib/cashflow';
import { readSetting } from './cache';
import { today } from './period';

// Previsión de tesorería desde el cashflow de la propia app (pantalla Cashflow, EUR): saldo diario,
// días por debajo del límite de descubierto y entradas/salidas por bloque y mes.

export const DEFAULT_OVERDRAFT_LIMIT = -1_000_000;
// Horizonte de la previsión: mes en curso + 4 meses (los recurrentes se proyectan 12 meses y distorsionarían)
const HORIZON_MONTHS = 4;

type Category = 'markant' | 'customers' | 'china' | 'paymentRuns' | 'customs' | 'banks' | 'otherOut';

function category(description: string, amount: number): Category {
  const d = description.toLowerCase();
  if (d.includes('markant')) return 'markant';
  if (amount > 0) return 'customers';
  if (/(magic rainbow|golden wire|macau|china)/.test(d)) return 'china';
  if (d.includes('payment run')) return 'paymentRuns';
  if (/(eust|zoll|aduana|customs|einfuhr)/.test(d)) return 'customs';
  if (/(bank|darlehen|kredit|credit|loan|préstamo|prestamo|tilgung|sparkasse)/.test(d)) return 'banks';
  return 'otherOut';
}

export async function cashflowReport(company: string) {
  const [{ initialBalance, initialBalanceDate, entries }, limit] = await Promise.all([
    getCashflow(company, 'EUR'),
    readSetting<number>('overdraftLimit', DEFAULT_OVERDRAFT_LIMIT),
  ]);
  return buildCashflowReport(initialBalance, initialBalanceDate, entries, limit);
}

type CashflowEntry = { date: Date | string; description: string; amount: number; balance: number };

export function buildCashflowReport(initialBalance: number, initialBalanceDate: Date | string, allEntries: CashflowEntry[], limit: number) {
  const now = new Date();
  const horizon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + HORIZON_MONTHS + 1, 0)).toISOString().substring(0, 10);
  const entries = allEntries.filter(e => new Date(e.date).toISOString().substring(0, 10) <= horizon);

  // Saldo al cierre de cada día con movimientos
  const daily: { date: string; balance: number }[] = [];
  for (const e of entries) {
    const date = new Date(e.date).toISOString().substring(0, 10);
    const last = daily[daily.length - 1];
    if (last && last.date === date) last.balance = e.balance;
    else daily.push({ date, balance: e.balance });
  }
  const start = { date: new Date(initialBalanceDate).toISOString().substring(0, 10), balance: initialBalance };
  const series = [start, ...daily.filter(d => d.date >= start.date)];

  // Tramos por debajo del límite (un tramo dura hasta el siguiente cambio de saldo)
  const breaches: { from: string; to: string; min: number }[] = [];
  let breachDays = 0;
  series.forEach((p, i) => {
    const next = series[i + 1];
    const to = next ? next.date : p.date;
    if (p.balance < limit) {
      breachDays += Math.max(1, Math.round((Date.parse(to) - Date.parse(p.date)) / 86400000));
      const prev = breaches[breaches.length - 1];
      if (prev && prev.to === p.date) { prev.to = to; prev.min = Math.min(prev.min, p.balance); }
      else breaches.push({ from: p.date, to, min: p.balance });
    }
  });
  const min = series.reduce((m, p) => (p.balance < m.balance ? p : m), series[0]);

  const byMonth = new Map<string, Record<Category, number>>();
  for (const e of entries) {
    const month = new Date(e.date).toISOString().substring(0, 7);
    const row = byMonth.get(month) || { markant: 0, customers: 0, china: 0, paymentRuns: 0, customs: 0, banks: 0, otherOut: 0 };
    row[category(e.description || '', e.amount)] += e.amount;
    byMonth.set(month, row);
  }

  return {
    today: today(), limit, horizon,
    start, end: series[series.length - 1], min,
    breachDays, breaches,
    series,
    months: Array.from(byMonth.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([month, cats]) => ({ month, ...cats })),
    // Cobros Markant previstos por fecha (para comparar con las fechas confirmadas en BC)
    markant: Array.from(entries.filter(e => (e.description || '').toLowerCase().includes('markant'))
      .reduce((m, e) => { const d = new Date(e.date).toISOString().substring(0, 10); m.set(d, (m.get(d) || 0) + e.amount); return m; }, new Map<string, number>())
      .entries()).map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)),
    // Movimientos grandes, para los puntos a analizar
    bigMoves: entries
      .filter(e => Math.abs(e.amount) >= 100_000)
      .map(e => ({ date: new Date(e.date).toISOString().substring(0, 10), description: e.description, amount: e.amount, balance: e.balance })),
  };
}
