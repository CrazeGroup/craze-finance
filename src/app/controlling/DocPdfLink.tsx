'use client';

import { FileText } from 'lucide-react';

// Enlace al PDF adjunto en BC de una factura/abono registrado (/api/purchase-attachments/pdf), en una pestaña nueva.
export type DocPdfKind = 'purchInv' | 'purchCrMemo' | 'salesInv' | 'salesCrMemo';

export default function DocPdfLink({ company, documentNo, kind = 'purchInv' }: { company?: string; documentNo: string; kind?: DocPdfKind }) {
  if (!documentNo) return null;
  const p = new URLSearchParams({ no: documentNo, type: kind });
  if (company && company !== 'ALL') p.set('company', company);
  return (
    <a href={`/api/purchase-attachments/pdf?${p}`} target="_blank" rel="noopener noreferrer" title="Abrir el PDF adjunto en BC"
      onClick={e => e.stopPropagation()} className="inline-flex align-middle ml-1.5 text-gray-400 hover:text-[#C8186C]">
      <FileText size={13} />
    </a>
  );
}
