// Fechas del reporting. Los meses son "YYYY-MM" y las fechas "YYYY-MM-DD".

export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().substring(0, 10);
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().substring(0, 7);
}

export function currentMonth(): string {
  return new Date().toISOString().substring(0, 7);
}

export function today(): string {
  return new Date().toISOString().substring(0, 10);
}

// Mes del informe por defecto: el último cerrado
export function defaultMonth(): string {
  return shiftMonth(currentMonth(), -1);
}

export function isValidMonth(month: string | null | undefined): month is string {
  return !!month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

// Fecha de corte del informe: fin de mes, o hoy si el mes está en curso
export function cutoffDate(month: string): string {
  const end = monthEnd(month);
  const t = today();
  return end < t ? end : t;
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
