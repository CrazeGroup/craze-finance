'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, FileSpreadsheet, RefreshCw, Send } from 'lucide-react';

// MAGAZINES › MAILFINISH: informe de Mailfinish (gadgets recuperados de revistas) → Assembly Orders sugeridas
// (output = gadget en MAILFINISH / DESTR MAIL, input = revista en stock a la fecha del fichero) y su creación en BC.
type Candidate = { item: string; location: string; lastOrder: string; lastDate: string };
type Suggestion = {
  key: string; gadget: string; output: string; outputDescription: string; location: string; quantity: number;
  input: string; inputLocation: string; candidates: Candidate[]; source: 'history' | 'description' | 'none'; shortage: number;
};
type Stock = { item: string; description: string; location: string; qty: number };
type OpenOrder = { no: string; item: string; location: string; quantity: number; postingDate: string };
type Result = {
  file: string; date: string; gadgets: { code: string; sku: string; good: number; damaged: number }[];
  suggestions: Suggestion[]; stock: Stock[]; open: OpenOrder[]; warnings: string[];
};
type Row = Suggestion & { include: boolean; status?: { saving?: boolean; no?: string; error?: string } };

const LOC_GOOD = 'MAILFINISH';
const qf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const dmy = (d: string) => (d ? d.split('-').reverse().join('/') : '');
const fileDate = (name: string) => { const m = name.match(/(20\d{2})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
const th = 'px-3 py-2 whitespace-nowrap';
const td = 'px-3 py-1.5 whitespace-nowrap';

export default function MailfinishView() {
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Result | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  // Artículo de BC cambiado a mano para un código del informe (se recalcula la revista con "Procesar")
  const [outputs, setOutputs] = useState<Record<string, string>>({});

  const pick = (f: File | null) => {
    setFile(f);
    setOutputs({});
    if (f) setDate(fileDate(f.name));
  };

  const process = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('excel', file);
      if (date) form.append('date', date);
      form.append('outputs', JSON.stringify(outputs));
      const res = await fetch('/api/mailfinish/process', { method: 'POST', body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Error al procesar (${res.status})`);
      setData(json);
      setDate(json.date);
      setRows(json.suggestions.map((s: Suggestion) => ({ ...s, include: !!s.input })));
    } catch (e: any) {
      setError(e.message);
      setData(null);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  // Stock a la fecha y lo que consumen las órdenes marcadas, por revista y location
  const stockOf = useMemo(() => new Map((data?.stock || []).map(s => [`${s.item}|${s.location}`, s])), [data]);
  const used = useMemo(() => {
    const m = new Map<string, number>();
    rows.filter(r => r.include && r.input).forEach(r => { const k = `${r.input}|${r.inputLocation}`; m.set(k, (m.get(k) || 0) + r.quantity); });
    return m;
  }, [rows]);
  const restOf = (k: string) => (stockOf.get(k)?.qty || 0) - (used.get(k) || 0);
  const openFor = (r: Row) => (data?.open || []).filter(o => o.item === r.output && o.location === r.location);

  const update = (key: string, patch: Partial<Row>) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)));

  // Las filas con el artículo cambiado sin reprocesar no se envían (su revista sería la del artículo anterior)
  const changed = (r: Row) => !!outputs[r.gadget] && outputs[r.gadget] !== r.output;
  const toSend = rows.filter(r => r.include && !r.status?.no && r.input && r.quantity > 0 && !changed(r));
  const sending = rows.some(r => r.status?.saving);
  const sendAll = async () => {
    const over = toSend.filter(r => restOf(`${r.input}|${r.inputLocation}`) < 0);
    const dup = toSend.filter(r => openFor(r).length);
    const notes = [
      over.length && `${over.length} con más cantidad que el stock de la revista a ${dmy(date)}`,
      dup.length && `${dup.length} de gadgets que ya tienen Assembly Orders abiertas en esa location (${Array.from(new Set(dup.flatMap(r => openFor(r).map(o => o.no)))).join(', ')})`,
    ].filter(Boolean);
    if (!confirm(`¿Crear ${toSend.length} Assembly Orders en BC (sin registrar, fecha ${dmy(date)})?${notes.length ? `\n\nOjo: ${notes.join('; ')}.` : ''}`)) return;
    for (const r of toSend) {
      update(r.key, { status: { saving: true } });
      try {
        const res = await fetch('/api/mailfinish/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gadget: r.gadget, output: r.output, location: r.location, quantity: r.quantity, input: r.input, inputLocation: r.inputLocation, date }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
        update(r.key, { status: { no: json.no } });
      } catch (e: any) {
        update(r.key, { status: { error: e.message } });
      }
    }
  };

  const total = (loc: string) => rows.filter(r => r.location === loc).reduce((s, r) => s + r.quantity, 0);
  const shortRows = rows.filter(r => r.include && r.input && restOf(`${r.input}|${r.inputLocation}`) < 0);
  const created = rows.filter(r => r.status?.no).length;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="mr-auto">
          <p className="font-bold text-gray-900 leading-tight">MAILFINISH</p>
          <p className="text-xs text-gray-500">
            Gadgets recuperados de revistas (informe de Mailfinish) → Assembly Orders sin registrar: I. Wahl en {LOC_GOOD}, II. Wahl (dañado) en DESTR MAIL,
            con la revista de las últimas recuperaciones que hay en stock a la fecha del fichero
          </p>
        </div>
        <button onClick={sendAll} disabled={!toSend.length || sending || !date}
          className="flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
          <Send size={16} className={sending ? 'animate-pulse' : ''} /> {sending ? 'Creando en BC…' : `Crear ${toSend.length} Assembly Orders en BC`}
        </button>
      </div>

      <section className="bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap items-end gap-4">
        <label className="text-xs text-gray-500 flex flex-col gap-1 cursor-pointer">
          Excel de Mailfinish
          <span className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 bg-gray-50 hover:bg-gray-100 min-w-[260px]">
            <FileSpreadsheet size={16} /> {file ? file.name : 'Elegir fichero…'}
          </span>
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => pick(e.target.files?.[0] || null)} />
        </label>
        <label className="text-xs text-gray-500 flex flex-col gap-1" title="Fecha del stock de revistas y de registro de las Assembly Orders (la del nombre del fichero)">
          Fecha (stock y registro)
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className={`border rounded-lg px-2 py-1.5 text-sm font-semibold text-gray-900 ${file && !date ? 'border-amber-400 bg-amber-50' : 'border-gray-300'}`} />
        </label>
        <button onClick={process} disabled={!file || !date || loading}
          className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-black disabled:opacity-40">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> {loading ? 'Procesando…' : 'Procesar sugerencia'}
        </button>
      </section>

      {error && <p className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-center gap-2"><AlertCircle size={16} /> {error}</p>}

      {data && (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <Kpi label="Gadgets" value={qf.format(data.gadgets.length)} sub={data.file} />
            <Kpi label={`I. Wahl → ${LOC_GOOD}`} value={qf.format(total(LOC_GOOD))} sub="unidades" />
            <Kpi label="II. Wahl → DESTR MAIL" value={qf.format(total('DESTR MAIL'))} sub="unidades" />
            <Kpi label="Assembly Orders" value={qf.format(rows.length)} sub={created ? `${created} creadas en BC` : `stock a ${dmy(data.date)}`} />
            <div className={`rounded-xl border p-4 flex items-center gap-2 text-sm ${shortRows.length ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-green-50 border-green-200 text-green-800'}`}>
              {shortRows.length ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
              <p className="font-semibold">{shortRows.length ? `${shortRows.length} órdenes sin stock suficiente` : 'Hay stock de revistas para todas'}</p>
            </div>
          </section>
          {data.warnings.length > 0 && (
            <ul className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 list-disc list-inside space-y-0.5">
              {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200">
              <h2 className="text-sm font-bold text-gray-900">Assembly Orders sugeridas</h2>
              <p className="text-xs text-gray-500">Una orden por gadget, location y revista (Quantity per 1). Puedes cambiar la cantidad y la revista; ★ = usada en recuperaciones anteriores de ese gadget.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className={th}>
                      <input type="checkbox" checked={rows.every(r => r.include || r.status?.no)}
                        onChange={e => setRows(rs => rs.map(r => (r.status?.no ? r : { ...r, include: e.target.checked && !!r.input })))} />
                    </th>
                    <th className={`${th} text-left`}>Output (gadget)</th><th className={`${th} text-left`}>Location</th>
                    <th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-left`}>Input (revista)</th>
                    <th className={`${th} text-right`}>Stock {dmy(data.date)}</th>
                    <th className={`${th} text-right`} title="Stock de la revista menos la cantidad de esta línea">Queda</th>
                    <th className={`${th} text-right`} title="Stock de la revista menos todas las líneas marcadas que la usan">Queda (todas)</th>
                    <th className={`${th} text-left`}>Última recuperación</th><th className={`${th} text-left`}>BC</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const k = `${r.input}|${r.inputLocation}`;
                    const rest = restOf(k);
                    const own = (stockOf.get(k)?.qty || 0) - (r.include ? r.quantity : 0);
                    const sharing = rows.filter(x => x.include && x.input === r.input && x.inputLocation === r.inputLocation).length;
                    const cand = r.candidates.find(c => c.item === r.input && c.location === r.inputLocation);
                    const open = openFor(r);
                    const others = (data.stock || []).filter(s => s.qty > 0 && !r.candidates.some(c => c.item === s.item && c.location === s.location));
                    return (
                      <tr key={r.key} className={`border-t border-gray-100 text-gray-900 ${r.include ? '' : 'opacity-50'}`}>
                        <td className={`${td} text-center`}>
                          <input type="checkbox" checked={r.include} disabled={!!r.status?.no} onChange={e => update(r.key, { include: e.target.checked })} />
                        </td>
                        <td className={td}>
                          <input value={outputs[r.gadget] ?? r.output} disabled={!!r.status?.no} title="Artículo de BC que se da de alta (se recuerda para los próximos informes)"
                            onChange={e => setOutputs(o => ({ ...o, [r.gadget]: e.target.value.trim().toUpperCase() }))}
                            className={`w-24 border rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${outputs[r.gadget] && outputs[r.gadget] !== r.output ? 'border-amber-400 bg-amber-50' : 'border-gray-300'}`} />
                          {r.output !== r.gadget && <span className="ml-1 text-[10px] text-gray-500">(Excel {r.gadget})</span>}
                          {outputs[r.gadget] && outputs[r.gadget] !== r.output && <span className="ml-1 text-[10px] text-amber-700">pulsa Procesar para recalcular</span>}
                          <div className="text-xs text-gray-500 max-w-[360px] truncate" title={r.outputDescription}>{r.outputDescription}</div>
                        </td>
                        <td className={td}>
                          <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded border ${r.location === LOC_GOOD ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>{r.location}</span>
                        </td>
                        <td className={`${td} text-right`}>
                          <input value={r.quantity} inputMode="numeric" disabled={!!r.status?.no}
                            onChange={e => update(r.key, { quantity: Math.max(0, parseInt(e.target.value.replace(/\D/g, ''), 10) || 0) })}
                            className="w-20 border border-gray-300 rounded px-1.5 py-0.5 text-right tabular-nums" />
                        </td>
                        <td className={td}>
                          <select value={r.input ? k : ''} disabled={!!r.status?.no}
                            onChange={e => { const [input, inputLocation] = e.target.value.split('|'); update(r.key, { input, inputLocation, include: !!input }); }}
                            className={`border rounded px-1.5 py-0.5 text-xs max-w-[380px] ${r.input ? 'border-gray-300' : 'border-amber-400 bg-amber-50'}`}>
                            {!r.input && <option value="">— elige revista —</option>}
                            {r.candidates.map(c => (
                              <option key={`${c.item}|${c.location}`} value={`${c.item}|${c.location}`}>
                                ★ {c.item} · {c.location} · stock {qf.format(stockOf.get(`${c.item}|${c.location}`)?.qty || 0)}
                              </option>
                            ))}
                            {others.length > 0 && <optgroup label="Otras revistas con stock">
                              {others.map(s => <option key={`${s.item}|${s.location}`} value={`${s.item}|${s.location}`}>{s.item} · {s.location} · stock {qf.format(s.qty)} · {s.description.replace(/^MAGAZINE - /, '')}</option>)}
                            </optgroup>}
                          </select>
                          {r.input && <div className="text-[11px] text-gray-500 max-w-[380px] truncate">{stockOf.get(k)?.description}</div>}
                        </td>
                        <td className={`${td} text-right tabular-nums`}>{r.input ? qf.format(stockOf.get(k)?.qty || 0) : ''}</td>
                        <td className={`${td} text-right tabular-nums ${r.input && own < 0 ? 'text-red-700 font-semibold' : 'text-gray-600'}`}>
                          {r.input ? qf.format(own) : ''}
                        </td>
                        <td className={`${td} text-right tabular-nums font-semibold ${r.input && rest < 0 ? 'text-red-700' : 'text-gray-900'}`}>
                          {r.input ? qf.format(rest) : ''}{r.input && rest < 0 && <AlertCircle size={12} className="inline ml-1 -mt-0.5" />}
                          {r.input && sharing > 1 && <div className="text-[10px] font-normal text-gray-500">{sharing} líneas</div>}
                        </td>
                        <td className={`${td} text-xs text-gray-600`}>
                          {cand?.lastOrder ? <>{cand.lastOrder} · {dmy(cand.lastDate)}</> : r.source === 'description' ? 'revista de la descripción' : r.input ? 'elegida a mano' : '—'}
                        </td>
                        <td className={`${td} text-xs`}>
                          {r.status?.no ? <span className="text-green-700 font-semibold flex items-center gap-1"><CheckCircle2 size={13} /> {r.status.no}</span>
                            : r.status?.saving ? <span className="text-gray-500">Creando…</span>
                            : r.status?.error ? <span className="text-red-700" title={r.status.error}>Error: {r.status.error.substring(0, 80)}</span>
                            : open.length ? <span className="text-amber-700" title={open.map(o => `${o.no}: ${o.quantity} uds, ${dmy(o.postingDate)}`).join('\n')}>Ya abierta: {open.map(o => o.no).join(', ')}</span>
                            : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <details className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <summary className="px-4 py-3 cursor-pointer text-sm font-bold text-gray-900">Stock de revistas a {dmy(data.date)} ({data.stock.length} revista × location)</summary>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
                  <tr><th className={`${th} text-left`}>Revista</th><th className={`${th} text-left`}>Descripción</th><th className={`${th} text-left`}>Location</th>
                    <th className={`${th} text-right`}>Stock</th><th className={`${th} text-right`}>En las órdenes</th><th className={`${th} text-right`}>Queda</th></tr>
                </thead>
                <tbody>
                  {data.stock.map(s => {
                    const k = `${s.item}|${s.location}`;
                    return (
                      <tr key={k} className="border-t border-gray-100 text-gray-900">
                        <td className={`${td} font-mono text-xs`}>{s.item}</td><td className={td}>{s.description}</td><td className={td}>{s.location}</td>
                        <td className={`${td} text-right tabular-nums`}>{qf.format(s.qty)}</td>
                        <td className={`${td} text-right tabular-nums`}>{used.get(k) ? qf.format(used.get(k)!) : ''}</td>
                        <td className={`${td} text-right tabular-nums font-semibold ${restOf(k) < 0 ? 'text-red-700' : ''}`}>{qf.format(restOf(k))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 tabular-nums mt-1">{value}</p>
      {sub && <p className="text-xs mt-1 text-gray-500 truncate">{sub}</p>}
    </div>
  );
}
