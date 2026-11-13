'use client';

import { useState } from 'react';
import { CheckCircle2, ImagePlus, Loader2, MessageSquareWarning, X } from 'lucide-react';

// Feedback de OCR y BANCO (página /feedback). sendFeedback: envío sin interfaz (las correcciones al enviar a BC);
// FeedbackButton: "Algo está mal" con un texto, que adjunta el contexto del caso (y el PDF)
export type FeedbackPayload = {
  area: 'ocr' | 'banco'; kind?: 'auto' | 'manual'; title: string; message?: string; changes?: string[]; context?: unknown; pdf?: File | null;
  images?: Blob[];
};

// Captura de pantalla reducida a JPEG (máx. 1600 px) para no pasar del límite de 4,5 MB por petición de Vercel
export async function shrinkImage(file: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.85));
    return out && out.size < file.size ? out : file;
  } catch { return file; }
}
export async function sendFeedback(p: FeedbackPayload) {
  const form = new FormData();
  form.append('data', JSON.stringify({ area: p.area, kind: p.kind || 'manual', title: p.title, message: p.message || '', changes: p.changes || [], context: p.context ?? null }));
  const imgs = (p.images || []).slice(0, 6);
  imgs.forEach((b, i) => form.append('images', b, `captura-${i + 1}.${b.type === 'image/png' ? 'png' : 'jpg'}`));
  const imgBytes = imgs.reduce((t, b) => t + b.size, 0);
  // El PDF solo si cabe con las capturas en la petición
  if (p.pdf && p.pdf.size <= 4 * 1024 * 1024 && p.pdf.size + imgBytes <= 4.2 * 1024 * 1024) form.append('pdf', p.pdf);
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
  const [images, setImages] = useState<{ blob: Blob; url: string }[]>([]);
  const addImages = async (files: (File | Blob)[]) => {
    const list = files.filter(f => /^image\//.test(f.type));
    if (!list.length) return;
    const shrunk = await Promise.all(list.map(shrinkImage));
    setImages(prev => [...prev, ...shrunk.map(blob => ({ blob, url: URL.createObjectURL(blob) }))].slice(0, 6));
  };
  const removeImage = (i: number) => setImages(prev => { URL.revokeObjectURL(prev[i].url); return prev.filter((_, k) => k !== i); });
  const send = async () => {
    if (!text.trim() && !images.length) return;
    setState('sending'); setError('');
    try {
      await sendFeedback({ ...build(), kind: 'manual', message: text.trim(), images: images.map(x => x.blob) });
      images.forEach(x => URL.revokeObjectURL(x.url));
      setState('sent'); setText(''); setImages([]); setOpen(false);
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
        <div className="absolute z-40 right-0 top-6 w-96 bg-white border border-gray-200 rounded-lg shadow-xl p-3 space-y-2 text-left"
          onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addImages(Array.from(e.dataTransfer.files)); }}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-gray-900">¿Qué está mal?</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700"><X size={14} /></button>
          </div>
          <textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={4} maxLength={4000}
            placeholder="P. ej.: el proveedor es VE-00066, no VE-00078 / es un abono / el nº de factura es el de arriba a la derecha"
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
            onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.some(f => /^image\//.test(f.type))) { e.preventDefault(); addImages(files); } }}
            className="w-full border border-gray-300 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-gray-900" />
          <div className="flex flex-wrap items-center gap-2">
            {images.map((x, i) => (
              <span key={x.url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={x.url} alt={`Captura ${i + 1}`} className="h-14 w-20 object-cover rounded border border-gray-200" />
                <button onClick={() => removeImage(i)} title="Quitar" className="absolute -top-1.5 -right-1.5 bg-white border border-gray-300 rounded-full p-0.5 text-gray-500 hover:text-red-600"><X size={10} /></button>
              </span>
            ))}
            {images.length < 6 && (
              <label className="inline-flex items-center gap-1 text-xs font-semibold text-gray-600 border border-dashed border-gray-300 rounded-md px-2 py-1.5 cursor-pointer hover:border-gray-500">
                <ImagePlus size={13} /> Adjuntar captura
                <input type="file" accept="image/*" multiple className="hidden" onChange={e => { addImages(Array.from(e.target.files || [])); e.target.value = ''; }} />
              </label>
            )}
          </div>
          <p className="text-[11px] text-gray-500">Pega una captura con Cmd/Ctrl+V en el texto, arrástrala aquí o adjúntala (hasta 6). Se adjunta también lo que hay en pantalla (propuesta, cambios y el PDF si lo hay).</p>
          {error && <p className="text-xs text-red-700">{error}</p>}
          <div className="flex justify-end">
            <button onClick={send} disabled={(!text.trim() && !images.length) || state === 'sending'}
              className="inline-flex items-center gap-1.5 bg-black text-white text-xs font-semibold rounded-md px-3 py-1.5 disabled:opacity-40">
              {state === 'sending' && <Loader2 size={12} className="animate-spin" />} Enviar feedback
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
