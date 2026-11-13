'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, MessageSquareWarning, X } from 'lucide-react';

// Feedback de OCR y BANCO (página /feedback). sendFeedback: envío sin interfaz (las correcciones al enviar a BC);
// FeedbackButton: "Algo está mal" con un texto, que adjunta el contexto del caso (y el PDF)
export type FeedbackPayload = {
  area: 'ocr' | 'banco'; kind?: 'auto' | 'manual'; title: string; message?: string; changes?: string[]; context?: unknown; pdf?: File | null;
};
export async function sendFeedback(p: FeedbackPayload) {
  const form = new FormData();
  form.append('data', JSON.stringify({ area: p.area, kind: p.kind || 'manual', title: p.title, message: p.message || '', changes: p.changes || [], context: p.context ?? null }));
  if (p.pdf && p.pdf.size <= 4 * 1024 * 1024) form.append('pdf', p.pdf);
  const res = await fetch('/api/feedback', { method: 'POST', body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'No se ha podido enviar');
  return json.id as string;
}

export default function FeedbackButton({ build, className = '' }: {
  // Se llama al enviar, para llevar el estado de ese momento (lo que hay en pantalla)
  build: () => Omit<FeedbackPayload, 'message' | 'kind'>; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');
  const send = async () => {
    if (!text.trim()) return;
    setState('sending'); setError('');
    try {
      await sendFeedback({ ...build(), kind: 'manual', message: text.trim() });
      setState('sent'); setText(''); setOpen(false);
    } catch (e: any) { setError(e.message); setState('idle'); }
  };
  if (state === 'sent' && !open) return (
    <button onClick={() => { setState('idle'); setOpen(true); }} title="Enviar otro comentario"
      className={`inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 ${className}`}><CheckCircle2 size={13} /> Feedback enviado</button>
  );
  return (
    <span className={`relative inline-flex ${className}`}>
      <button onClick={() => setOpen(o => !o)} title="Avisar de un error en la propuesta, para corregir la lógica"
        className="inline-flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-amber-700"><MessageSquareWarning size={13} /> Algo está mal</button>
      {open && (
        <div className="absolute z-40 right-0 top-6 w-96 bg-white border border-gray-200 rounded-lg shadow-xl p-3 space-y-2 text-left">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-gray-900">¿Qué está mal?</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700"><X size={14} /></button>
          </div>
          <textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={4} maxLength={4000}
            placeholder="P. ej.: el proveedor es VE-00066, no VE-00078 / es un abono / el nº de factura es el de arriba a la derecha"
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
            className="w-full border border-gray-300 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-gray-900" />
          <p className="text-[11px] text-gray-500">Se adjunta lo que hay en pantalla (propuesta, cambios y el PDF si lo hay) para revisar y corregir la lógica.</p>
          {error && <p className="text-xs text-red-700">{error}</p>}
          <div className="flex justify-end">
            <button onClick={send} disabled={!text.trim() || state === 'sending'}
              className="inline-flex items-center gap-1.5 bg-black text-white text-xs font-semibold rounded-md px-3 py-1.5 disabled:opacity-40">
              {state === 'sending' && <Loader2 size={12} className="animate-spin" />} Enviar feedback
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
