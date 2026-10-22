'use client';

import { useEffect, useRef, useState } from 'react';

// Columnas de ancho ajustable (arrastrando el borde derecho de la cabecera). Los anchos se guardan por navegador en
// localStorage; el texto de la cabecera se parte en varias líneas para caber en su columna.
export function useColumnWidths(storageKey: string, defaults: Record<string, number>) {
  const [widths, setWidths] = useState<Record<string, number>>(defaults);
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); setWidths(w => ({ ...w, ...saved })); } catch { /* sin almacenamiento */ }
  }, [storageKey]);
  const setWidth = (id: string, w: number) => setWidths(prev => {
    const next = { ...prev, [id]: Math.max(48, Math.round(w)) };
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* sin almacenamiento */ }
    return next;
  });
  const reset = () => { setWidths(defaults); try { localStorage.removeItem(storageKey); } catch { /* sin almacenamiento */ } };
  return { widths, setWidth, reset };
}

export function ResizeTh({ id, width, onResize, className = '', title, children }: {
  id: string; width: number; onResize: (id: string, w: number) => void; className?: string; title?: string; children?: React.ReactNode;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    start.current = { x: e.clientX, w: width };
    const move = (ev: MouseEvent) => { if (start.current) onResize(id, start.current.w + ev.clientX - start.current.x); };
    const up = () => { start.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
  };
  return (
    <th className={`relative align-bottom ${className}`} title={title} style={{ width }}>
      <span className="block whitespace-normal break-words leading-tight">{children}</span>
      <span onMouseDown={onMouseDown} onDoubleClick={e => e.stopPropagation()} title="Arrastra para cambiar el ancho"
        className="absolute top-0 right-0 h-full w-2 cursor-col-resize hover:bg-[#C8186C]/30 select-none" />
    </th>
  );
}
