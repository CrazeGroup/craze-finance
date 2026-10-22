'use client';

import CompanySelect, { useReportCompany } from './CompanySelect';
import { useEffect, useMemo, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import type { Fmt } from '../reporting/i18n';
import { Card, ErrorBox, Grid, Kpi, Loading, Section, Table } from '../reporting/ui';
import { parsePl, type PlFile, type PlRow } from '@/lib/controlling/plParse';

// Controlling · Comparación de BWA (Profit & Loss) entre dos periodos a partir de dos Excel subidos.
// Signo normalizado: ingresos +, gastos −. Se comparan los meses marcados (por defecto, los que tienen datos en los
// dos ficheros), cada fila con su % sobre la fila de referencia elegida (venta neta / total) de su fichero.
type Slot = 'A' | 'B';
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');

// Equivalencias entre la BWA de DATEV y la BWA del grupo (se pueden cambiar en la tabla)
const SYNONYMS = [
  ['salesrevenues', 'umsatzerlöse'], ['costofgoodssoldcogs', 'materialwareneinkauf'], ['grossmargin', 'rohertrag'],
  ['personnelexpenses', 'personalkosten'], ['marketingexpenses', 'werbereisekosten'], ['logisticexpenses', 'kostenwarenabgabe'],
  ['otherexpenses', 'sonstigekosten'], ['totaloperatingexpenses', 'gesamtkosten'], ['depreciationsamortisations', 'abschreibungen'],
  ['ebit', 'betriebsergebnis'], ['netincome', 'vorläufigesergebnis'], ['financialnonoperational', 'neutraleraufwand'],
];
// Filas de totales / resultados: no entran en el ranking de partidas de gasto
const TOTAL = /total|gesamt|ergebnis|ebit|margin|rohertrag|income|leistung|turnover|revenue|umsatz/i;

const defaultRef = (f: PlFile) =>
  (f.rows.find(r => /^net turnover$/i.test(r.label)) || f.rows.find(r => /umsatzerl|sales revenue|revenue|ventas|net sales/i.test(r.label)) || f.rows[0]).label;

function autoMatch(b: PlRow, a: PlFile): string {
  const nb = norm(b.label);
  const exact = a.rows.find(r => norm(r.label) === nb);
  if (exact) return exact.label;
  const pair = SYNONYMS.find(p => p.includes(nb));
  const other = pair?.find(x => x !== nb);
  return (other && a.rows.find(r => norm(r.label) === other)?.label) || '';
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

export default function PlCompareView({ fmt, company: globalCompany }: { fmt: Fmt; company: string }) {
  const [company, setCompany] = useReportCompany(globalCompany, false);
  const { num, pct, date } = fmt;
  const [files, setFiles] = useState<Record<Slot, PlFile | null>>({ A: null, B: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [months, setMonths] = useState<boolean[]>(Array(12).fill(true));
  const [ref, setRef] = useState<Record<Slot, string>>({ A: '', B: '' });
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const mapKey = `crz-pl-map:${company}`;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/controlling/pl?company=${encodeURIComponent(company)}`, { cache: 'no-store' }).then(r => r.json()).then(d => {
      if (cancelled) return;
      setFiles({ A: d.A || null, B: d.B || null });
      try { setMapping(JSON.parse(store.get(mapKey) || '{}')); } catch { setMapping({}); }
    }).catch(e => !cancelled && setError(e.message)).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [company, mapKey]);

  // Meses por defecto: los que tienen datos en los dos ficheros; referencia por defecto: venta neta
  useEffect(() => {
    const { A, B } = files;
    if (A && B) setMonths(A.months.map((m, i) => m && B.months[i]));
    else if (A || B) setMonths((A || B)!.months);
    setRef({ A: A ? defaultRef(A) : '', B: B ? defaultRef(B) : '' });
  }, [files]);

  const upload = async (slot: Slot, file: File) => {
    setError(null);
    try {
      const parsed = parsePl(await file.arrayBuffer(), file.name);
      const res = await fetch(`/api/controlling/pl?company=${encodeURIComponent(company)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot, file: parsed }) });
      const r = await res.json();
      if (!res.ok || r.error) throw new Error(r.error || `HTTP ${res.status}`);
      setFiles(f => ({ ...f, [slot]: parsed }));
    } catch (e: any) {
      setError(`${file.name}: ${e.message}`);
    }
  };
  const remove = async (slot: Slot) => {
    await fetch(`/api/controlling/pl?company=${encodeURIComponent(company)}&slot=${slot}`, { method: 'DELETE' });
    setFiles(f => ({ ...f, [slot]: null }));
  };
  const setMap = (bLabel: string, aLabel: string) => {
    const next = { ...mapping, [bLabel]: aLabel };
    setMapping(next);
    store.set(mapKey, JSON.stringify(next));
  };

  const sum = (r: PlRow | undefined) => (r ? r.values.reduce((s: number, v, i) => s + (months[i] && v ? v : 0), 0) : 0);
  const label = (f: PlFile | null, slot: Slot) => (f ? `${f.year ?? ''} ${slot === 'A' ? '(base)' : ''}`.trim() : slot);

  const analysis = useMemo(() => {
    const { A, B } = files;
    if (!A || !B) return null;
    const refA = sum(A.rows.find(r => r.label === ref.A)), refB = sum(B.rows.find(r => r.label === ref.B));
    const used = new Set<string>();
    const rows = B.rows.map(b => {
      const aLabel = b.label in mapping ? mapping[b.label] : autoMatch(b, A);
      const a = A.rows.find(r => r.label === aLabel);
      if (a) used.add(a.label);
      const va = a ? sum(a) : null, vb = sum(b);
      return {
        b: b.label, a: aLabel, va, vb, pa: va !== null && refA ? (va / refA) * 100 : null, pb: refB ? (vb / refB) * 100 : null,
        diff: va !== null ? vb - va : null, diffPct: va ? ((vb - va) / Math.abs(va)) * 100 : null,
      };
    });
    const onlyA = A.rows.filter(r => !used.has(r.label)).map(r => ({ label: r.label, va: sum(r), pa: refA ? (sum(r) / refA) * 100 : null }));
    // Partidas de gasto (importe negativo, no totales) que más suben / bajan
    const expenses = rows.filter(r => r.va !== null && (r.vb < 0 || (r.va as number) < 0) && !TOTAL.test(r.b) && !TOTAL.test(r.a))
      .map(r => ({ ...r, costIncrease: -(r.diff as number) }));
    return {
      refA, refB, rows, onlyA,
      up: expenses.filter(e => e.costIncrease > 0.5).sort((x, y) => y.costIncrease - x.costIncrease).slice(0, 10),
      down: expenses.filter(e => e.costIncrease < -0.5).sort((x, y) => x.costIncrease - y.costIncrease).slice(0, 10),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, months, ref, mapping]);

  const amt = (v: number | null) => (v === null ? '–' : num(v));
  const signed = (v: number | null, suffix = '') => (v === null ? '–' : <span className={v < 0 ? 'text-[#C0392B]' : v > 0 ? 'text-[#1E7F4F]' : ''}>{v > 0 ? '+' : ''}{suffix === '%' ? pct(v) : suffix === 'pp' ? `${num(v, 1)} pp` : num(v)}</span>);
  const monthText = MONTHS.filter((_, i) => months[i]).join(', ') || 'ningún mes';

  if (loading) return <Loading text="Cargando…" />;

  return (
    <Section title="Comparación de BWA año a año" source={`Excel Profit & Loss subidos · ${company} · meses comparados: ${monthText}`}>
      <div className="flex"><CompanySelect value={company} onChange={setCompany} allowConsolidated={false} /></div>
      <Grid>
        {(['A', 'B'] as Slot[]).map(slot => {
          const f = files[slot];
          return (
            <Card key={slot} title={slot === 'A' ? 'Periodo base' : 'Periodo a comparar'} sub={f ? `${f.name} · ${f.format === 'datev' ? 'BWA DATEV' : 'BWA'} ${f.year ?? ''} · ${f.rows.length} filas · subido ${date(f.uploadedAt)}` : 'Sin fichero'}>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black">
                  <Upload size={15} /> {f ? 'Sustituir Excel' : 'Subir Excel'}
                  <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) upload(slot, file); e.target.value = ''; }} />
                </label>
                {f && (
                  <button onClick={() => remove(slot)} className="text-gray-500 hover:text-[#C0392B] flex items-center gap-1 text-sm"><Trash2 size={14} /> Quitar</button>
                )}
                {f && <span className="text-xs text-gray-500">Meses con datos: {MONTHS.filter((_, i) => f.months[i]).join(' ')}</span>}
              </div>
            </Card>
          );
        })}
      </Grid>
      {error && <ErrorBox message={error} />}

      {!analysis ? (
        <p className="text-sm text-gray-500">Sube los dos Excel de Profit & Loss (BWA) para ver la comparación.</p>
      ) : (
        <>
          <div className="rpt-card bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap items-end gap-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">Meses a comparar</p>
              <div className="flex flex-wrap gap-1">
                {MONTHS.map((m, i) => (
                  <button key={m} onClick={() => setMonths(ms => ms.map((x, j) => (j === i ? !x : x)))}
                    className={`px-2 py-1 rounded-md text-xs font-semibold border ${months[i] ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-500 border-gray-300'}`}>{m}</button>
                ))}
              </div>
            </div>
            {(['A', 'B'] as Slot[]).map(slot => (
              <label key={slot} className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                % sobre ({label(files[slot], slot)})
                <select value={ref[slot]} onChange={e => setRef(r => ({ ...r, [slot]: e.target.value }))}
                  className="block mt-1 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal">
                  {files[slot]!.rows.map(r => <option key={r.label} value={r.label}>{r.label}</option>)}
                </select>
              </label>
            ))}
          </div>

          <Grid cols={4}>
            <Kpi label={`${ref.A} ${label(files.A, 'A')}`} value={num(analysis.refA)} />
            <Kpi label={`${ref.B} ${label(files.B, 'B')}`} value={num(analysis.refB)} />
            <Kpi tone="main" highlight label="Variación referencia" value={`${analysis.refB - analysis.refA > 0 ? '+' : ''}${num(analysis.refB - analysis.refA)}`}
              sub={analysis.refA ? pct(((analysis.refB - analysis.refA) / Math.abs(analysis.refA)) * 100) : undefined} />
            <Kpi label="Partidas de gasto que suben" value={String(analysis.up.length)} sub={`${num(analysis.up.reduce((s, e) => s + e.costIncrease, 0))} más de gasto`} />
          </Grid>

          <Grid>
            <Card title="Principales aumentos de gasto" sub={`${label(files.B, 'B')} frente a ${label(files.A, 'A')}`}>
              {analysis.up.length ? (
                <Table cols={[{ label: 'Partida', wide: true }, { label: 'Base', align: 'right', mono: true }, { label: 'Comparado', align: 'right', mono: true }, { label: 'Más gasto', align: 'right', mono: true }, { label: '%', align: 'right', mono: true }]}
                  rows={analysis.up.map(e => [e.b, amt(-(e.va as number)), amt(-e.vb), <span key="d" className="text-[#C0392B]">+{num(e.costIncrease)}</span>, e.va ? pct((e.costIncrease / Math.abs(e.va)) * 100) : '–'])} />
              ) : <p className="text-sm text-gray-500">Ninguna partida de gasto sube.</p>}
            </Card>
            <Card title="Principales reducciones de gasto" sub={`${label(files.B, 'B')} frente a ${label(files.A, 'A')}`}>
              {analysis.down.length ? (
                <Table cols={[{ label: 'Partida', wide: true }, { label: 'Base', align: 'right', mono: true }, { label: 'Comparado', align: 'right', mono: true }, { label: 'Menos gasto', align: 'right', mono: true }]}
                  rows={analysis.down.map(e => [e.b, amt(-(e.va as number)), amt(-e.vb), <span key="d" className="text-[#1E7F4F]">{num(e.costIncrease)}</span>])} />
              ) : <p className="text-sm text-gray-500">Ninguna partida de gasto baja.</p>}
            </Card>
          </Grid>

          <Card title="Cuenta de resultados comparada" sub="Ingresos en positivo, gastos en negativo · la columna «Fila base» empareja cada fila con la del otro Excel (se recuerda en este navegador)">
            <div className="overflow-x-auto">
              <Table
                cols={[
                  { label: 'Concepto', wide: true }, { label: 'Fila base', wide: true },
                  { label: `Base ${label(files.A, 'A')}`, align: 'right', mono: true }, { label: '% base', align: 'right', mono: true },
                  { label: `${label(files.B, 'B')}`, align: 'right', mono: true }, { label: '%', align: 'right', mono: true },
                  { label: 'Diferencia', align: 'right', mono: true }, { label: 'Dif. %', align: 'right', mono: true }, { label: 'Dif. pp', align: 'right', mono: true },
                ]}
                rowClass={i => (TOTAL.test(analysis.rows[i].b) ? 'font-semibold bg-gray-50' : '')}
                rows={analysis.rows.map(r => [
                  r.b,
                  <select key="m" value={r.a} onChange={e => setMap(r.b, e.target.value)} className="border border-gray-200 rounded px-1 py-0.5 text-xs bg-white max-w-[200px]">
                    <option value="">— sin equivalente —</option>
                    {files.A!.rows.map(x => <option key={x.label} value={x.label}>{x.label}</option>)}
                  </select>,
                  amt(r.va), r.pa === null ? '–' : pct(r.pa), amt(r.vb), r.pb === null ? '–' : pct(r.pb),
                  signed(r.diff), r.diffPct === null ? '–' : signed(r.diffPct, '%'), r.pa === null || r.pb === null ? '–' : signed(r.pb - r.pa, 'pp'),
                ])}
              />
            </div>
          </Card>
          {analysis.onlyA.length > 0 && (
            <details className="rpt-card bg-white rounded-xl border border-gray-200 p-4">
              <summary className="text-sm font-semibold text-gray-900 cursor-pointer">Filas del periodo base sin equivalente ({analysis.onlyA.length})</summary>
              <div className="mt-3">
                <Table cols={[{ label: 'Concepto', wide: true }, { label: 'Importe', align: 'right', mono: true }, { label: '% base', align: 'right', mono: true }]}
                  rows={analysis.onlyA.map(r => [r.label, amt(r.va), r.pa === null ? '–' : pct(r.pa)])} />
              </div>
            </details>
          )}
        </>
      )}
    </Section>
  );
}
