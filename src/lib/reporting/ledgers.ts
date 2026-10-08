import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from './cache';
import { cutoffDate, daysBetween, monthEnd, shiftMonth, today } from './period';

// Cartera de clientes y proveedores a la fecha de cierre, desde la API custom de BC
// (custLedgerEntries = tabla 21, vendorLedgerEntries = tabla 25).
// Abierto a una fecha = registrado hasta esa fecha y (abierto hoy o cerrado después de esa fecha).
// Importe a esa fecha: el pendiente actual si sigue abierto; el importe del documento si se cerró después
// (los cobros/pagos parciales posteriores al cierre no se pueden separar sin los movimientos detallados).

const CUST_FIELDS = 'entryNo,customerNo,customerName,postingDate,documentType,documentNo,dueDate,amount,remainingAmount,paymentMethodCode,confirmedPaymentDate,open,closedAtDate';
const VEND_FIELDS = 'entryNo,vendorNo,vendorName,postingDate,documentType,documentNo,externalDocumentNo,dueDate,amount,remainingAmount,paymentMethodCode,scheduledPaymentDateBCT,open,closedAtDate';

const realDate = (d: string | null | undefined) => (d && !d.startsWith('0001-01-01') ? d.substring(0, 10) : null);

type Entry = {
  no: string; name: string; posting: string; type: string; doc: string; ext?: string; due: string;
  amt: number; pm: string; date: string | null;
};

export async function openEntriesAt(ctx: BcContext, kind: 'cust' | 'vend', date: string): Promise<Entry[]> {
  const base = `${ctx.customApiBase}/${kind === 'cust' ? 'custLedgerEntries' : 'vendorLedgerEntries'}`;
  const $select = kind === 'cust' ? CUST_FIELDS : VEND_FIELDS;
  // BC no admite "or" entre campos distintos: abiertos + cerrados después de la fecha, por separado
  const [openRows, closedAfter] = await Promise.all([
    bcFetchAll(odataUrl(base, { $filter: `open eq true and postingDate le ${date}`, $select }), ctx.token),
    date >= today() ? Promise.resolve([]) : bcFetchAll(odataUrl(base, { $filter: `open eq false and postingDate le ${date} and closedAtDate gt ${date}`, $select }), ctx.token),
  ]);
  return [...openRows, ...closedAfter]
    .filter(r => r.postingDate <= date)
    .map(r => ({
      no: kind === 'cust' ? r.customerNo : r.vendorNo,
      name: kind === 'cust' ? r.customerName : r.vendorName,
      posting: r.postingDate,
      type: (r.documentType || '').trim(),
      doc: r.documentNo,
      ext: r.externalDocumentNo,
      due: r.dueDate,
      amt: r.open ? r.remainingAmount : r.amount,
      pm: (r.paymentMethodCode || '').trim(),
      date: realDate(kind === 'cust' ? r.confirmedPaymentDate : r.scheduledPaymentDateBCT),
    }));
}

const total = (list: Entry[]) => list.reduce((s, e) => s + e.amt, 0);

function groupSum<T extends string>(list: Entry[], key: (e: Entry) => T) {
  const map = new Map<T, { amt: number; n: number }>();
  for (const e of list) {
    const g = map.get(key(e)) || { amt: 0, n: 0 };
    g.amt += e.amt;
    g.n++;
    map.set(key(e), g);
  }
  return map;
}

// Importe por mes de vencimiento o por fecha (YYYY-MM o YYYY-MM-DD), ordenado
const byKeySorted = (list: Entry[], key: (e: Entry) => string) =>
  Array.from(groupSum(list, key).entries()).map(([k, v]) => ({ key: k, amt: v.amt, n: v.n })).sort((a, b) => a.key.localeCompare(b.key));

const topBy = (list: Entry[], key: (e: Entry) => string, n: number) =>
  Array.from(groupSum(list, key).entries()).map(([k, v]) => ({ key: k, amt: v.amt, n: v.n })).sort((a, b) => Math.abs(b.amt) - Math.abs(a.amt)).slice(0, n);

const pmLabel = (pm: string) => pm || '';

// ---------- Clientes ----------

const UNINSURED = ['AMAZON', 'ALDI', 'LIDL'];
const AGE_BUCKETS: [string, number, number][] = [['notDue', -Infinity, 0], ['d1_30', 1, 30], ['d31_60', 31, 60], ['d61_90', 61, 90], ['d90', 91, Infinity]];

function docTypeKey(type: string) {
  switch (type) {
    case 'Invoice': return 'invoice';
    case 'Refund': return 'refund';
    case 'Payment': return 'payment';
    case 'Credit Memo': return 'creditMemo';
    default: return 'other';
  }
}

export function buildReceivables(all: Entry[], date: string) {
  const overdue = (e: Entry) => e.due < date;
  const ar = all.filter(e => e.pm !== 'INTERGROUP');

  const byPM = Array.from(groupSum(ar, e => pmLabel(e.pm)).entries())
    .map(([pm, g]) => ({ pm, amt: g.amt, n: g.n, od: total(ar.filter(e => pmLabel(e.pm) === pm && overdue(e))) }))
    .sort((a, b) => b.amt - a.amt);

  const mk = ar.filter(e => e.pm === 'MARKANT');
  const mkConf = mk.filter(e => e.date);
  const mkUnconf = mk.filter(e => !e.date);

  const uninsured = Object.fromEntries(UNINSURED.map(k => {
    const list = all.filter(e => (e.name || '').toUpperCase().includes(k));
    return [k, {
      total: total(list), n: list.length,
      overdue: total(list.filter(overdue)),
      od60: total(list.filter(e => daysBetween(e.due, date) > 60)),
      ent: topBy(list, e => e.name, 6),
    }];
  }));

  const amz = all.filter(e => (e.name || '').toUpperCase().includes('AMAZON'));
  const age = AGE_BUCKETS.map(([b, from, to]) => {
    const list = amz.filter(e => { const d = daysBetween(e.due, date); return d >= from && d <= to; });
    return { b, net: total(list), pos: total(list.filter(e => e.amt > 0)), neg: total(list.filter(e => e.amt < 0)), n: list.length };
  });
  const old = amz.filter(e => daysBetween(e.due, date) > 90);
  const notDue = amz.filter(e => !overdue(e));
  const ents = Array.from(groupSum(amz, e => e.name).entries()).map(([e, g]) => ({
    e, tot: g.amt, n: g.n,
    nv: total(notDue.filter(x => x.name === e)), ov: total(amz.filter(x => x.name === e && overdue(x))),
  })).sort((a, b) => b.tot - a.tot);
  const prevMonthStart = `${shiftMonth(date.substring(0, 7), -1)}-01`;

  return {
    date,
    ar: { total: total(ar), n: ar.length, overdue: total(ar.filter(overdue)), byPM },
    markant: {
      total: total(mk), n: mk.length,
      conf: total(mkConf), nConf: mkConf.length,
      unconf: total(mkUnconf), nUnconf: mkUnconf.length,
      unconfOverdue: total(mkUnconf.filter(overdue)),
      sched: byKeySorted(mkConf, e => e.date as string),
      unconfTop: topBy(mkUnconf, e => e.name, 6),
    },
    uninsured,
    amazon: {
      total: total(amz), n: amz.length, share: total(ar) ? total(amz) / total(ar) : 0,
      notDue: total(notDue), overdue: total(amz.filter(overdue)),
      old: { n: old.length, pos: total(old.filter(e => e.amt > 0)), neg: total(old.filter(e => e.amt < 0)) },
      age, ents,
      dt: Array.from(groupSum(amz, e => docTypeKey(e.type)).entries()).map(([t, g]) => ({ t, amt: g.amt, n: g.n })).sort((a, b) => b.amt - a.amt),
      pm: topBy(amz, e => pmLabel(e.pm), 10).map(p => ({ pm: p.key, amt: p.amt, n: p.n })),
      dueNext: byKeySorted(notDue, e => e.due.substring(0, 7)).slice(0, 3),
      recent: total(amz.filter(e => e.posting >= prevMonthStart && e.type === 'Invoice')),
    },
  };
}

export async function receivablesReport(ctx: BcContext, company: string, month: string, force = false) {
  const date = cutoffDate(month);
  return cached(`ar:${company}:${date}`, date < today() ? 12 * HOUR : 1 * HOUR, async () =>
    buildReceivables(await openEntriesAt(ctx, 'cust', date), date), force);
}

// ---------- Proveedores ----------

export const CHINA_PM = 'CHINA TRF';

export function buildPayables(all: Entry[], date: string) {
  // Importes de proveedor en positivo (lo que se debe)
  const list = all.map(e => ({ ...e, amt: -e.amt }));
  const overdue = (e: Entry) => e.due < date;
  const byPM = Array.from(groupSum(list, e => pmLabel(e.pm)).entries())
    .map(([pm, g]) => ({ pm, amt: g.amt, n: g.n, od: total(list.filter(e => pmLabel(e.pm) === pm && overdue(e))) }))
    .sort((a, b) => b.amt - a.amt);
  const cn = list.filter(e => e.pm === CHINA_PM);
  const conf = cn.filter(e => e.date);
  const unconf = cn.filter(e => !e.date);
  return {
    date,
    ap: { total: total(list), n: list.length, overdue: total(list.filter(overdue)), byPM },
    china: {
      total: total(cn), n: cn.length,
      conf: total(conf), nConf: conf.length,
      unconf: total(unconf), nUnconf: unconf.length,
      overdue: total(cn.filter(overdue)), unconfOverdue: total(unconf.filter(overdue)),
      sched: byKeySorted(conf, e => e.date as string),
      byVendor: topBy(cn, e => e.name, 10),
      byDue: byKeySorted(cn, e => e.due.substring(0, 7)).map(d => ({ ...d, overdue: monthEnd(d.key) <= date })),
      nextQuarterDue: total(cn.filter(e => e.due >= date && e.due <= monthEnd(shiftMonth(date.substring(0, 7), 3)))),
    },
  };
}

export async function payablesReport(ctx: BcContext, company: string, month: string, force = false) {
  const date = cutoffDate(month);
  return cached(`ap:${company}:${date}`, date < today() ? 12 * HOUR : 1 * HOUR, async () =>
    buildPayables(await openEntriesAt(ctx, 'vend', date), date), force);
}

// ---------- Compras de inventario CHINA TRF (facturas registradas, últimos 12 meses) ----------

export async function chinaPurchasesReport(ctx: BcContext, company: string, month: string, force = false) {
  const date = cutoffDate(month);
  const firstMonth = shiftMonth(month, -11);
  return cached(`pur:${company}:${date}`, date < today() ? 12 * HOUR : 1 * HOUR, async () => {
    const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, {
      $filter: `documentType eq 'Invoice' and paymentMethodCode eq '${CHINA_PM}' and postingDate ge ${firstMonth}-01 and postingDate le ${date}`,
      $select: 'postingDate,documentNo,externalDocumentNo,vendorName,amount,dueDate',
    }), ctx.token);
    const months = Array.from({ length: 12 }, (_, i) => shiftMonth(firstMonth, i));
    const monthly = months.map(m => ({ month: m, amt: rows.filter(r => r.postingDate.startsWith(m)).reduce((s, r) => s - r.amount, 0) }));
    const inMonth = rows.filter(r => r.postingDate.startsWith(month))
      .map(r => ({ date: r.postingDate, doc: r.documentNo, ext: r.externalDocumentNo, vendor: r.vendorName, amt: -r.amount, due: r.dueDate }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const byVendor = new Map<string, number>();
    inMonth.forEach(i => byVendor.set(i.vendor, (byVendor.get(i.vendor) || 0) + i.amt));
    return {
      date, monthly,
      total: monthly[11].amt, n: inMonth.length,
      prevTotal: monthly[10].amt,
      avg12: monthly.reduce((s, m) => s + m.amt, 0) / 12,
      byVendor: Array.from(byVendor.entries()).map(([vendor, amt]) => ({ vendor, amt })).sort((a, b) => b.amt - a.amt),
      invoices: inMonth,
    };
  }, force);
}
