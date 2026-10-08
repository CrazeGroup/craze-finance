'use client';

import React from 'react';
import {
  Chart as ChartJS, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler,
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';
import { RefreshCw, Sparkles, AlertCircle } from 'lucide-react';
import type { Fmt } from './i18n';

ChartJS.register(BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);

export const C = {
  navy: '#24305E',
  magenta: '#C8186C',
  amber: '#D9982B',
  red: '#C0392B',
  green: '#2E7D4F',
  grid: '#E5E7EB',
  text: '#4B5563',
};

// ---------- Estructura ----------

export function Section({ title, source, children, className = '' }: { title: string; source?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rpt-section space-y-4 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b-2 border-gray-900 pb-2">
        <h2 className="text-[22px] font-bold text-gray-900 tracking-tight">{title}</h2>
        {source && <span className="text-xs text-gray-500">{source}</span>}
      </div>
      {children}
    </section>
  );
}

export const Grid = ({ cols = 2, children }: { cols?: 2 | 3 | 4; children: React.ReactNode }) => (
  <div className={`grid grid-cols-1 gap-4 ${cols === 2 ? 'lg:grid-cols-2' : cols === 3 ? 'md:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4'}`}>{children}</div>
);

type Tone = 'main' | 'red' | 'green' | 'amber' | 'neutral';
const TONE: Record<Tone, string> = { main: 'text-[#C8186C]', red: 'text-[#C0392B]', green: 'text-[#2E7D4F]', amber: 'text-[#B7791F]', neutral: 'text-gray-900' };

export function Kpi({ label, value, sub, tone = 'neutral', highlight = false }: { label: string; value: string; sub?: string; tone?: Tone; highlight?: boolean }) {
  return (
    <div className={`rpt-card bg-white rounded-xl p-4 border ${highlight ? 'border-[#C8186C]' : 'border-gray-200'}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">{label}</p>
      <p className={`text-2xl font-mono font-semibold ${TONE[tone]}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

export function Card({ title, sub, children, className = '' }: { title?: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rpt-card bg-white rounded-xl border border-gray-200 p-4 overflow-x-auto ${className}`}>
      {title && (
        <p className="text-sm font-semibold text-gray-900 mb-3">
          {title} {sub && <span className="font-normal text-gray-500">{sub}</span>}
        </p>
      )}
      {children}
    </div>
  );
}

export const Note = ({ children }: { children: React.ReactNode }) => (
  <div className="rpt-card bg-[#E6E8EE] rounded-lg px-4 py-3 text-[13px] text-gray-700 leading-relaxed max-w-4xl">{children}</div>
);

export const Hl = ({ children }: { children: React.ReactNode }) => <span className="font-semibold text-[#C8186C]">{children}</span>;

export function Loading({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 text-gray-500 text-sm py-6">
      <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-[#24305E]" />
      {text}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-4">
      <AlertCircle size={18} className="flex-shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

// ---------- Tablas ----------

export type Col = { label: string; align?: 'left' | 'right'; mono?: boolean; hideMobile?: boolean; wide?: boolean; nowrap?: boolean };

export function Table({ cols, rows, total, rowClass }: {
  cols: Col[]; rows: React.ReactNode[][]; total?: React.ReactNode[]; rowClass?: (i: number) => string;
}) {
  const cell = (c: Col) => `py-2 px-2 ${c.align === 'right' ? 'text-right' : 'text-left'} ${c.mono || c.nowrap ? 'whitespace-nowrap' : ''} ${c.mono ? 'font-mono tabular-nums' : ''} ${c.wide ? 'min-w-[170px]' : ''} ${c.hideMobile ? 'hidden md:table-cell' : ''}`;
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-gray-200">
          {cols.map((c, i) => <th key={i} className={`${cell(c)} text-[10px] font-semibold uppercase tracking-wider text-gray-500 font-mono`}>{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={`border-b border-gray-100 ${rowClass ? rowClass(i) : ''}`}>
            {r.map((v, j) => <td key={j} className={`${cell(cols[j])} text-gray-800`}>{v}</td>)}
          </tr>
        ))}
        {total && (
          <tr className="border-t border-gray-300 font-semibold">
            {total.map((v, j) => <td key={j} className={`${cell(cols[j])} text-gray-900`}>{v}</td>)}
          </tr>
        )}
      </tbody>
    </table>
  );
}

// Importe con signo coloreado (verde positivo, rojo negativo)
export const Signed = ({ v, text, invert = false }: { v: number; text: string; invert?: boolean }) => (
  <span className={(invert ? -v : v) > 0 ? 'text-[#2E7D4F]' : (invert ? -v : v) < 0 ? 'text-[#C0392B]' : ''}>{text}</span>
);
export const Neg = ({ v, text }: { v: number; text: string }) => <span className={v < 0 ? 'text-[#C0392B]' : ''}>{text}</span>;

// ---------- Gráficos ----------

const baseOptions = (fmt: Fmt, horizontal = false, stacked = false): any => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  indexAxis: horizontal ? 'y' : 'x',
  plugins: {
    legend: { display: false, labels: { boxWidth: 10, font: { size: 11 } } },
    tooltip: { callbacks: { label: (c: any) => `${c.dataset.label ? c.dataset.label + ': ' : ''}${fmt.eur(horizontal ? c.parsed.x : c.parsed.y)}` } },
  },
  scales: {
    [horizontal ? 'x' : 'y']: { stacked, grid: { color: C.grid }, ticks: { font: { size: 10 }, callback: (v: number) => fmt.short(v) } },
    [horizontal ? 'y' : 'x']: { stacked, grid: { display: false }, ticks: { font: { size: 10 } } },
  },
});

export function BarChart({ fmt, labels, datasets, horizontal = false, stacked = false, legend = false, height = 260 }: {
  fmt: Fmt; labels: string[]; datasets: { label?: string; data: number[]; color: string | string[] }[];
  horizontal?: boolean; stacked?: boolean; legend?: boolean; height?: number;
}) {
  const options = baseOptions(fmt, horizontal, stacked);
  options.plugins.legend.display = legend;
  return (
    <div style={{ height }}>
      <Bar options={options} data={{ labels, datasets: datasets.map(d => ({ label: d.label, data: d.data, backgroundColor: d.color, borderRadius: 2, maxBarThickness: 48 })) }} />
    </div>
  );
}

// Puente de valor: barras flotantes (inicio, efectos, fin)
export function BridgeChart({ fmt, steps, height = 260 }: { fmt: Fmt; steps: { label: string; value: number; kind: 'total' | 'delta' }[]; height?: number }) {
  let running = 0;
  const data: [number, number][] = [];
  const colors: string[] = [];
  for (const s of steps) {
    if (s.kind === 'total') { data.push([0, s.value]); running = s.value; colors.push(C.navy); }
    else { data.push([running, running + s.value]); running += s.value; colors.push(s.value >= 0 ? C.amber : C.magenta); }
  }
  // Eje desde cerca del mínimo (sin contar la base 0 de los totales) para que se vean los efectos
  const all = data.flat().filter(v => v !== 0);
  const min = Math.min(...all), max = Math.max(...all);
  const pad = (max - min) * 0.15 || 1;
  const options = baseOptions(fmt);
  options.scales.y.min = Math.max(0, Math.floor((min - pad) / 1e5) * 1e5);
  options.plugins.tooltip.callbacks.label = (c: any) => fmt.eur(steps[c.dataIndex].value);
  return (
    <div style={{ height }}>
      <Bar options={options} data={{ labels: steps.map(s => s.label), datasets: [{ data, backgroundColor: colors, borderRadius: 2 }] }} />
    </div>
  );
}

export function StepLineChart({ fmt, labels, values, limit, limitLabel, valueLabel, height = 300 }: {
  fmt: Fmt; labels: string[]; values: number[]; limit: number; limitLabel: string; valueLabel: string; height?: number;
}) {
  const options = baseOptions(fmt);
  options.plugins.legend.display = true;
  options.scales.x.ticks = { font: { size: 10 }, maxTicksLimit: 12, autoSkip: true };
  return (
    <div style={{ height }}>
      <Line options={options} data={{
        labels,
        datasets: [
          { label: valueLabel, data: values, borderColor: C.navy, backgroundColor: C.navy, stepped: true, pointRadius: 0, borderWidth: 2 },
          { label: limitLabel, data: labels.map(() => limit), borderColor: C.red, borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 },
        ],
      }} />
    </div>
  );
}

// ---------- Puntos clave (IA) ----------

// Convierte **negrita** del texto de la IA en <strong>
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return <>{parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <React.Fragment key={i}>{p}</React.Fragment>))}</>;
}

export function KeyPoints({ title, state, onRegenerate, fmt }: {
  title: string; fmt: Fmt;
  state: { points: string[] | null; loading: boolean; error: string | null; waiting: boolean };
  onRegenerate: () => void;
}) {
  return (
    <div className="rpt-card bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#C8186C]">{title}</p>
        <button onClick={onRegenerate} disabled={state.loading || state.waiting}
          className="rpt-noprint flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-900 disabled:opacity-40">
          <RefreshCw size={13} className={state.loading ? 'animate-spin' : ''} /> {fmt.t('regenerate')}
        </button>
      </div>
      {state.error ? <ErrorBox message={state.error} />
        : state.waiting ? <p className="text-sm text-gray-500">{fmt.t('aiWaiting')}</p>
        : state.loading || !state.points ? <Loading text={fmt.t('aiGenerating')} />
        : (
          <ol className="list-decimal pl-5 space-y-2 text-[14px] text-gray-800 leading-relaxed max-w-5xl">
            {state.points.map((p, i) => <li key={i}><RichText text={p} /></li>)}
          </ol>
        )}
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-400"><Sparkles size={12} /> {fmt.t('aiNote')}</p>
    </div>
  );
}
