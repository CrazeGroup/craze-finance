'use client';

import { useEffect, useState } from 'react';
import type { Fmt } from './i18n';
import { Card, ErrorBox, Grid, Kpi, Loading, Section, Table } from './ui';
import type { Loaded } from './OperationalView';
import { ProvisionsSection } from './ManagementView';

// Pestaña Provision: la tabla de provisiones del reporting (G/L PROV-) y la provisión de condiciones y marketing
// por Customer Group de la LM de BC, con su propio rango de fechas.
const iso = (d: Date) => d.toISOString().substring(0, 10);
const store = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

function LmProvisionsSection({ fmt, month, company, reload }: { fmt: Fmt; month: string; company: string; reload: { n: number; force: boolean } }) {
  const { t, pct, date, num } = fmt;
  // Por defecto: del 1 de enero al último día del mes del reporting
  const defaults = () => {
    const [y, m] = month.split('-').map(Number);
    return { from: `${y}-01-01`, to: iso(new Date(Date.UTC(y, m, 0))) };
  };
  const [range, setRange] = useState(() => {
    const saved = store.get('crz-lmprov-range');
    try { if (saved) return JSON.parse(saved) as { from: string; to: string }; } catch { /* ignorar */ }
    return defaults();
  });
  const [state, setState] = useState<Loaded>({ data: null, loading: true, error: null });

  const change = (k: 'from' | 'to', v: string) => {
    const next = { ...range, [k]: v };
    setRange(next);
    store.set('crz-lmprov-range', JSON.stringify(next));
  };

  useEffect(() => {
    if (!range.from || !range.to || range.from > range.to) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetch(`/api/reporting/lm-provisions?from=${range.from}&to=${range.to}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json();
        if (cancelled) return;
        setState(res.ok && !data.error ? { data, loading: false, error: null } : { data: null, loading: false, error: data.error || `HTTP ${res.status}` });
      })
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [range.from, range.to, company, reload]);

  const d: any = state.data;
  const money = (v: number) => new Intl.NumberFormat(fmt.locale, { style: 'currency', currency: d?.currency || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0);
  const share = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);

  return (
    <Section title={t('lmProvTitle')} source={t('lmProvSource', { from: date(range.from), to: date(range.to), cur: d?.currency || '' })}>
      <div className="rpt-noprint flex flex-wrap items-end gap-4">
        {(['from', 'to'] as const).map(k => (
          <label key={k} className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {t(k === 'from' ? 'dateFrom' : 'dateTo')}
            <input type="date" value={range[k]} onChange={e => change(k, e.target.value)}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal" />
          </label>
        ))}
        <button onClick={() => { const r = defaults(); setRange(r); store.set('crz-lmprov-range', JSON.stringify(r)); }}
          className="text-xs text-gray-500 hover:text-gray-900 underline pb-2">{fmt.monthName(month)}: 01.01 → {date(defaults().to)}</button>
      </div>
      {range.from > range.to ? <ErrorBox message={t('dateFrom') + ' > ' + t('dateTo')} />
        : state.error ? <ErrorBox message={state.error} />
        : state.loading || !d ? <Loading text={t('loading')} />
        : !d.rows.length ? <p className="text-sm text-gray-500">{t('noData')}</p>
        : (
          <>
            <Grid cols={4}>
              <Kpi label={t('provConditions')} value={money(d.total.conditions)} sub={`${pct(share(d.total.conditions, d.total.turnover))} · ${t('turnover')} ${money(d.total.turnover)}`} />
              <Kpi label={t('provMarketing')} value={money(d.total.marketing)} sub={pct(share(d.total.marketing, d.total.turnover))} />
              <Kpi label={t('pt_amazon')} value={money(d.total.amazon)} sub={pct(share(d.total.amazon, d.total.turnover))} />
              <Kpi highlight tone="main" label={t('provTotal')} value={money(d.total.total)} sub={pct(share(d.total.total, d.total.turnover))} />
            </Grid>
            <Card>
              <div className="overflow-x-auto">
                <Table
                  cols={[
                    { label: t('customerGroup'), wide: true }, { label: t('turnover'), align: 'right', mono: true },
                    { label: t('provConditions'), align: 'right', mono: true }, { label: t('pctTurnover'), align: 'right', mono: true, hideMobile: true },
                    { label: t('provMarketing'), align: 'right', mono: true }, { label: t('pctTurnover'), align: 'right', mono: true, hideMobile: true },
                    { label: t('pt_amazon'), align: 'right', mono: true },
                    { label: t('provTotal'), align: 'right', mono: true },
                  ]}
                  rows={d.rows.map((r: any) => [
                    <span title={`${num(r.lines)} líneas · ${r.customerCount} clientes`}><span className="font-mono">{r.group}</span>{r.customer && <span className="text-gray-500"> · {r.customer}{r.customerCount > 1 ? ` +${r.customerCount - 1}` : ''}</span>}</span>, money(r.turnover),
                    money(r.conditions), pct(share(r.conditions, r.turnover)),
                    money(r.marketing), pct(share(r.marketing, r.turnover)),
                    money(r.amazon), money(r.total),
                  ])}
                  total={[t('total'), money(d.total.turnover), money(d.total.conditions), pct(share(d.total.conditions, d.total.turnover)),
                    money(d.total.marketing), pct(share(d.total.marketing, d.total.turnover)), money(d.total.amazon), money(d.total.total)]}
                />
              </div>
            </Card>
          </>
        )}
    </Section>
  );
}

export default function ProvisionView({ fmt, month, company, prov, reload }: {
  fmt: Fmt; month: string; company: string; prov: Loaded; reload: { n: number; force: boolean };
}) {
  return (
    <div className="space-y-10">
      <ProvisionsSection fmt={fmt} prov={prov} month={month} />
      <LmProvisionsSection fmt={fmt} month={month} company={company} reload={reload} />
    </div>
  );
}
