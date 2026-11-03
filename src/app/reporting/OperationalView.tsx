'use client';

import React from 'react';
import * as XLSX from 'xlsx';
import { FileDown } from 'lucide-react';
import type { Fmt } from './i18n';
import { BridgeChart, Card, ErrorBox, Grid, Hl, Kpi, Loading, Note, Section, Signed, Table } from './ui';
import InventoryBreakdown, { Analysis, Delta } from './InventoryBreakdown';

export type Loaded<T = any> = { data: T | null; loading: boolean; error: string | null };

function Block<T>({ state, fmt, children }: { state: Loaded<T>; fmt: Fmt; children: (d: T) => React.ReactNode }) {
  if (state.error) return <ErrorBox message={state.error} />;
  if (state.loading || !state.data) return <Loading text={fmt.t('loading')} />;
  return <>{children(state.data)}</>;
}

const share = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);

// Excel con todos los productos que suben (o bajan) de valor entre los dos cierres, no solo el top 10
function exportChanges(fmt: Fmt, d: any, dir: 'up' | 'down') {
  const { t } = fmt;
  const list = (d.changes || []).filter((c: any) => (dir === 'up' ? c.dv > 0 : c.dv < 0));
  if (dir === 'down') list.reverse();
  const rows = list.map((c: any) => ({
    [t('code')]: c.code, [t('product')]: c.desc,
    [t('unitsAt', { date: fmt.date(d.prevDate) })]: c.qa, [t('unitsAt', { date: fmt.date(d.date) })]: c.qs,
    [t('valueAt', { date: fmt.date(d.prevDate) })]: Math.round(c.va * 100) / 100, [t('valueAt', { date: fmt.date(d.date) })]: Math.round(c.vs * 100) / 100,
    [t('deltaValue')]: Math.round(c.dv * 100) / 100,
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), dir === 'up' ? 'Up' : 'Down');
  XLSX.writeFile(wb, `Inventory_${dir === 'up' ? 'up' : 'down'}_${d.prevDate}_${d.date}.xlsx`);
}

// KPIs de /api/reporting/inventory-analysis?kind=kpis (src/lib/reporting/inventoryKpis.ts) y desglose del ADS
export type InvKpis = Analysis & {
  destroyed: { value: number; qty: number }[]; pallets: number; noPallet: number; ads: { days: number | null; qty: number }[];
};

export function InventorySection({ fmt, inv, an, kp }: { fmt: Fmt; inv: Loaded; an: Loaded<Analysis>; kp: Loaded<InvKpis> }) {
  const { t, short, num, date, eur } = fmt;
  const k = kp.data;
  const cur = k ? k.prevDates.length + k.curDates.length - 1 : -1;     // mes del informe
  const ly = k && k.curDates.length <= k.prevDates.length ? k.curDates.length - 1 : -1;
  const ytd = (from: number, to: number, f: (i: number) => number) => { let x = 0; for (let i = from; i <= to; i++) x += f(i); return x; };
  const adsOf = (from: number, to: number) => {
    if (!k || to < from) return null;
    const q = ytd(from, to, i => k.ads[i].qty);
    return q ? ytd(from, to, i => (k.ads[i].days || 0) * k.ads[i].qty) / q : null;
  };
  const pending = kp.error ? '!' : '…';
  const kpiSub = (text: string) => (kp.error ? kp.error : text);
  return (
    <Section title={t('invTitle')} source={inv.data ? t('invSource', { date: date(inv.data.date) }) : undefined}>
      <Block state={inv} fmt={fmt}>{(d: any) => {
        // Mismo fin de mes del año anterior (del análisis por meses)
        const lyInv = an.data?.totals.find(x => x.date === an.data!.prevDates[an.data!.curDates.length - 1]);
        const adsCur = k ? k.ads[cur].days : null;
        const adsLy = k && ly >= 0 ? k.ads[ly].days : null;
        return (
          <>
            <Grid cols={4}>
              <Kpi highlight tone="main" label={t('kpiInvValue', { date: date(d.date) })} value={short(d.total)} sub={t('unitsRefs', { qty: num(d.qty), n: num(d.nItems) })}
                extra={lyInv && (
                  <p className="text-[11px] text-gray-500 mt-1.5 pt-1.5 border-t border-gray-100">
                    {t('vsLastYear', { date: date(lyInv.date) })}: {short(lyInv.value)} · {t('unitsRefs', { qty: num(lyInv.qty), n: num(lyInv.skus) })}
                    <span className="block font-semibold">
                      <Delta fmt={fmt} cur={d.total} prev={lyInv.value} /> {t('yoyValue')} · <Delta fmt={fmt} cur={d.qty} prev={lyInv.qty} /> {t('yoyUnits')}
                    </span>
                  </p>
                )} />
              {/* Lo destruido en el año hasta el mes del informe; en pequeño, lo del propio mes */}
              <Kpi tone="red" label={t('kpiDestroyed', { year: k?.year ?? '' })} value={k ? short(ytd(k.prevDates.length, cur, i => k.destroyed[i].value)) : pending}
                sub={kpiSub(k ? t('destroyedSub', { qty: num(ytd(k.prevDates.length, cur, i => k.destroyed[i].qty)), month: fmt.monthCode(k.month), mv: short(k.destroyed[cur].value), mq: num(k.destroyed[cur].qty) }) : t('loading'))} />
              <Kpi label={t('kpiPallets', { date: date(d.date) })} value={k ? num(k.pallets) : pending}
                sub={kpiSub(k ? t('palletsSub', { n: num(k.noPallet) }) : t('loading'))} />
              <Kpi label={t('kpiAds')} value={k ? (adsCur == null ? '–' : t('daysN', { n: num(adsCur) })) : pending}
                sub={kpiSub(k ? t('adsSub', { ytd: adsOf(k.prevDates.length, cur) == null ? '–' : num(adsOf(k.prevDates.length, cur)!) }) : t('loading'))}
                extra={k && adsLy != null && (
                  <p className="text-[11px] text-gray-500 mt-1.5 pt-1.5 border-t border-gray-100">
                    {t('vsLastYear', { date: fmt.monthName(k.prevDates[ly].substring(0, 7)) })}: {t('daysN', { n: num(adsLy) })} · <span className="font-semibold"><Delta fmt={fmt} cur={adsCur} prev={adsLy} invert /></span>
                  </p>
                )} />
            </Grid>
            {an.error ? <ErrorBox message={an.error} />
              : an.loading || !an.data ? <Loading text={t('anLoading')} />
              : <InventoryBreakdown fmt={fmt} an={an.data} adsData={k} />}
            {kp.error ? <ErrorBox message={kp.error} />
              : kp.loading || !k ? <Loading text={t('anLoading')} />
              : <InventoryBreakdown fmt={fmt} an={k} kind="ads" />}
            <div className="space-y-4">
              {(['up', 'down'] as const).map(dir => (
                <Card key={dir} title={t(dir === 'up' ? 'topUp' : 'topDown')} sub={`(${date(d.prevDate)} → ${date(d.date)})`}>
                  <div className="rpt-noprint flex justify-end -mt-9 mb-2">
                    <button onClick={() => exportChanges(fmt, d, dir)} className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1.5 hover:text-gray-900 bg-white">
                      <FileDown size={14} /> {t('downloadAll')}
                    </button>
                  </div>
                  <Table
                    cols={[{ label: t('code'), nowrap: true }, { label: t('product'), wide: true }, { label: t('unitsAt', { date: fmt.shortDate(d.prevDate) }), align: 'right', mono: true, hideMobile: true }, { label: t('unitsAt', { date: fmt.shortDate(d.date) }), align: 'right', mono: true, hideMobile: true }, { label: t('valueAt', { date: fmt.shortDate(d.date) }), align: 'right', mono: true }, { label: t('deltaValue'), align: 'right', mono: true }]}
                    rows={d[dir].map((i: any) => [i.code, i.desc, num(i.qa), num(i.qs), eur(i.vs), <Signed key="d" v={i.dv} text={(i.dv > 0 ? '+' : '') + eur(i.dv)} />])}
                  />
                </Card>
              ))}
            </div>
          </>
        );
      }}</Block>
    </Section>
  );
}

export function PurchasesSection({ fmt, pur, pa, month }: { fmt: Fmt; pur: Loaded; pa: Loaded<Analysis>; month: string }) {
  const { t, short, pct, monthName } = fmt;
  return (
    <Section title={t('purTitle')} source={t('purSource')}>
      <Block state={pur} fmt={fmt}>{(d: any) => {
        const diff = d.total - d.prevTotal;
        return (
          <>
            <Grid cols={4}>
              <Kpi highlight tone="main" label={t('kpiPurMonth', { month: monthName(month) })} value={short(d.total)} sub={t('invoicesN', { n: d.n })} />
              <Kpi label={monthName(d.monthly[10].month)} value={short(d.prevTotal)} sub={t('variationVs', { v: short(diff), p: pct(share(diff, d.prevTotal)) })} />
              <Kpi label={t('kpiAvg12')} value={short(d.avg12)} sub={`${monthName(d.monthly[0].month, 'short')} – ${monthName(d.monthly[11].month, 'short')}`} />
              <Kpi label={t('kpiVendors')} value={String(d.byVendor.length)} sub={d.byVendor.map((v: any) => `${v.vendor.split(' (')[0]} ${short(v.amt)}`).join(' · ')} />
            </Grid>
            {pa.error ? <ErrorBox message={pa.error} />
              : pa.loading || !pa.data ? <Loading text={t('loading')} />
              : <InventoryBreakdown fmt={fmt} an={pa.data} kind="flow" />}
          </>
        );
      }}</Block>
    </Section>
  );
}

export function UninsuredSection({ fmt, ar }: { fmt: Fmt; ar: Loaded }) {
  const { t, eur, short, pct, date } = fmt;
  return (
    <Section title={t('uniTitle')} source={ar.data ? t('uniSource', { date: date(ar.data.date) }) : undefined}>
      <Block state={ar} fmt={fmt}>{(d: any) => {
        const u = d.uninsured;
        const keys = ['AMAZON', 'LIDL', 'ALDI'];
        const totalU = keys.reduce((s, k) => s + u[k].total, 0);
        return (
          <>
            <Grid cols={4}>
              <Kpi highlight tone="main" label={t('kpiUniTotal')} value={short(totalU)} sub={t('uniSub')} />
              {keys.map(k => (
                <Kpi key={k} label={k} value={short(u[k].total)} tone={share(u[k].overdue, u[k].total) > 50 ? 'amber' : 'neutral'}
                  sub={t('overdueAt', { date: fmt.shortDate(d.date), v: short(u[k].overdue), p: pct(share(u[k].overdue, u[k].total)) })} />
              ))}
            </Grid>
            <Grid>
              {keys.map(k => (
                <Card key={k} title={t('byEntity', { name: k.charAt(0) + k.slice(1).toLowerCase() })} sub={t('nItems', { n: u[k].n })}>
                  <Table
                    cols={[{ label: t('customer'), wide: true }, { label: t('pending'), align: 'right', mono: true }, { label: t('pctGroup'), align: 'right', mono: true }]}
                    rows={u[k].ent.map((e: any) => [e.key, eur(e.amt), pct(share(e.amt, u[k].total))])}
                  />
                </Card>
              ))}
            </Grid>
          </>
        );
      }}</Block>
    </Section>
  );
}

export function CostSection({ fmt, inv }: { fmt: Fmt; inv: Loaded }) {
  const { t, eur, short, num, pct, date } = fmt;
  return (
    <Section title={t('costTitle')} source={inv.data ? t('costSource', { a: date(inv.data.prevDate), b: date(inv.data.date) }) : undefined}>
      <Block state={inv} fmt={fmt}>{(d: any) => {
        const c = d.cost;
        return (
          <>
            <div className="space-y-4">
              <Card title={t('bridge')} sub={`(${date(d.prevDate)} → ${date(d.date)})`}>
                <BridgeChart fmt={fmt} steps={[
                  { label: fmt.shortDate(d.prevDate), value: d.prevTotal, kind: 'total' },
                  { label: t('priceEffect'), value: c.priceEffect, kind: 'delta' },
                  { label: t('volumeMix'), value: c.volEffect, kind: 'delta' },
                  { label: fmt.shortDate(d.date), value: d.total, kind: 'total' },
                ]} />
              </Card>
              <Card title={t('costTable')}>
                <Table
                  cols={[{ label: t('code'), nowrap: true }, { label: t('product'), wide: true }, { label: t('costAt', { date: fmt.shortDate(d.prevDate) }), align: 'right', mono: true, hideMobile: true }, { label: t('costAt', { date: fmt.shortDate(d.date) }), align: 'right', mono: true }, { label: t('deltaPct'), align: 'right', mono: true }, { label: t('effect'), align: 'right', mono: true }]}
                  rows={c.items.map((i: any) => [i.code, i.desc, num(i.ca, 4), num(i.cs, 4),
                    <Signed key="p" v={i.dcp} text={(i.dcp > 0 ? '+' : '') + pct(i.dcp)} />,
                    <Signed key="e" v={i.eff} text={(i.eff > 0 ? '+' : '') + eur(i.eff)} />])}
                />
              </Card>
            </div>
            <Note>
              {t('costNote', {
                a: num(c.unitCostPrev, 4), b: num(c.unitCostCur, 4), p: pct(share(c.unitCostCur - c.unitCostPrev, c.unitCostPrev)),
                pe: short(c.priceEffect), ve: short(c.volEffect), n: c.nChanged, m: c.nBoth, up: c.nUp, down: c.nDown,
              })}
              {c.items[0] && <> <Hl>{c.items[0].code} {c.items[0].desc}</Hl>: {pct(c.items[0].dcp)} · {eur(c.items[0].eff)}.</>}
            </Note>
          </>
        );
      }}</Block>
    </Section>
  );
}

export default function OperationalView({ fmt, inv, ar }: { fmt: Fmt; inv: Loaded; ar: Loaded }) {
  return (
    <div className="space-y-10">
      <UninsuredSection fmt={fmt} ar={ar} />
      <CostSection fmt={fmt} inv={inv} />
    </div>
  );
}

// Análisis de inventario: valor por Location Code y compras de inventario (CHINA TRF)
export function InventoryAnalysisView({ fmt, month, inv, pur, an, pa, kp }: { fmt: Fmt; month: string; inv: Loaded; pur: Loaded; an: Loaded<Analysis>; pa: Loaded<Analysis>; kp: Loaded<InvKpis> }) {
  return (
    <div className="space-y-10">
      <InventorySection fmt={fmt} inv={inv} an={an} kp={kp} />
      <PurchasesSection fmt={fmt} pur={pur} pa={pa} month={month} />
    </div>
  );
}
