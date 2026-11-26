// Ficheros soltados o elegidos en OCR: PDFs y facturas electrónicas XML (XRechnung) tal cual y, de un correo de
// Outlook (.msg) o .eml, sus PDFs y XML adjuntos. Las librerías se cargan solo cuando llega un correo.

export const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
export const isXml = (f: File) => /\.xml$/i.test(f.name) || f.type === 'text/xml' || f.type === 'application/xml';
// Lo que el OCR lee: PDF (también ZUGFeRD / Factur-X, con el XML dentro) o XML de XRechnung
export const isDoc = (f: File) => isPdf(f) || isXml(f);
// XML que es una factura electrónica (CII o UBL), no cualquier XML adjunto
const isEInvoiceXml = async (f: File) => /<([\w-]+:)?(CrossIndustryInvoice|Invoice|CreditNote)[\s>]/.test((await f.text()).slice(0, 4000));
const isMsg = (f: File) => /\.msg$/i.test(f.name) || f.type === 'application/vnd.ms-outlook';
const isEml = (f: File) => /\.eml$/i.test(f.name) || f.type === 'message/rfc822';
export const ACCEPT = '.pdf,.xml,.msg,.eml,application/pdf,text/xml,application/xml,application/vnd.ms-outlook,message/rfc822';

const pdfFile = (name: string, data: BlobPart) => new File([data], /\.pdf$/i.test(name) ? name : `${name || 'documento'}.pdf`, { type: 'application/pdf' });
const xmlFile = (name: string, data: BlobPart) => new File([data], name || 'invoice.xml', { type: 'application/xml' });

async function fromMsg(f: File): Promise<{ subject: string; pdfs: File[]; xmls: File[] }> {
  const { default: MsgReader } = await import('@kenjiuno/msgreader');
  const reader = new MsgReader(await f.arrayBuffer());
  const data = reader.getFileData();
  const atts = (data.attachments || []).filter(a => !a.innerMsgContent);
  const name = (a: typeof atts[number]) => a.fileName || a.fileNameShort || '';
  const pdfs = atts.filter(a => /\.pdf$/i.test(name(a))).map(a => { const att = reader.getAttachment(a); return pdfFile(att.fileName, att.content as BlobPart); });
  const xmls = atts.filter(a => /\.xml$/i.test(name(a))).map(a => { const att = reader.getAttachment(a); return xmlFile(att.fileName, att.content as BlobPart); });
  return { subject: data.subject || f.name, pdfs, xmls };
}

async function fromEml(f: File): Promise<{ subject: string; pdfs: File[]; xmls: File[] }> {
  const { default: PostalMime } = await import('postal-mime');
  const email = await PostalMime.parse(await f.arrayBuffer());
  const pdfs = email.attachments
    .filter(a => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename || ''))
    .map(a => pdfFile(a.filename || 'adjunto.pdf', a.content as BlobPart));
  const xmls = email.attachments
    .filter(a => /\.xml$/i.test(a.filename || '') || a.mimeType === 'text/xml' || a.mimeType === 'application/xml')
    .map(a => xmlFile(a.filename || 'invoice.xml', a.content as BlobPart));
  return { subject: email.subject || f.name, pdfs, xmls };
}

// Facturas de una lista de ficheros (PDF y XML, también los de los correos, en su orden) y avisos para la página (en
// inglés; la página los traduce con tx). Un correo con una factura electrónica XML (XRechnung) trae a menudo también su
// copia en PDF: la factura es el XML; los PDF solo se devuelven si withCopies (opción 2: van como adjuntos)
export async function expandFiles(list: File[], withCopies = false): Promise<{ pdfs: File[]; notes: string[] }> {
  const pdfs: File[] = [];
  const notes: string[] = [];
  for (const f of list) {
    try {
      if (isPdf(f)) pdfs.push(/\.pdf$/i.test(f.name) ? f : pdfFile(f.name, f));
      else if (isXml(f)) {
        if (await isEInvoiceXml(f)) pdfs.push(f);
        else notes.push(`${f.name}: the XML is not an e-invoice (XRechnung / ZUGFeRD), skipped`);
      } else if (isMsg(f) || isEml(f)) {
        const mail = isMsg(f) ? await fromMsg(f) : await fromEml(f);
        const xmls: File[] = [];
        for (const x of mail.xmls) if (await isEInvoiceXml(x)) xmls.push(x);
        const files = xmls.length && !withCopies ? xmls : [...xmls, ...mail.pdfs];
        notes.push(files.length
          ? `Email «${mail.subject}»: ${files.length} file(s) (${files.map(p => p.name).join(', ')})`
          : `Email «${mail.subject}»: no PDF or e-invoice attachments`);
        if (xmls.length && !withCopies && mail.pdfs.length) notes.push(`Email «${mail.subject}»: e-invoice XML used, PDF copy skipped (${mail.pdfs.map(p => p.name).join(', ')})`);
        pdfs.push(...files);
      } else notes.push(`${f.name}: not a PDF, an e-invoice XML or an email, skipped`);
    } catch (e: any) {
      notes.push(`${f.name}: could not be read (${e.message})`);
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
      else if (/xml/.test(blob.type) || /\.xml$/i.test(u.name)) files.push(xmlFile(u.name, blob));
    } catch {
      // el enlace no es descargable desde aquí (p. ej. otro dominio)
    }
  }
  return { files, types };
}

// De los ficheros de un correo, la factura: el XML de factura electrónica, si no el PDF que parece la factura (por el
// nombre); el resto son adjuntos
export function pickInvoice(pdfs: File[]): { invoice: File; rest: File[] } {
  const xml = pdfs.findIndex(isXml);
  const i = xml >= 0 ? xml : Math.max(0, pdfs.findIndex(p => /inv|rechnung|factura|fattura|facture|bill|debit|beleg/i.test(p.name)));
  return { invoice: pdfs[i], rest: pdfs.filter((_, k) => k !== i) };
}
