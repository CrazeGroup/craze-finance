'use client';

import React from 'react';
import type { Fmt } from './i18n';
import { BarChart, BridgeChart, C, Card, ErrorBox, Grid, Hl, Kpi, Loading, Note, Section, Signed, Table } from './ui';
import InventoryBreakdown, { Analysis, Delta } from './InventoryBreakdown';

export type Loaded<T = any> = { data: T | null; loading: boolean; error: string | null };

function Block<T>({ state, fmt, children }: { state: Loaded<T>; fmt: Fmt; children: (d: T) => React.ReactNode }) {
  if (state.error) return <ErrorBox message={state.error} />;
  if (state.loading || !state.data) return <Loading text={fmt.t('loading')} />;
  return <>{children(state.data)}</>;
}

const share = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);

export function InventorySection({ fmt, inv, an }: { fmt: Fmt; inv: Loaded; an: Loaded<Analysis> }) {
  const { t, eur, short, num, pct, date } = fmt;
  return (
    <Section title={t('invTitle')} source={inv.data ? t('invSource', { date: date(inv.data.date) }) : undefined}>
      <Block state={inv} fmt={fmt}>{(d: any) => {
        const diff = d.total - d.prevTotal;
        const main = d.locations[0];
        // Mismo fin de mes del año anterior (del análisis por meses)
        const ly = an.data?.totals.find(x => x.date === an.data!.prevDates[an.data!.curDates.length - 1]);
        return (
          <>
            <Grid cols={4}>
              <Kpi highlight tone="main" label={t('kpiInvValue', { date: date(d.date) })} value={short(d.total)} sub={t('unitsRefs', { qty: num(d.qty), n: num(d.nItems) })}
                extra={ly && (
                  <p className="text-[11px] text-gray-500 mt-1.5 pt-1.5 border-t border-gray-100">
                    {t('vsLastYear', { date: date(ly.date) })}: {short(ly.value)} · {t('unitsRefs', { qty: num(ly.qty), n: num(ly.skus) })}
                    <span className="block font-semibold">
                      <Delta fmt={fmt} cur={d.total} prev={ly.value} /> {t('yoyValue')} · <Delta fmt={fmt} cur={d.qty} prev={ly.qty} /> {t('yoyUnits')}
                    </span>
                  </p>
                )} />
              <Kpi tone={diff < 0 ? 'red' : 'green'} label={t('kpiVariation', { date: date(d.prevDate) })} value={short(diff)} sub={pct(share(diff, d.prevTotal))} />
              <Kpi label={t('kpiAfterDep')} value={short(d.totalDep)} sub={t('afterDepSub')} />
              {main && <Kpi label={t('kpiShare', { loc: main.loc })} value={pct(share(main.value, d.total))} sub={t('mainWarehouse')} />}
            </Grid>
            {an.error ? <ErrorBox message={an.error} />
              : an.loading || !an.data ? <Loading text={t('anLoading')} />
              : <InventoryBreakdown fmt={fmt} an={an.data} />}
            <div className="space-y-4">
              {(['up', 'down'] as const).map(k => (
                <Card key={k} title={t(k === 'up' ? 'topUp' : 'topDown')} sub={`(${date(d.prevDate)} → ${date(d.date)})`}>
                  <Table
                    cols={[{ label: t('code'), nowrap: true }, { label: t('product'), wide: true }, { label: t('unitsAt', { date: fmt.shortDate(d.prevDate) }), align: 'right', mono: true, hideMobile: true }, { label: t('unitsAt', { date: fmt.shortDate(d.date) }), align: 'right', mono: true, hideMobile: true }, { label: t('valueAt', { date: fmt.shortDate(d.date) }), align: 'right', mono: true }, { label: t('deltaValue'), align: 'right', mono: true }]}
                    rows={d[k].map((i: any) => [i.code, i.desc, num(i.qa), num(i.qs), eur(i.vs), <Signed key="d" v={i.dv} text={(i.dv > 0 ? '+' : '') + eur(i.dv)} />])}
                  />
                </Card>
              ))}
            </div>
            <Note>
              {Object.entries(d.remap).map(([a, b]) => <span key={a}>{t('remapNote', { a, b: b as string })} </span>)}
              {t('glNote', { acc: d.glAccount, gl: short(d.glBalance), date: date(d.date), inv: short(d.total), diff: short(d.glBalance - d.total) })}
            </Note>
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
export function InventoryAnalysisView({ fmt, month, inv, pur, an, pa }: { fmt: Fmt; month: string; inv: Loaded; pur: Loaded; an: Loaded<Analysis>; pa: Loaded<Analysis> }) {
  return (
    <div className="space-y-10">
      <InventorySection fmt={fmt} inv={inv} an={an} />
      <PurchasesSection fmt={fmt} pur={pur} pa={pa} month={month} />
    </div>
  );
}
