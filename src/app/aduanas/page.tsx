'use client';

import { useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, Landmark, RefreshCw, Upload, X } from 'lucide-react';
import DocPdfLink from '@/components/DocPdfLink';
import { useCompany } from '@/contexts/CompanyContext';
import TariffCheck, { Position } from './TariffCheck';

type Existing = { no: string; kind: 'zoll' | 'eust' | 'otro'; posted: boolean; date: string };
type Doc = {
  file: string; error?: string; atc: string; registration: string; lrn: string; date: string; description: string;
  zoll: number; zollDue: string; eust: number; eustDue: string; total: number | null; warnings: string[]; existing: Existing[];
  orders: string[]; positions: Position[];
};
type Config = { zollVendor: string; eustVendor: string; zollItem: string; eustItem: string; zollVat: string; eustVat: string; noVat: string };
// Valores editables de cada declaración antes de crear las facturas
type Form = { atc: string; date: string; description: string; zoll: string; zollDue: string; eust: string; eustDue: string };
type Status = { saving?: boolean; created?: { kind: string; no: string; amount: number }[]; warnings?: string[]; error?: string | null };

const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toNum = (s: string) => parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
const fmt = (v: number) => nf.format(v);
const input = 'border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white';

// Aduanas: del Einfuhrabgabenbescheid (PDF) a las dos facturas de compra de BC (Zoll y EUSt)
export default function AduanasPage() {
  const { selectedCompany } = useCompany();
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  // Declaraciones marcadas para enviar juntas
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const read = async (list: File[]) => {
    if (!list.length) return;
    setLoading(true); setError(null);
    try {
      const form = new FormData();
      list.forEach(f => form.append('files', f));
      const res = await fetch('/api/customs/parse', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al leer los PDFs');
      setDocs(json.docs); setConfig(json.config); setStatus({});
      setSelected(new Set((json.docs as Doc[]).filter(d => !d.error).map(d => d.file)));
      setForms(Object.fromEntries((json.docs as Doc[]).filter(d => !d.error).map(d => [d.file, {
        atc: d.atc, date: d.date, description: d.description, zoll: fmt(d.zoll), zollDue: d.zollDue, eust: fmt(d.eust), eustDue: d.eustDue,
      }])));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const setField = (file: string, k: keyof Form, v: string) => setForms(f => ({ ...f, [file]: { ...f[file], [k]: v } }));
  const has = (d: Doc, kind: 'zoll' | 'eust') => d.existing.some(e => e.kind === kind) || !!status[d.file]?.created?.some(c => c.kind === kind);
  const pending = (d: Doc) => !d.error && (['zoll', 'eust'] as const).some(k => !has(d, k) && toNum(forms[d.file]?.[k] || '0') > 0);

  const create = async (d: Doc, confirmed = false) => {
    const f = forms[d.file];
    if (!f.atc || !f.date || !f.description.trim()) { setStatus(s => ({ ...s, [d.file]: { error: 'Rellena el nº AT/C, la fecha y la descripción.' } })); return; }
    // Si ya existen en BC, se pueden crear de nuevo tras confirmarlo (no las creadas ya en esta sesión)
    const force = !pending(d);
    if (force && !confirmed && !confirm(`Las facturas de ${f.atc} ya existen en BC (${d.existing.map(e => e.no).join(', ')}). ¿Crearlas de nuevo?`)) return;
    setStatus(s => ({ ...s, [d.file]: { ...s[d.file], saving: true, error: null } }));
    try {
      const made = (k: 'zoll' | 'eust') => !!status[d.file]?.created?.some(c => c.kind === k);
      const invoices = (['zoll', 'eust'] as const)
        .filter(k => (force ? !made(k) : !has(d, k)))
        .map(k => ({ kind: k, amount: toNum(f[k]), dueDate: k === 'zoll' ? f.zollDue : f.eustDue }))
        .filter(i => i.amount > 0);
      // El PDF subido va como adjunto a las dos facturas
      const form = new FormData();
      form.append('data', JSON.stringify({ atc: f.atc.trim(), date: f.date, description: f.description.trim(), invoices, force }));
      const pdf = files.find(x => x.name === d.file);
      if (pdf) form.append('pdf', pdf);
      const res = await fetch('/api/customs/create', { method: 'POST', body: form });
      const json = await res.json();
      setStatus(s => ({ ...s, [d.file]: { created: [...(s[d.file]?.created || []), ...(json.created || [])], warnings: [...(s[d.file]?.warnings || []), ...(json.warnings || [])], error: json.error || null } }));
    } catch (e: any) {
      setStatus(s => ({ ...s, [d.file]: { ...s[d.file], saving: false, error: e.message } }));
    }
  };
  // Enviar las marcadas (una confirmación para todas las que ya existen en BC)
  const sendable = (d: Doc) => !d.error && selected.has(d.file) && (pending(d) || !status[d.file]?.created?.length);
  const toSend = docs.filter(sendable);
  const createSelected = async () => {
    const again = toSend.filter(d => !pending(d));
    if (again.length && !confirm(`${again.length} de las ${toSend.length} declaraciones ya tienen sus facturas en BC (${again.map(d => forms[d.file]?.atc).join(', ')}). ¿Crearlas de nuevo también?`)) return;
    for (const d of toSend) await create(d, true);
  };
  const toggle = (file: string) => setSelected(prev => { const n = new Set(prev); if (n.has(file)) n.delete(file); else n.add(file); return n; });
  const valid = docs.filter(d => !d.error);
  const allSelected = valid.length > 0 && valid.every(d => selected.has(d.file));
  // Quitar una declaración de la lista (no se envía a BC)
  const remove = (file: string) => {
    setDocs(l => l.filter(d => d.file !== file));
    setFiles(l => l.filter(f => f.name !== file));
    setForms(({ [file]: _f, ...rest }) => rest);
    setStatus(({ [file]: _s, ...rest }) => rest);
    setSelected(prev => { const n = new Set(prev); n.delete(file); return n; });
  };

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <main className="w-full px-4 md:px-8 pt-6 space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black text-black tracking-tight flex items-center gap-2"><Landmark /> Aduanas</h1>
            <p className="text-gray-500 mt-1 text-sm">
              Sube los Einfuhrabgabenbescheide (PDF de ATLAS): cada declaración crea en BC ({selectedCompany}) dos Purchase Invoices, Zoll y EUSt, sin registrar: revísalas y regístralas (Post) en BC. También compara el código arancelario de cada posición con el Tariff No. de los artículos de la factura de China.
            </p>
          </div>
        </header>

        {selectedCompany === 'ALL' ? (
          <div className="bg-white border rounded-lg p-4 text-sm text-gray-600">Selecciona una empresa en el menú.</div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-wrap items-center gap-3"
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const l = Array.from(e.dataTransfer.files).filter(f => /\.pdf$/i.test(f.name)); setFiles(l); read(l); }}>
            <label className="cursor-pointer inline-flex items-center gap-2 bg-black text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-gray-800">
              <Upload size={16} /> Subir PDFs de aduanas
              <input type="file" accept=".pdf" multiple className="hidden" onChange={e => { const l = Array.from(e.target.files || []); setFiles(l); read(l); e.target.value = ''; }} />
            </label>
            <span className="text-sm text-gray-500">{files.length ? `${files.length} PDF: ${files.map(f => f.name).join(', ')}` : 'o arrástralos aquí (varios a la vez)'}</span>
            {loading && <span className="text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Leyendo y comprobando en BC…</span>}
            {valid.length > 1 && (
              <div className="ml-auto flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(valid.map(d => d.file)))} />
                  Marcar todas
                </label>
                <button onClick={createSelected} disabled={!toSend.length || Object.values(status).some(s => s.saving)}
                  className="inline-flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
                  Enviar seleccionadas a BC ({toSend.length})
                </button>
              </div>
            )}
          </div>
        )}

        {error && <div className="rounded-lg border px-4 py-3 text-sm bg-red-50 border-red-200 text-red-800">{error}</div>}

        {docs.map(d => {
          if (d.error) return <div key={d.file} className="rounded-lg border px-4 py-3 text-sm bg-red-50 border-red-200 text-red-800"><b>{d.file}</b>: {d.error}</div>;
          const f = forms[d.file];
          const st = status[d.file] || {};
          if (!f || !config) return null;
          const rows = [
            { kind: 'zoll' as const, label: 'Zoll', vendor: `${config.zollVendor} ZOLL Aufschubkonto`, item: `${config.zollItem} · Custom Duties`, lines: `1 línea · ${config.zollVat}`, amount: 'zoll' as const, due: 'zollDue' as const },
            { kind: 'eust' as const, label: 'EUSt', vendor: `${config.eustVendor} EUST Aufschubkonto`, item: `${config.eustItem} · Import Tax`, lines: `+1 ${config.eustVat} / −1 ${config.noVat}`, amount: 'eust' as const, due: 'eustDue' as const },
          ];
          return (
            <section key={d.file} className="bg-white border border-gray-200 rounded-xl shadow-sm">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 border-b border-gray-200">
                <input type="checkbox" checked={selected.has(d.file)} onChange={() => toggle(d.file)} title="Marcar para enviar junto con las demás" />
                <FileText size={16} className="text-gray-400" />
                <span className="font-bold text-gray-900">{d.atc || 'Sin nº AT/C'}</span>
                <span className="text-xs text-gray-500">Registriernr. {d.registration || '—'} · LRN {d.lrn || '—'} · {d.file}</span>
                <span className="ml-auto text-sm text-gray-600">Total Abgaben: <b>{d.total != null ? fmt(d.total) : '—'} €</b></span>
                <button onClick={() => remove(d.file)} title="Quitar de la lista (no se envía a BC)" className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><X size={16} /></button>
              </div>
              <div className="p-4 space-y-3">
                <div className="flex flex-wrap gap-3 items-end">
                  <label className="text-xs font-semibold text-gray-500">Nº AT/C (Vendor Invoice No.)
                    <input value={f.atc} onChange={e => setField(d.file, 'atc', e.target.value)} className={`${input} block mt-1 w-72 font-mono`} />
                  </label>
                  <label className="text-xs font-semibold text-gray-500">Fecha registro / documento
                    <input type="date" value={f.date} onChange={e => setField(d.file, 'date', e.target.value)} className={`${input} block mt-1`} />
                  </label>
                  <label className="text-xs font-semibold text-gray-500 flex-1 min-w-[280px]">Posting Description / Description 2 (pedido / contenedor)
                    <input value={f.description} maxLength={100} onChange={e => setField(d.file, 'description', e.target.value)} className={`${input} block mt-1 w-full`} />
                  </label>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-wider text-gray-500 bg-gray-50">
                    <tr><th className="p-2 text-left">Factura</th><th className="p-2 text-left">Proveedor</th><th className="p-2 text-left">Artículo</th><th className="p-2 text-left">Líneas</th>
                      <th className="p-2 text-right">Importe EUR</th><th className="p-2 text-left">Vencimiento</th><th className="p-2 text-left">En BC</th></tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const ex = d.existing.filter(e => e.kind === r.kind);
                      const made = st.created?.filter(c => c.kind === r.kind) || [];
                      return (
                        <tr key={r.kind} className="border-t border-gray-100">
                          <td className="p-2 font-semibold">{r.label}</td>
                          <td className="p-2">{r.vendor}</td>
                          <td className="p-2">{r.item}</td>
                          <td className="p-2 text-gray-500">{r.lines}</td>
                          <td className="p-2 text-right"><input value={f[r.amount]} onChange={e => setField(d.file, r.amount, e.target.value)} className={`${input} w-32 text-right tabular-nums`} /></td>
                          <td className="p-2"><input type="date" value={f[r.due]} onChange={e => setField(d.file, r.due, e.target.value)} className={input} /></td>
                          <td className="p-2">
                            {made.map(c => <span key={c.no} className="inline-flex items-center gap-1 text-emerald-700 font-semibold"><CheckCircle2 size={14} /> Purchase Invoice {c.no}<DocPdfLink documentNo={c.no} /></span>)}
                            {ex.map(e => <span key={e.no} className="inline-block text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 text-xs">Ya existe {e.no}{e.posted ? ' (registrada)' : ' (pendiente)'}<DocPdfLink documentNo={e.no} /></span>)}
                            {!made.length && !ex.length && (toNum(f[r.amount]) > 0 ? <span className="text-gray-400">Pendiente</span> : <span className="text-gray-400">Sin importe: no se crea</span>)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <TariffCheck orders={d.orders || []} positions={d.positions || []} />
                {d.warnings.map(w => <p key={w} className="text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> {w}</p>)}
                {st.warnings?.map(w => <p key={w} className="text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> {w}</p>)}
                {st.error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{st.error}</p>}
                {/* Siempre visible; desactivado cuando ya no queda nada por crear (las dos facturas existen en BC) */}
                <div className="flex items-center gap-3">
                  <button onClick={() => create(d)} disabled={st.saving || (!pending(d) && !!st.created?.length)}
                    title={pending(d) ? 'Crea las Purchase Invoices en BC, sin registrar' : 'Ya existen en BC: pide confirmación y las crea de nuevo'}
                    className="inline-flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed">
                    {st.saving && <RefreshCw size={14} className="animate-spin" />} Enviar a BC
                    {pending(d) ? ` (${rows.filter(r => !has(d, r.kind) && toNum(f[r.amount]) > 0).map(r => r.label).join(' + ')})` : !st.created?.length ? ' de nuevo' : ''}
                  </button>
                  {!pending(d) && !st.created?.length && <span className="text-xs text-gray-500">Ya están en BC: se crearán otra vez si lo confirmas.</span>}
                </div>
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
