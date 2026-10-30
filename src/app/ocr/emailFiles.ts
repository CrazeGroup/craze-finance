// Ficheros soltados o elegidos en OCR: PDFs tal cual y, de un correo de Outlook (.msg) o .eml, sus PDFs adjuntos.
// Las librerías se cargan solo cuando llega un correo.

export const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
const isMsg = (f: File) => /\.msg$/i.test(f.name) || f.type === 'application/vnd.ms-outlook';
const isEml = (f: File) => /\.eml$/i.test(f.name) || f.type === 'message/rfc822';
export const ACCEPT = '.pdf,.msg,.eml,application/pdf,application/vnd.ms-outlook,message/rfc822';

const pdfFile = (name: string, data: BlobPart) => new File([data], /\.pdf$/i.test(name) ? name : `${name || 'documento'}.pdf`, { type: 'application/pdf' });

async function fromMsg(f: File): Promise<{ subject: string; pdfs: File[] }> {
  const { default: MsgReader } = await import('@kenjiuno/msgreader');
  const reader = new MsgReader(await f.arrayBuffer());
  const data = reader.getFileData();
  const pdfs = (data.attachments || [])
    .filter(a => !a.innerMsgContent && /\.pdf$/i.test(a.fileName || a.fileNameShort || ''))
    .map(a => { const att = reader.getAttachment(a); return pdfFile(att.fileName, att.content as BlobPart); });
  return { subject: data.subject || f.name, pdfs };
}

async function fromEml(f: File): Promise<{ subject: string; pdfs: File[] }> {
  const { default: PostalMime } = await import('postal-mime');
  const email = await PostalMime.parse(await f.arrayBuffer());
  const pdfs = email.attachments
    .filter(a => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename || ''))
    .map(a => pdfFile(a.filename || 'adjunto.pdf', a.content as BlobPart));
  return { subject: email.subject || f.name, pdfs };
}

// PDFs de una lista de ficheros (los de los correos, en su orden) y avisos para la página
export async function expandFiles(list: File[]): Promise<{ pdfs: File[]; notes: string[] }> {
  const pdfs: File[] = [];
  const notes: string[] = [];
  for (const f of list) {
    try {
      if (isPdf(f)) pdfs.push(/\.pdf$/i.test(f.name) ? f : pdfFile(f.name, f));
      else if (isMsg(f) || isEml(f)) {
        const mail = isMsg(f) ? await fromMsg(f) : await fromEml(f);
        notes.push(mail.pdfs.length
          ? `Correo «${mail.subject}»: ${mail.pdfs.length} PDF (${mail.pdfs.map(p => p.name).join(', ')})`
          : `Correo «${mail.subject}»: no tiene PDFs adjuntos`);
        pdfs.push(...mail.pdfs);
      } else notes.push(`${f.name}: no es un PDF ni un correo, no se usa`);
    } catch (e: any) {
      notes.push(`${f.name}: no se ha podido leer (${e.message})`);
    }
  }
  return { pdfs, notes };
}

// Ficheros de un arrastre. Algunos programas (Outlook) no pasan el fichero sino un enlace: si es descargable desde el
// navegador se descarga; si no llega nada, "types" dice qué se ha recibido (para el aviso)
export async function droppedFiles(e: React.DragEvent): Promise<{ files: File[]; types: string[] }> {
  const dt = e.dataTransfer;
  const types = Array.from(dt.types || []);
  let files = Array.from(dt.files);
  if (!files.length) files = Array.from(dt.items || []).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => !!f);
  if (files.length) return { files, types };
  // Chrome: "DownloadURL" = "mime:nombre:url"; si no, text/uri-list
  const download = dt.getData('DownloadURL');
  const m = download.match(/^([^:]*):([^:]*):(.+)$/);
  const urls = m ? [{ url: m[3], name: m[2] }] : dt.getData('text/uri-list').split(/\r?\n/).filter(u => /^https?:/i.test(u)).map(url => ({ url, name: decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'documento.pdf') }));
  for (const u of urls) {
    try {
      const res = await fetch(u.url, { credentials: 'include' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.type === 'application/pdf' || /\.pdf$/i.test(u.name)) files.push(new File([blob], /\.pdf$/i.test(u.name) ? u.name : `${u.name}.pdf`, { type: 'application/pdf' }));
    } catch {
      // el enlace no es descargable desde aquí (p. ej. otro dominio)
    }
  }
  return { files, types };
}

// De los PDFs de un correo, el que parece la factura (por el nombre); el resto son adjuntos
export function pickInvoice(pdfs: File[]): { invoice: File; rest: File[] } {
  const i = Math.max(0, pdfs.findIndex(p => /inv|rechnung|factura|fattura|facture|bill|debit|beleg/i.test(p.name)));
  return { invoice: pdfs[i], rest: pdfs.filter((_, k) => k !== i) };
}
