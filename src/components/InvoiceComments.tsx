'use client';

import { useEffect, useState } from 'react';
import { MessageSquare, Trash2, X } from 'lucide-react';

// Comentarios de factura compartidos entre Cashflow y Recobros: misma tabla (CashflowComment, clave "invoice:<id>")
// y misma API (/api/cashflow/comments), así el seguimiento de una factura es el mismo en las dos pantallas.
export type Comment = { id: number; targetKey: string; text: string; author?: string | null; createdAt: string };

export function useComments(company: string) {
  const [comments, setComments] = useState<Comment[]>([]);
  useEffect(() => {
    fetch('/api/cashflow/comments', { cache: 'no-store' }).then(r => r.json()).then(d => setComments(Array.isArray(d) ? d : [])).catch(() => setComments([]));
  }, [company]);
  const commentsFor = (key: string) => comments.filter(c => c.targetKey === key);
  const add = async (key: string, text: string, label: string) => {
    const res = await fetch('/api/cashflow/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKey: key, text, label }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setComments(prev => [...prev, data]);
  };
  const remove = async (id: number) => {
    const res = await fetch(`/api/cashflow/comments?id=${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('No se pudo borrar el comentario');
    setComments(prev => prev.filter(c => c.id !== id));
  };
  return { comments, commentsFor, add, remove };
}

// Etiqueta con el último comentario (+n), que abre el diálogo
export function CommentBadge({ items, onClick }: { items: Comment[]; onClick: (e: React.MouseEvent) => void }) {
  if (!items.length) return null;
  return (
    <button onClick={onClick} title={items.map(c => c.text).join('\n')}
      className="inline-flex items-center gap-1 max-w-xs align-middle bg-sky-500/10 text-sky-800 font-semibold px-1.5 py-0.5 rounded text-[10px] border border-sky-500/30 hover:bg-sky-500/20">
      <MessageSquare size={11} className="shrink-0" /> <span className="truncate">{items.at(-1)!.text}</span>
      {items.length > 1 && <span className="shrink-0">(+{items.length - 1})</span>}
    </button>
  );
}

export function CommentsDialog({ label, items, onAdd, onDelete, onClose }: {
  label: string; items: Comment[]; onAdd: (text: string) => Promise<void>; onDelete: (id: number) => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const add = async () => {
    if (!draft.trim()) return;
    try { await onAdd(draft.trim()); setDraft(''); } catch (e: any) { alert(`No se pudo guardar el comentario: ${e.message || e}`); }
  };
  const del = async (id: number) => {
    if (!confirm('¿Borrar este comentario?')) return;
    try { await onDelete(id); } catch (e: any) { alert(e.message || e); }
  };
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center p-4" onClick={onClose}>
      <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-gray-50">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2 min-w-0">
            <MessageSquare size={18} className="shrink-0" /> <span className="truncate">Comentarios · {label}</span>
          </h3>
          <button onClick={onClose} className="text-gray-900 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="p-5 space-y-3 max-h-80 overflow-y-auto">
          {items.length === 0 ? <p className="text-sm text-gray-500">Sin comentarios todavía.</p> : items.map(c => (
            <div key={c.id} className="group/comment bg-gray-50 border border-gray-200 rounded-lg p-3">
              <div className="flex justify-between items-start gap-2">
                <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{c.text}</p>
                <button onClick={() => del(c.id)} className="opacity-0 group-hover/comment:opacity-100 p-1 text-gray-500 hover:text-red-600 rounded transition-opacity" title="Borrar comentario"><Trash2 size={12} /></button>
              </div>
              <div className="text-[11px] text-gray-500 mt-1">{c.author ? `${c.author} · ` : ''}{new Date(c.createdAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</div>
            </div>
          ))}
        </div>
        <div className="p-5 border-t border-gray-200 space-y-3">
          <textarea autoFocus rows={3} value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(); }}
            placeholder="Escribe un comentario… (se ve también en Cashflow y Recobros)"
            className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500" />
          <div className="flex justify-end">
            <button onClick={add} disabled={!draft.trim()} className="px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-bold hover:bg-teal-700 disabled:opacity-50">Añadir comentario</button>
          </div>
        </div>
      </div>
    </div>
  );
}
