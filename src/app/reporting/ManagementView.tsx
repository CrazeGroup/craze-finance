'use client';

import React, { useState } from 'react';
import type { Fmt } from './i18n';
import { BarChart, C, Card, ErrorBox, Grid, Kpi, Loading, Neg, Section, Signed, StepLineChart, Table } from './ui';
import type { Loaded } from './OperationalView';

function Block<T>({ state, fmt, children }: { state: Loaded<T>; fmt: Fmt; children: (d: T) => React.ReactNode }) {
  if (state.error) return <ErrorBox message={state.error} />;
  if (state.loading || !state.data) return <Loading text={fmt.t('loading')} />;
  return <>{children(state.data)}</>;
}

const share = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);
const pmName = (fmt: Fmt, pm: string) => pm || fmt.t('noPM');

// ---------- Clientes ----------

export function ReceivablesSection({ fmt, ar }: { fmt: Fmt; ar: Loaded }) {
  const { t, eur, short, pct, date, num } = fmt;
  return (
    <Section title={t('arTitle')} source={ar.data ? t('arSource', { date: date(ar.data.date) }) : undefined}>
      <Block state={ar} fmt={fmt}>{(d: any) => (
        <>
          <Grid>
            <Kpi highlight tone="main" label={t('kpiAr')} value={short(d.ar.total)} sub={t('nOpen', { n: num(d.ar.n) })} />
            <Kpi tone="amber" label={t('kpiOverdue', { date: fmt.shortDate(d.date) })} value={short(d.ar.overdue)} sub={t('pctOfTotal', { p: pct(share(d.ar.overdue, d.ar.total)) })} />
          </Grid>
          <Grid>
            <Card title={t('byPM')} sub={t('pendingCollection')}>
              <BarChart fmt={fmt} horizontal stacked legend height={Math.max(220, d.ar.byPM.length * 32)}
                labels={d.ar.byPM.map((p: any) => pmName(fmt, p.pm))}
                datasets={[
                  { label: t('notDue'), data: d.ar.byPM.map((p: any) => p.amt - p.od), color: C.navy },
                  { label: t('overdueLegend', { date: fmt.shortDate(d.date) }), data: d.ar.byPM.map((p: any) => p.od), color: C.magenta },
                ]} />
            </Card>
            <Card title={t('pmDetail')}>
              <Table
                cols={[{ label: t('paymentMethod') }, { label: t('pending'), align: 'right', mono: true }, { label: '%', align: 'right', mono: true }, { label: t('overdue'), align: 'right', mono: true }, { label: t('items'), align: 'right', mono: true, hideMobile: true }]}
                rows={d.ar.byPM.map((p: any) => [pmName(fmt, p.pm), eur(p.amt), pct(share(p.amt, d.ar.total)), eur(p.od), num(p.n)])}
                total={[t('total'), eur(d.ar.total), pct(100), eur(d.ar.overdue), num(d.ar.n)]}
              />
            </Card>
          </Grid>
        </>
      )}</Block>
    </Section>
  );
}

export function AmazonSection({ fmt, ar }: { fmt: Fmt; ar: Loaded }) {
  const { t, eur, short, pct, date, num, monthName } = fmt;
  return (
    <Section title={t('amzTitle')} source={ar.data ? t('amzSource', { date: date(ar.data.date) }) : undefined}>
      <Block state={ar} fmt={fmt}>{(d: any) => {
        const a = d.amazon;
        return (
          <>
            <Grid cols={4}>
              <Kpi highlight tone="main" label={t('kpiAmzTotal')} value={short(a.total)} sub={t('amzSub', { n: num(a.n), p: pct(share(a.total, d.ar.total)) })} />
              <Kpi tone="green" label={t('kpiNotDue')} value={short(a.notDue)} sub={t('notDueSub', { p: pct(share(a.notDue, a.total)), months: a.dueNext.map((m: any) => monthName(m.key, 'short')).join(', ') })} />
              <Kpi tone="amber" label={t('kpiOverdueNet')} value={short(a.overdue)} sub={t('overdueNetSub')} />
              <Kpi tone="amber" label={t('kpiOld')} value={num(a.old.n)} sub={t('oldSub', { a: short(a.old.pos), b: short(a.old.neg) })} />
            </Grid>
            <Grid>
              <Card title={t('ageChart')} sub={t('ageSub')}>
                <BarChart fmt={fmt} stacked legend labels={a.age.map((b: any) => t(`age_${b.b}` as any))}
                  datasets={[
                    { label: t('invoicesCharges'), data: a.age.map((b: any) => b.pos), color: C.navy },
                    { label: t('creditsDeductions'), data: a.age.map((b: any) => b.neg), color: C.magenta },
                  ]} />
              </Card>
              <Card title={t('byEntityAmz')}>
                <Table
                  cols={[{ label: t('entity'), wide: true }, { label: t('open'), align: 'right', mono: true }, { label: t('notDue'), align: 'right', mono: true, hideMobile: true }, { label: t('overdueNet'), align: 'right', mono: true }, { label: t('items'), align: 'right', mono: true, hideMobile: true }]}
                  rows={a.ents.map((e: any) => [e.e, eur(e.tot), eur(e.nv), <Neg key="o" v={e.ov} text={eur(e.ov)} />, num(e.n)])}
                  total={[t('total'), eur(a.total), eur(a.notDue), eur(a.overdue), num(a.n)]}
                />
              </Card>
            </Grid>
            <Grid>
              <Card title={t('byDocType')}>
                <Table
                  cols={[{ label: t('type') }, { label: t('amount'), align: 'right', mono: true }, { label: t('items'), align: 'right', mono: true }]}
                  rows={a.dt.map((x: any) => [t(`dt_${x.t}` as any), <Neg key="a" v={x.amt} text={eur(x.amt)} />, num(x.n)])}
                  total={[t('total'), eur(a.total), num(a.n)]}
                />
              </Card>
              <Card title={t('byPM')}>
                <Table
                  cols={[{ label: t('paymentMethod') }, { label: t('amount'), align: 'right', mono: true }, { label: '%', align: 'right', mono: true }, { label: t('items'), align: 'right', mono: true }]}
                  rows={a.pm.map((p: any) => [pmName(fmt, p.pm), eur(p.amt), pct(share(p.amt, a.total)), num(p.n)])}
                />
              </Card>
            </Grid>
          </>
        );
      }}</Block>
    </Section>
  );
}

export function MarkantSection({ fmt, ar, cf }: { fmt: Fmt; ar: Loaded; cf: Loaded }) {
  const { t, eur, short, pct, date, num } = fmt;
  return (
    <Section title={t('mkTitle')} source={ar.data ? t('mkSource', { date: date(ar.data.date) }) : undefined}>
      <Block state={ar} fmt={fmt}>{(d: any) => {
        const m = d.markant;
        // Próximas fechas confirmadas en BC frente a lo previsto en el cashflow para esas fechas
        const upcoming = m.sched.filter((s: any) => s.key >= d.date).slice(0, 10);
        const cfByDate = new Map<string, number>((cf.data?.markant || []).map((x: any) => [x.date, x.amount]));
        return (
          <>
            <Grid cols={3}>
              <Kpi highlight tone="main" label={t('kpiMk1')} value={short(m.total)} sub={t('nPct', { n: num(m.n), p: pct(share(m.total, d.ar.total)) })} />
              <Kpi tone="green" label={t('kpiMk2')} value={short(m.conf)} sub={t('nPct', { n: num(m.nConf), p: pct(share(m.conf, m.total)) })} />
              <Kpi tone="amber" label={t('kpiMk3')} value={short(m.unconf)} sub={t('nPct', { n: num(m.nUnconf), p: pct(share(m.unconf, m.total)) })} />
            </Grid>
            <Grid>
              <Card title={t('mkChart')} sub={t('mkChartSub')}>
                <BarChart fmt={fmt} legend labels={upcoming.map((s: any) => fmt.date(s.key))}
                  datasets={[
                    { label: t('confirmedLedger'), data: upcoming.map((s: any) => s.amt), color: C.navy },
                    { label: t('forecastCashflow'), data: upcoming.map((s: any) => cfByDate.get(s.key) || 0), color: C.amber },
                  ]} />
              </Card>
              <Card title={t('unconfTop')}>
                <Table
                  cols={[{ label: t('customer'), wide: true }, { label: t('kpiMk3').replace(/^3 · /, ''), align: 'right', mono: true }, { label: '%', align: 'right', mono: true }]}
                  rows={m.unconfTop.map((c: any) => [c.key, eur(c.amt), pct(share(c.amt, m.unconf))])}
                  total={[t('totalUnconf'), eur(m.unconf), pct(100)]}
                />
              </Card>
            </Grid>
          </>
        );
      }}</Block>
    </Section>
  );
}

// ---------- Proveedores ----------

export function PayablesSection({ fmt, ap }: { fmt: Fmt; ap: Loaded }) {
  const { t, eur, short, pct, date, num, monthName } = fmt;
  return (
    <Section title={t('apTitle')} source={ap.data ? t('apSource', { date: date(ap.data.date) }) : undefined}>
      <Block state={ap} fmt={fmt}>{(d: any) => {
        const c = d.china;
        return (
          <>
            <Grid cols={4}>
              <Kpi highlight tone="main" label={t('kpiAp')} value={short(d.ap.total)} sub={`${num(d.ap.n)} ${t('items')}`} />
              <Kpi label={t('kpiCn1')} value={short(c.total)} sub={t('cnSub1', { n: num(c.n), p: pct(share(c.total, d.ap.total)) })} />
              <Kpi tone="green" label={t('kpiCn2')} value={short(c.conf)} sub={t('nInvPct', { n: num(c.nConf), p: pct(share(c.conf, c.total)) })} />
              <Kpi tone="red" label={t('kpiCn3')} value={short(c.unconf)} sub={t('nInvPct', { n: num(c.nUnconf), p: pct(share(c.unconf, c.total)) })} />
            </Grid>
            <Grid>
              <Card title={t('byPM')}>
                <Table
                  cols={[{ label: t('paymentMethod') }, { label: t('pending'), align: 'right', mono: true }, { label: '%', align: 'right', mono: true }, { label: t('overdueAtCol', { date: fmt.shortDate(d.date) }), align: 'right', mono: true }, { label: t('items'), align: 'right', mono: true, hideMobile: true }]}
                  rows={d.ap.byPM.map((p: any) => [pmName(fmt, p.pm), eur(p.amt), pct(share(p.amt, d.ap.total)), eur(p.od), num(p.n)])}
                  total={[t('total'), eur(d.ap.total), pct(100), eur(d.ap.overdue), num(d.ap.n)]}
                />
              </Card>
              <Card title={t('cnDueChart')} sub={t('cnDueSub', { date: fmt.shortDate(d.date) })}>
                <BarChart fmt={fmt} labels={c.byDue.map((x: any) => monthName(x.key, 'short'))}
                  datasets={[{ data: c.byDue.map((x: any) => x.amt), color: c.byDue.map((x: any) => (x.overdue ? C.red : C.navy)) }]} />
              </Card>
            </Grid>
            <Grid>
              <Card title={t('cnSched')}>
                <Table
                  cols={[{ label: t('schedDate'), mono: true }, { label: t('amount'), align: 'right', mono: true }]}
                  rows={c.sched.map((s: any) => [date(s.key), eur(s.amt)])}
                  total={[t('totalScheduled'), eur(c.conf)]}
                />
              </Card>
              <Card title={t('cnByVendor')}>
                <Table
                  cols={[{ label: t('vendor') }, { label: t('open'), align: 'right', mono: true }, { label: '%', align: 'right', mono: true }]}
                  rows={c.byVendor.map((v: any) => [v.key, eur(v.amt), pct(share(v.amt, c.total))])}
                />
              </Card>
            </Grid>
          </>
        );
      }}</Block>
    </Section>
  );
}

// ---------- Provisiones ----------

export function ProvisionsSection({ fmt, prov, month }: { fmt: Fmt; prov: Loaded; month: string }) {
  const { t, eur, short, pct, date, num, monthName } = fmt;
  const monthOnly = fmt.monthOnly(month);
  return (
    <Section title={t('provTitle', { year: month.substring(0, 4), month: monthOnly })} source={t('provSource')}>
      <Block state={prov} fmt={fmt}>{(d: any) => (
        <>
          <Grid cols={4}>
            <Kpi label={t('kpiProvOrig')} value={short(d.orig)} sub={t('nEntries', { n: d.n })} />
            <Kpi label={t('kpiConsumed')} value={short(d.cons)} sub={t('consumedSub', { p: pct(share(d.cons, d.orig)) })} />
            <Kpi highlight tone="main" label={t('kpiOpen')} value={short(d.open)} sub={t('openSub', { p: pct(share(d.open, d.orig)) })} />
            <Kpi label={t('kpiMonthProv', { month: monthOnly })} value={short(d.month.orig)} sub={t('monthOpenSub', { v: short(d.month.open) })} />
          </Grid>
          <Grid>
            <Card title={t('byProvType')}>
              <BarChart fmt={fmt} stacked legend labels={d.byType.map((x: any) => t(`pt_${x.t}` as any))}
                datasets={[
                  { label: t('kpiConsumed'), data: d.byType.map((x: any) => x.cons), color: C.navy },
                  { label: t('kpiOpen'), data: d.byType.map((x: any) => x.open), color: C.magenta },
                ]} />
            </Card>
            <Card title={t('typeSummary')}>
              <Table
                cols={[{ label: t('type') }, { label: t('original'), align: 'right', mono: true }, { label: t('kpiConsumed'), align: 'right', mono: true }, { label: t('kpiOpen'), align: 'right', mono: true }, { label: t('pctConsumed'), align: 'right', mono: true }]}
                rows={d.byType.map((x: any) => [t(`pt_${x.t}` as any), eur(x.orig), eur(x.cons), eur(x.open), pct(share(x.cons, x.orig))])}
                total={[t('total'), eur(d.orig), eur(d.cons), eur(d.open), pct(share(d.cons, d.orig))]}
              />
            </Card>
          </Grid>
          <details className="rpt-card bg-white rounded-xl border border-gray-200 p-4">
            <summary className="text-sm font-semibold text-gray-900 cursor-pointer">{t('provDetail')} ({num(d.n)})</summary>
            <div className="mt-3 overflow-x-auto">
              <Table
                cols={[{ label: t('document'), mono: true }, { label: t('date'), mono: true }, { label: t('description'), wide: true }, { label: t('type'), hideMobile: true }, { label: t('original'), align: 'right', mono: true }, { label: t('kpiConsumed'), align: 'right', mono: true }, { label: t('kpiOpen'), align: 'right', mono: true }]}
                rows={d.rows.map((r: any) => [r.doc, date(r.date), r.desc, t(`pt_${r.t}` as any), eur(r.orig), eur(r.cons), eur(r.open)])}
                total={[t('total'), '', '', '', eur(d.orig), eur(d.cons), eur(d.open)]}
              />
            </div>
          </details>
        </>
      )}</Block>
    </Section>
  );
}

// ---------- BWA ----------

const KEY_LINES = ['1020', '1051', '1080', '1280', '1300', '1302', '1380'];
const colLabel = (fmt: Fmt, c: string) =>
  c === 'CRAZE Intercompany' ? fmt.t('col_interco') : c === 'CRAZE Consolidated' ? fmt.t('col_consol')
    : c.replace(/^craze\s*/i, '').replace('Entertainment', 'Entert.').replace(' SL', '') || c;

export function BwaSection({ fmt, bwa, company, month }: { fmt: Fmt; bwa: Loaded; company: string; month: string }) {
  const { t, eur, short, pct, monthName } = fmt;
  const [period, setPeriod] = useState<'ytd' | 'month'>('ytd');
  const [col, setCol] = useState<string | null>(null);
  const monthOnly = fmt.monthOnly(month);
  return (
    <Section title={t('bwaTitle')} source={bwa.data ? t('bwaSource', { gbp: fmt.num(bwa.data.rates.GBP, 4), chf: fmt.num(bwa.data.rates.CHF, 4) }) : undefined}>
      <Block state={bwa} fmt={fmt}>{(d: any) => {
        const companyCols: string[] = d.columns.filter((c: string) => !c.startsWith('CRAZE Intercompany') && !c.startsWith('CRAZE Consolidated'));
        const selected = col || (d.columns.includes(company) ? company : 'CRAZE');
        const salesOf = (c: string, f: 'ytd' | 'month' | 'prevYtd') => d.lines.find((l: any) => l.code === '1020')?.values[c]?.[f] || 0;
        const showConsolidated = company.toUpperCase() === 'CRAZE' || company === 'ALL';
        const yoyCompany = d.columns.includes(company) ? company : 'CRAZE';
        return (
          <>
            {showConsolidated && (
              <Card title={t('consolidated')} sub={t('ytdTo', { month: monthOnly })}>
                <Table
                  cols={[{ label: '' }, ...d.columns.map((c: string) => ({ label: colLabel(fmt, c), align: 'right' as const, mono: true }))]}
                  rows={d.lines.filter((l: any) => KEY_LINES.includes(l.code)).map((l: any) =>
                    [<span key="l" className={l.code === '1380' ? 'font-bold' : ''}>{l.description}</span>, ...d.columns.map((c: string) => <Neg key={c} v={l.values[c].ytd} text={short(l.values[c].ytd)} />)])}
                />
              </Card>
            )}
            <div className="rpt-noprint flex flex-wrap gap-2">
              {(['ytd', 'month'] as const).map(p => (
                <button key={p} onClick={() => setPeriod(p)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${period === p ? 'bg-[#24305E] text-white border-[#24305E]' : 'bg-white text-gray-700 border-gray-300'}`}>
                  {p === 'ytd' ? t('periodYtd', { month: monthOnly }) : t('periodMonth', { month: monthName(month) })}
                </button>
              ))}
            </div>
            <div className="rpt-noprint flex flex-wrap gap-2">
              {[...companyCols, 'CRAZE Intercompany'].map(c => (
                <button key={c} onClick={() => setCol(c)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${selected === c ? 'bg-[#24305E] text-white border-[#24305E]' : 'bg-white text-gray-700 border-gray-300'}`}>{c}</button>
              ))}
            </div>
            <Card title={selected} sub={`· ${period === 'ytd' ? t('periodYtd', { month: monthOnly }) : t('periodMonth', { month: monthName(month) })}`}>
              <Table
                cols={[{ label: t('bwaLine') }, { label: t('amount'), align: 'right', mono: true }, { label: t('pctSales'), align: 'right', mono: true }]}
                rowClass={i => (d.lines[i].bold ? 'bg-gray-100 font-semibold' : '')}
                rows={d.lines.map((l: any) => {
                  const v = l.values[selected]?.[period] || 0;
                  return [l.description, <Neg key="v" v={v} text={eur(v)} />, pct(share(v, salesOf(selected, period)))];
                })}
              />
            </Card>
            <Card title={t('yoyTitle', { company: yoyCompany })} sub={t('yoySub', { month: monthOnly })}>
              <Table
                cols={[{ label: '' }, { label: month.substring(0, 4), align: 'right', mono: true }, { label: String(Number(month.substring(0, 4)) - 1), align: 'right', mono: true }, { label: 'Δ', align: 'right', mono: true }, { label: 'Δ %', align: 'right', mono: true }]}
                rowClass={i => (d.lines[i].bold ? 'bg-gray-100 font-semibold' : '')}
                rows={d.lines.map((l: any) => {
                  const cur = l.values[yoyCompany]?.ytd || 0;
                  const prev = l.values[yoyCompany]?.prevYtd || 0;
                  const delta = cur - prev;
                  return [l.description, <Neg key="c" v={cur} text={short(cur)} />, <Neg key="p" v={prev} text={short(prev)} />,
                    <Signed key="d" v={delta} text={(delta > 0 ? '+' : '') + short(delta)} />,
                    <Signed key="dp" v={delta} text={prev ? pct(share(delta, Math.abs(prev))) : '–'} />];
                })}
              />
            </Card>
          </>
        );
      }}</Block>
    </Section>
  );
}

// ---------- Cashflow ----------

const CATS = ['markant', 'customers', 'china', 'paymentRuns', 'customs', 'banks', 'otherOut'] as const;

export function CashflowSection({ fmt, cf, company }: { fmt: Fmt; cf: Loaded; company: string }) {
  const { t, eur, short, date, monthName } = fmt;
  return (
    <Section title={t('cfTitle', { company })} source={cf.data ? t('cfSource', { date: date(cf.data.today), limit: short(cf.data.limit) }) : undefined}>
      <Block state={cf} fmt={fmt}>{(d: any) => {
        const below = d.min.balance - d.limit;
        const months = d.months.slice(0, 6);
        return (
          <>
            <Grid cols={4}>
              <Kpi tone={d.start.balance < 0 ? 'red' : 'neutral'} label={t('kpiStart', { date: fmt.shortDate(d.start.date) })} value={short(d.start.balance)} sub={t('marginToLimit', { v: short(d.start.balance - d.limit) })} />
              <Kpi tone={below < 0 ? 'red' : 'neutral'} label={t('kpiMin')} value={short(d.min.balance)} sub={below < 0 ? t('minOver', { date: date(d.min.date), v: short(-below) }) : t('minWithin', { date: date(d.min.date) })} />
              <Kpi highlight tone={d.end.balance < d.limit ? 'main' : 'neutral'} label={t('kpiEnd', { date: fmt.shortDate(d.end.date) })} value={short(d.end.balance)} />
              <Kpi label={t('kpiBreach', { limit: short(d.limit) })} value={String(d.breachDays)}
                sub={d.breaches.length ? d.breaches.slice(0, 3).map((b: any) => `${fmt.shortDate(b.from)}–${fmt.shortDate(b.to)}`).join(' · ') : t('noBreach')} />
            </Grid>
            <Card title={t('cfChart')}>
              <StepLineChart fmt={fmt} labels={d.series.map((p: any) => fmt.shortDate(p.date))} values={d.series.map((p: any) => p.balance)}
                limit={d.limit} limitLabel={t('limitL', { limit: short(d.limit) })} valueLabel={t('balanceL')} />
            </Card>
            <Card title={t('cfTable')}>
              <Table
                cols={[{ label: t('block') }, ...months.map((m: any) => ({ label: monthName(m.month, 'short'), align: 'right' as const, mono: true }))]}
                rows={CATS.filter(c => months.some((m: any) => Math.abs(m[c]) >= 1)).map(c => [t(`cat_${c}` as any), ...months.map((m: any) => (Math.abs(m[c]) >= 1 ? <Neg key={m.month} v={m[c]} text={short(m[c])} /> : '–'))])}
                total={[t('netFlow'), ...months.map((m: any) => { const net = CATS.reduce((s, c) => s + m[c], 0); return <Neg key={m.month} v={net} text={short(net)} />; })]}
              />
            </Card>
          </>
        );
      }}</Block>
    </Section>
  );
}

export default function ManagementView({ fmt, month, company, ar, ap, prov, bwa, cf }: {
  fmt: Fmt; month: string; company: string; ar: Loaded; ap: Loaded; prov: Loaded; bwa: Loaded; cf: Loaded;
}) {
  return (
    <div className="space-y-10">
      <ReceivablesSection fmt={fmt} ar={ar} />
      <AmazonSection fmt={fmt} ar={ar} />
      <MarkantSection fmt={fmt} ar={ar} cf={cf} />
      <PayablesSection fmt={fmt} ap={ap} />
      <ProvisionsSection fmt={fmt} prov={prov} month={month} />
      <BwaSection fmt={fmt} bwa={bwa} company={company} month={month} />
      <CashflowSection fmt={fmt} cf={cf} company={company} />
    </div>
  );
}
