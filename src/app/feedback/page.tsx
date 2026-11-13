'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, FileText, Loader2, MessageSquareWarning, RefreshCw, RotateCcw, Wand2, XCircle } from 'lucide-react';
import { companyLabel } from '@/contexts/CompanyContext';

// FEEDBACK de OCR y BANCO: correcciones guardadas al enviar a BC (lo que se cambió de la propuesta) y comentarios del
// botón "Algo está mal". Claude los revisa, corrige la lógica y los marca como aplicados con una nota
type Item = {
  id: string; at: string; by: string; company: string; area: 'ocr' | 'banco'; kind: 'auto' | 'manual';
  title: string; message: string; changes: string[]; context: unknown; hasPdf: boolean; pdfName?: string;
  images?: { name: string; type: string }[];
  status: 'pending' | 'applied' | 'dismissed'; resolution?: string; resolvedBy?: string; resolvedAt?: string;
};
type StatusFilter = 'pending' | 'applied' | 'dismissed' | 'all';

const when = (iso: string) => new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const STATUS: Record<Item['status'], { label: string; cls: string }> = {
  pending: { label: 'Pendiente', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  applied: { label: 'Aplicado', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  dismissed: { label: 'Descartado', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
};

export default function FeedbackPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [area, setArea] = useState<'all' | 'ocr' | 'banco'>('all');

  const load = () => {
    setLoading(true); setError('');
    fetch('/api/feedback').then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); setItems(d.items); })
      .catch(e => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const patch = async (id: string, body: { status?: Item['status']; resolution?: string }) => {
    const res = await fetch('/api/feedback', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...body }) });
    const d = await res.json();
    if (res.ok) setItems(l => l.map(i => (i.id === id ? d.item : i)));
    else alert(d.error || 'No se ha podido guardar');
  };

  const byArea = items.filter(i => area === 'all' || i.area === area);
  const count = (s: StatusFilter) => byArea.filter(i => s === 'all' || i.status === s).length;
  const shown = useMemo(() => byArea.filter(i => status === 'all' || i.status === status), [byArea, status]); // eslint-disable-line react-hooks/exhaustive-deps
  const chip = (active: boolean) => `px-3 py-1.5 rounded-md text-sm font-semibold ${active ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-800'}`;

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-16">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg flex items-center gap-2"><MessageSquareWarning size={18} /> FEEDBACK OCR / BANCO</p>
            <p className="text-xs text-gray-500">Correcciones al enviar a BC y comentarios de &quot;Algo está mal&quot;, para corregir la lógica de las propuestas</p>
          </div>
          <button onClick={load} className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Actualizar
          </button>
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex bg-gray-100 rounded-lg p-1">
            {(['pending', 'applied', 'dismissed', 'all'] as StatusFilter[]).map(s => (
              <button key={s} onClick={() => setStatus(s)} className={chip(status === s)}>
                {s === 'all' ? 'Todos' : STATUS[s].label + 's'} <span className="text-gray-400 font-normal">{count(s)}</span>
              </button>
            ))}
          </div>
          <div className="flex bg-gray-100 rounded-lg p-1">
            {([['all', 'OCR y Banco'], ['ocr', 'OCR'], ['banco', 'Banco']] as const).map(([a, label]) => (
              <button key={a} onClick={() => setArea(a)} className={chip(area === a)}>{label}</button>
            ))}
          </div>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
        {loading && !items.length && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Cargando…</p>}
        {!loading && !shown.length && !error && (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-sm text-gray-500">
            {status === 'pending' ? 'No hay feedback pendiente.' : 'Nada en esta vista.'}
            <p className="mt-1 text-xs">Se guarda solo al enviar a BC una propuesta cambiada, o con el botón &quot;Algo está mal&quot; de cada factura (OCR) y movimiento (Banco).</p>
          </div>
        )}
        {shown.map(i => <Card key={i.id} i={i} patch={patch} />)}
      </main>
    </div>
  );
}

function Card({ i, patch }: { i: Item; patch: (id: string, body: { status?: Item['status']; resolution?: string }) => Promise<void> }) {
  const [showContext, setShowContext] = useState(false);
  const [note, setNote] = useState(i.resolution || '');
  const [saving, setSaving] = useState(false);
  const run = async (body: { status?: Item['status']; resolution?: string }) => { setSaving(true); await patch(i.id, body); setSaving(false); };
  const st = STATUS[i.status];
  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-2">
        <span className={`text-[11px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 ${i.area === 'ocr' ? 'bg-indigo-50 text-indigo-700' : 'bg-sky-50 text-sky-700'}`}>{i.area === 'ocr' ? 'OCR' : 'Banco'}</span>
        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded px-1.5 py-0.5 ${i.kind === 'auto' ? 'bg-gray-100 text-gray-600' : 'bg-amber-50 text-amber-800'}`}>
          {i.kind === 'auto' ? <><Wand2 size={11} /> Corrección al enviar</> : <><MessageSquareWarning size={11} /> Algo está mal</>}
        </span>
        <span className="font-semibold text-gray-900 break-all">{i.title}</span>
        <span className={`ml-auto text-xs font-semibold border rounded-full px-2 py-0.5 ${st.cls}`}>{st.label}</span>
      </div>
      <div className="px-4 py-3 space-y-2 text-sm">
        <p className="text-xs text-gray-500">{companyLabel(i.company)} · {i.by || 'usuario'} · {when(i.at)}</p>
        {i.message && <p className="whitespace-pre-wrap text-gray-900 border-l-2 border-amber-300 pl-3">{i.message}</p>}
        {i.changes.length > 0 && (
          <ul className="space-y-0.5 text-xs text-gray-700">
            {i.changes.map((c, k) => <li key={k} className="font-mono break-words">• {c}</li>)}
          </ul>
        )}
        {i.images && i.images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {i.images.map((img, n) => (
              <a key={n} href={`/api/feedback/image?id=${encodeURIComponent(i.id)}&n=${n}`} target="_blank" rel="noreferrer" title="Abrir la captura">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/feedback/image?id=${encodeURIComponent(i.id)}&n=${n}`} alt={img.name} className="h-24 max-w-[200px] object-cover rounded-md border border-gray-200 hover:border-gray-500" />
              </a>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4 text-xs">
          {i.hasPdf && (
            <a href={`/api/feedback/pdf?id=${encodeURIComponent(i.id)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-indigo-700 hover:underline">
              <FileText size={13} /> {i.pdfName || 'PDF'}
            </a>
          )}
          <button onClick={() => setShowContext(v => !v)} className="inline-flex items-center gap-1 font-semibold text-gray-500 hover:text-gray-900">
            {showContext ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Datos del caso
          </button>
        </div>
        {showContext && <pre className="text-[11px] bg-gray-50 border border-gray-200 rounded-lg p-3 max-h-80 overflow-auto">{JSON.stringify(i.context, null, 2)}</pre>}

        <div className="pt-2 border-t border-gray-100 flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-[280px] text-xs font-semibold text-gray-500">Resolución
            <input value={note} onChange={e => setNote(e.target.value)} onBlur={() => note !== (i.resolution || '') && run({ resolution: note })}
              placeholder="Qué se ha corregido en la lógica (o por qué se descarta)"
              className="block mt-1 w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm font-normal focus:outline-none focus:border-gray-900" />
          </label>
          {i.status === 'pending' ? (<>
            <button disabled={saving} onClick={() => run({ status: 'applied', resolution: note })} className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 border border-emerald-200 bg-emerald-50 rounded-md px-2.5 py-1.5 hover:bg-emerald-100"><CheckCircle2 size={13} /> Aplicado</button>
            <button disabled={saving} onClick={() => run({ status: 'dismissed', resolution: note })} className="inline-flex items-center gap-1 text-xs font-semibold text-gray-600 border border-gray-200 rounded-md px-2.5 py-1.5 hover:bg-gray-50"><XCircle size={13} /> Descartar</button>
          </>) : (
            <button disabled={saving} onClick={() => run({ status: 'pending' })} className="inline-flex items-center gap-1 text-xs font-semibold text-gray-600 border border-gray-200 rounded-md px-2.5 py-1.5 hover:bg-gray-50"><RotateCcw size={13} /> Reabrir</button>
          )}
          {i.resolvedAt && <span className="text-[11px] text-gray-400">{i.resolvedBy || ''} · {when(i.resolvedAt)}</span>}
        </div>
      </div>
    </section>
  );
}
