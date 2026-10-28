'use client';

import { FileText } from 'lucide-react';

// Enlace al PDF adjunto en BC de una factura/abono (/api/purchase-attachments/pdf), en una pestaña nueva.
// Sin empresa, la ruta usa la del menú (cookie craze_selected_company).
export type DocPdfKind = 'purchInv' | 'purchCrMemo' | 'salesInv' | 'salesCrMemo';

// Tipo de documento de compra (Invoice / Credit Memo de BC, o Factura / Abono) → tipo del enlace; null si no tiene PDF
export const purchasePdfKind = (type: string | null | undefined): DocPdfKind | null =>
  /^(invoice|factura)$/i.test(type || '') ? 'purchInv' : /^(credit.?memo|abono)$/i.test(type || '') ? 'purchCrMemo' : null;

export default function DocPdfLink({ company, documentNo, kind = 'purchInv' }: { company?: string; documentNo: string; kind?: DocPdfKind | null }) {
  if (!documentNo || !kind) return null;
  const p = new URLSearchParams({ no: documentNo, type: kind });
  if (company && company !== 'ALL') p.set('company', company);
  return (
    <a href={`/api/purchase-attachments/pdf?${p}`} target="_blank" rel="noopener noreferrer" title="Abrir el PDF adjunto en BC"
      onClick={e => e.stopPropagation()} className="inline-flex align-middle ml-1.5 text-gray-400 hover:text-[#C8186C]">
      <FileText size={13} />
    </a>
  );
}
