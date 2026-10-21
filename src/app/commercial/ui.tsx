'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Chart as ChartJS, ArcElement, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler,
} from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';
import { ChevronDown, X } from 'lucide-react';

ChartJS.register(ArcElement, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);

// Componentes de Commercial Analysis: selector múltiple (slicer), tarjetas, gráficos y formato de números.

export const COLORS = { prev: '#9CA3AF', cur: '#24305E', bdg: '#C8186C', proj: '#D9982B', so: '#6366F1', green: '#2E7D4F', red: '#C0392B' };
const PALETTE = ['#24305E', '#C8186C', '#D9982B', '#2E7D4F', '#6366F1', '#0EA5E9', '#9333EA', '#F97316', '#64748B', '#14B8A6', '#EAB308', '#EF4444'];

const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const fmtNum = (v: number) => (Math.abs(v) < 0.5 ? '–' : nf0.format(v));
export const fmtPct = (v: number | null) => (v == null || !isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${nf1.format(v * 100)} %`);
export const fmtShare = (v: number | null) => (v == null || !isFinite(v) ? '–' : `${nf1.format(v * 100)} %`);
export const symbol = (currency: string) => ({ EUR: '€', GBP: '£', CHF: 'CHF', USD: '$' }[currency] || currency);
export const fmtMoney = (v: number, currency: string) => (Math.abs(v) < 0.5 ? '–' : `${nf0.format(v)} ${symbol(currency)}`);
export const short = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e6 ? `${nf1.format(v / 1e6)} M` : a >= 1e3 ? `${nf0.format(v / 1e3)} k` : nf0.format(v);
};
export const tone = (v: number | null) => (v == null ? 'text-gray-400' : v > 0 ? 'text-emerald-700' : v < 0 ? 'text-[#C0392B]' : 'text-gray-500');

// Selector múltiple con búsqueda (slicer del Power BI); vacío = todos
export function MultiSelect({ label, options, value, onChange, width = 'w-44' }: {
  label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const shown = options.filter(o => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  const text = !value.length ? 'Todos' : value.length === 1 ? (options.find(o => o.value === value[0])?.label || value[0]) : `${value.length} seleccionados`;
  return (
    <div ref={ref} className={`relative ${width}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-0.5">{label}</p>
      <button onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between gap-1 border rounded-lg px-2.5 py-1.5 text-sm bg-white text-left ${value.length ? 'border-[#C8186C] text-gray-900 font-semibold' : 'border-gray-300 text-gray-600'}`}>
        <span className="truncate">{text}</span>
        {value.length ? <X size={13} className="shrink-0 text-gray-400 hover:text-gray-900" onClick={e => { e.stopPropagation(); onChange([]); }} /> : <ChevronDown size={13} className="shrink-0 text-gray-400" />}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-72 max-h-80 overflow-auto bg-white border border-gray-200 rounded-lg shadow-xl p-2">
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar…" className="w-full border border-gray-200 rounded px-2 py-1 text-sm mb-1" />
          {shown.slice(0, 300).map(o => (
            <label key={o.value} className="flex items-center gap-2 px-1 py-0.5 text-sm hover:bg-gray-50 rounded cursor-pointer">
              <input type="checkbox" checked={value.includes(o.value)}
                onChange={e => onChange(e.target.checked ? [...value, o.value] : value.filter(v => v !== o.value))} />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
          {!shown.length && <p className="text-xs text-gray-400 px-1 py-2">Sin resultados</p>}
        </div>
      )}
    </div>
  );
}

export function Kpi({ title, value, sub, highlight }: { title: string; value: string; sub?: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={`bg-white rounded-xl border p-4 ${highlight ? 'border-[#C8186C]' : 'border-gray-200'}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</p>
      <p className="text-2xl font-bold text-gray-900 tabular-nums mt-1">{value}</p>
      {sub && <div className="text-xs mt-1 space-y-0.5">{sub}</div>}
    </div>
  );
}

export function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        <p className="text-sm font-bold text-gray-900">{title}</p>
        {right}
      </div>
      {children}
    </div>
  );
}

const axis = { grid: { color: '#E5E7EB' }, ticks: { font: { size: 10 }, callback: (v: any) => short(Number(v)) } };
const legend = { display: true, position: 'bottom' as const, labels: { boxWidth: 10, font: { size: 11 } } };
const tooltip = { callbacks: { label: (c: any) => `${c.dataset.label}: ${nf0.format(c.parsed.y ?? c.parsed.x ?? c.parsed)}` } };

export function LineArea({ labels, series, height = 260 }: { labels: string[]; series: { label: string; data: (number | null)[]; color: string; fill?: boolean; dash?: boolean }[]; height?: number }) {
  return (
    <div style={{ height }}>
      <Line options={{ responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend, tooltip }, scales: { y: axis, x: { grid: { display: false }, ticks: { font: { size: 10 } } } } } as any}
        data={{ labels, datasets: series.map(s => ({ label: s.label, data: s.data, borderColor: s.color, backgroundColor: `${s.color}22`, fill: !!s.fill, borderDash: s.dash ? [5, 4] : [], pointRadius: 2, tension: 0.3, borderWidth: 2 })) }} />
    </div>
  );
}

export function Bars({ labels, series, horizontal, height = 260 }: { labels: string[]; series: { label: string; data: number[]; color: string }[]; horizontal?: boolean; height?: number }) {
  const valueAxis = { ...axis }, catAxis = { grid: { display: false }, ticks: { font: { size: 10 }, autoSkip: false } };
  return (
    <div style={{ height }}>
      <Bar options={{
        indexAxis: horizontal ? 'y' : 'x', responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend, tooltip: { callbacks: { label: (c: any) => `${c.dataset.label}: ${nf0.format(horizontal ? c.parsed.x : c.parsed.y)}` } } },
        scales: horizontal ? { x: valueAxis, y: catAxis } : { y: valueAxis, x: catAxis },
      } as any} data={{ labels, datasets: series.map(s => ({ label: s.label, data: s.data, backgroundColor: s.color, borderRadius: 2, maxBarThickness: 28 })) }} />
    </div>
  );
}

export function Donut({ labels, data, height = 220 }: { labels: string[]; data: number[]; height?: number }) {
  const total = data.reduce((s, v) => s + v, 0);
  return (
    <div style={{ height }}>
      <Doughnut options={{
        responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: (c: any) => `${c.label}: ${nf0.format(c.parsed)} (${total ? nf1.format((c.parsed / total) * 100) : 0} %)` } } },
      } as any} data={{ labels, datasets: [{ data, backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 1 }] }} />
    </div>
  );
}

// Medidor (gauge del Power BI): valor, objetivo (proyección) y máximo (presupuesto)
export function Gauge({ value, target, max, currency }: { value: number; target: number; max: number; currency: string }) {
  const scale = Math.max(max, value, target) || 1;
  return (
    <div className="space-y-1">
      <div className="relative h-5 bg-gray-100 rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-[#24305E] rounded-full" style={{ width: `${Math.min(100, (value / scale) * 100)}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-[#D9982B]" style={{ left: `${Math.min(100, (target / scale) * 100)}%` }} title="Proyección" />
        <div className="absolute inset-y-0 w-0.5 bg-[#C8186C]" style={{ left: `${Math.min(100, (max / scale) * 100)}%` }} title="Presupuesto" />
      </div>
      <div className="flex justify-between text-[11px] text-gray-500">
        <span>Sell-in {fmtMoney(value, currency)}</span>
        <span className="text-[#D9982B]">Proyección {fmtMoney(target, currency)}</span>
        <span className="text-[#C8186C]">Presupuesto {fmtMoney(max, currency)}</span>
      </div>
    </div>
  );
}
