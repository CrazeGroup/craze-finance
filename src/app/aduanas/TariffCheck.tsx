'use client';

import { Fragment, useEffect, useState } from 'react';
import { AlertCircle, Ban, ChevronDown, ChevronRight, MessageSquare, RefreshCw, Undo2 } from 'lucide-react';

export type Position = {
  pos: number; tariff: string; description: string; articles: string[];
  packages: number | null; value: number | null; dutyRate: number | null; duty: number | null;
};
export type Item = {
  no: string; description: string; qty: number; parent?: string; inInvoice: boolean; display: boolean;
  bcTariff: string; bcRate: number | null; via: 'artikel' | 'unica' | 'descripcion' | ''; score?: number;
  status: 'ok' | 'ok8' | 'distinto' | 'sin_codigo' | 'sin_ficha';
  note?: string;
};
export type Check = {
  invoices: { no: string; vendorInvoiceNo: string; vendor: string; posted: boolean }[];
  positions: (Position & { items: Item[]; qty: number })[]; unassigned: Item[]; warnings: string[];
};

export const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
export const nf2 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// 33073000000 → 3307 3000 000 (como en la declaración)
// Dos códigos (artículo con figuras): "9505 9000 0 / 9503 0049 9"
export const code = (c: string) => (c ? c.split('/').map(x => x.replace(/^(\d{4})(\d{4})?(\d+)?$/, (_, a, b, r) => [a, b, r].filter(Boolean).join(' '))).join(' / ') : '—');
export const STATUS: Record<Item['status'], { label: string; cls: string }> = {
  ok: { label: 'Coincide', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  ok8: { label: 'Mismo NC (8 díg.)', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  distinto: { label: 'Distinto', cls: 'bg-red-50 text-red-700 border-red-200' },
  sin_codigo: { label: 'Sin código en BC', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  sin_ficha: { label: 'No existe en BC', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
};
const VIA: Record<Item['via'], string> = { artikel: 'Artikel Nr.', unica: 'única posición', descripcion: 'descripción', '': '' };

// Códigos arancelarios de una declaración frente al Tariff No. de los artículos de su factura de China (N380)
export default function TariffCheck({ orders, positions }: { orders: string[]; positions: Position[] }) {
  const [data, setData] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<boolean | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/customs/tariffs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orders, positions }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al comparar los códigos');
      setData(json);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (positions.length) load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!positions.length) return null;
  const items = data ? [...data.positions.flatMap(p => p.items), ...data.unassigned] : [];
  const count = (s: Item['status']) => (data ? countStatus(data, s) : 0);
  const bad = count('distinto') + count('sin_codigo') + count('sin_ficha');
  // Abierto por defecto cuando hay algo que revisar
  const expanded = open ?? (bad > 0 || (data?.unassigned.length || 0) > 0);

  return (
    <div className="border border-gray-200 rounded-lg">
      <button onClick={() => setOpen(!expanded)} className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50">
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span className="font-semibold text-gray-900">Códigos arancelarios</span>
        <span className="text-gray-500">{positions.length} posiciones</span>
        {data && <span className="text-gray-500">· factura China: {data.invoices.length ? data.invoices.map(i => `${i.vendorInvoiceNo} (${i.no})`).join(', ') : 'no encontrada'}</span>}
        {loading && <RefreshCw size={14} className="animate-spin text-gray-400" />}
        {data && (
          <span className="ml-auto flex gap-1.5">
            <StatusBadges data={data} />
          </span>
        )}
      </button>
      {error && <p className="px-3 pb-2 text-sm text-red-700">{error} <button onClick={load} className="underline">Reintentar</button></p>}
      {expanded && data && (
        <div className="border-t border-gray-200 overflow-x-auto">
          <TariffTable data={data} />
          {!items.length && <p className="p-3 text-sm text-gray-500">No hay artículos que comparar.</p>}
        </div>
      )}
    </div>
  );
}

export const countStatus = (data: Check, s: Item['status']) => data.positions.flatMap(p => p.items).filter(i => i.status === s).length;

export function StatusBadges({ data }: { data: Check }) {
  return (
    <>
      {(['ok', 'ok8', 'distinto', 'sin_codigo', 'sin_ficha'] as const).filter(s => countStatus(data, s)).map(s => (
        <span key={s} className={`border rounded px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS[s].cls}`}>{countStatus(data, s)} {STATUS[s].label.toLowerCase()}</span>
      ))}
      {data.unassigned.length > 0 && <span className="border rounded px-2 py-0.5 text-xs font-semibold whitespace-nowrap bg-gray-50 text-gray-700 border-gray-200">{data.unassigned.length} sin posición</span>}
    </>
  );
}

// Acciones por línea en el Histórico: actualizar el artículo con su ficha de BC, descartar la línea (error de la
// declaración) y comentarla. Las notas van por AT/C | posición ('u' = sin posición) | artículo
export type LineNote = { ignored?: boolean; comment?: string; by?: string; at: string };
export type LineActions = {
  atc: string; notes: Record<string, LineNote>; busy?: string | null;
  onRefresh: (no: string) => void; onNote: (key: string, note: { ignored: boolean; comment: string }) => void;
};
export const noteKey = (atc: string, pos: number | null, no: string) => `${atc}|${pos ?? 'u'}|${no}`;

// Posiciones de una declaración con los artículos asignados y su Tariff No. en BC
export function TariffTable({ data, actions }: { data: Check; actions?: LineActions }) {
  return (
    <>
      {data.warnings.map(w => <p key={w} className="px-3 pt-2 text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> {w}</p>)}
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wider text-gray-500 bg-gray-50">
          <tr>
            <th className="p-2 text-left">Pos.</th><th className="p-2 text-left">Artículo</th><th className="p-2 text-left">Descripción</th>
            <th className="p-2 text-right">Uds.</th><th className="p-2 text-left">Declarado</th><th className="p-2 text-right">Zoll %</th>
            <th className="p-2 text-left">Tariff No. BC</th><th className="p-2 text-right">% BC</th><th className="p-2 text-left">Estado</th><th className="p-2 text-left">Asignado por</th>
            {actions && <th className="p-2" />}
          </tr>
        </thead>
        <tbody>
          {data.positions.map(p => (
            <Fragment key={p.pos}>
              <tr className="border-t border-gray-200 bg-gray-50/60">
                <td className="p-2 font-bold">{p.pos}</td>
                <td className="p-2 text-gray-500 text-xs" colSpan={2} title={p.description}>
                  <span className="line-clamp-2 max-w-3xl">{p.description}</span>
                </td>
                <td className="p-2 text-right text-xs text-gray-500 whitespace-nowrap" title="Packstücke declarados / unidades de la factura asignadas">
                  {p.packages != null ? `${nf0.format(p.packages)} PK` : '—'}{p.qty ? ` · ${nf0.format(p.qty)} uds.` : ''}
                </td>
                <td className="p-2 font-mono font-semibold whitespace-nowrap">{code(p.tariff)}</td>
                <td className="p-2 text-right tabular-nums">{p.dutyRate != null ? `${nf2.format(p.dutyRate)} %` : '—'}</td>
                <td colSpan={actions ? 5 : 4} className="p-2 text-xs text-gray-400">{p.items.length ? '' : /Figur\w*\s*zu\s*Posit\w*\s*\d+/i.test(p.description) ? `Figuras de la posición ${p.description.match(/Posit\w*\s*(\d+)/i)?.[1]}` : 'Ningún artículo asignado'}</td>
              </tr>
              {p.items.map(i => <ItemRow key={i.no} i={i} rate={p.dutyRate} actions={actions} pos={p.pos} />)}
            </Fragment>
          ))}
          {data.unassigned.length > 0 && (
            <>
              <tr className="border-t border-gray-200 bg-gray-50/60">
                <td className="p-2 font-bold" colSpan={actions ? 11 : 10}>Artículos de la factura sin posición <span className="font-normal text-xs text-gray-500">(no se ha podido asignar por Artikel Nr. ni por descripción)</span></td>
              </tr>
              {data.unassigned.map(i => <ItemRow key={i.no} i={i} unassigned actions={actions} pos={null} />)}
            </>
          )}
        </tbody>
      </table>
    </>
  );
}

function ItemRow({ i, unassigned, rate, actions, pos }: { i: Item; unassigned?: boolean; rate?: number | null; actions?: LineActions; pos?: number | null }) {
  const rateDiff = rate != null && i.bcRate != null && Math.abs(rate - i.bcRate) > 0.001;
  const key = actions ? noteKey(actions.atc, pos ?? null, i.no) : '';
  const note = actions?.notes[key];
  const btn = 'p-1 rounded text-gray-400 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-40';
  const comment = () => {
    const c = prompt(`Comentario para ${i.no}${note?.ignored ? ' (descartada)' : ''}:`, note?.comment || '');
    if (c != null) actions!.onNote(key, { ignored: !!note?.ignored, comment: c });
  };
  const discard = () => {
    if (note?.ignored) { actions!.onNote(key, { ignored: false, comment: note.comment || '' }); return; }
    const c = prompt(`Descartar la línea ${i.no}: no cuenta como incidencia. Motivo (p. ej. "Error del Zoll: es el 82560"):`, note?.comment || '');
    if (c != null) actions!.onNote(key, { ignored: true, comment: c });
  };
  return (
    <tr className={`border-t border-gray-100 ${note?.ignored ? 'opacity-50' : ''}`}>
      <td />
      <td className={`p-2 font-mono whitespace-nowrap ${note?.ignored ? 'line-through' : ''}`}>{i.no}</td>
      <td className="p-2">
        {i.description || <span className="text-gray-400">—</span>}
        {i.parent && <span className="ml-2 text-xs text-gray-500">en display {i.parent}</span>}
        {i.display && <span className="ml-2 text-xs text-gray-500">display (contenido desglosado)</span>}
        {!i.inInvoice && <span className="ml-2 text-xs text-amber-700">no está en la factura</span>}
        {i.note && <span className="block text-xs text-red-700 mt-0.5">{i.note}</span>}
        {note?.comment && <span className="block text-xs text-indigo-700 mt-0.5" title={note.by ? `${note.by} · ${note.at.substring(0, 10)}` : note.at.substring(0, 10)}>💬 {note.comment}</span>}
      </td>
      <td className="p-2 text-right tabular-nums">{i.qty ? nf0.format(i.qty) : '—'}</td>
      <td /><td />
      <td className="p-2 font-mono whitespace-nowrap">{code(i.bcTariff)}</td>
      <td className={`p-2 text-right tabular-nums ${rateDiff ? 'text-red-700 font-semibold' : ''}`} title={rateDiff ? 'El % de arancel de la ficha no coincide con el aplicado' : undefined}>{i.bcRate != null ? `${nf2.format(i.bcRate)} %` : '—'}</td>
      <td className="p-2">{note?.ignored ? <span className="border rounded px-2 py-0.5 text-xs font-semibold whitespace-nowrap bg-gray-100 text-gray-600 border-gray-300">Descartada</span>
        : !unassigned && <span className={`border rounded px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS[i.status].cls}`}>{STATUS[i.status].label}</span>}</td>
      <td className="p-2 text-xs text-gray-500 whitespace-nowrap">{VIA[i.via]}{i.via === 'descripcion' && i.score != null ? ` (${Math.round(i.score * 100)} %)` : ''}</td>
      {actions && (
        <td className="p-1 whitespace-nowrap text-right">
          <button onClick={() => actions.onRefresh(i.no)} disabled={!!actions.busy} title="Actualizar con la ficha actual del artículo en BC (Tariff No. y %), en todas las declaraciones" className={btn}>
            <RefreshCw size={13} className={actions.busy === i.no ? 'animate-spin' : ''} />
          </button>
          <button onClick={comment} title={note?.comment ? 'Editar el comentario' : 'Añadir un comentario'} className={`${btn} ${note?.comment ? 'text-indigo-600' : ''}`}><MessageSquare size={13} /></button>
          <button onClick={discard} title={note?.ignored ? 'Volver a contar la línea' : 'Descartar la línea (error de la declaración): no cuenta como incidencia'} className={btn}>
            {note?.ignored ? <Undo2 size={13} /> : <Ban size={13} />}
          </button>
        </td>
      )}
    </tr>
  );
}
