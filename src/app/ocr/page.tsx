'use client';

import { Fragment, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, FileText, Paperclip, Plus, RefreshCw, ScanText, Search, Trash2, Upload, X } from 'lucide-react';
import DocPdfLink from '@/components/DocPdfLink';
import { useCompany } from '@/contexts/CompanyContext';

type Line = { lineType: string; number: string; description: string; description2: string; quantity: number; unitCost: number; taxCode: string };
type Candidate = { number: string; name: string; currency: string; score: number; reasons: string[]; invoices: number };
type HistoryInvoice = { number: string; vendorInvoiceNumber: string; invoiceDate: string; postingDate: string; currency: string; net: number; total: number; postingDescription: string; lines: Line[] };
type Suggestion = {
  documentType: string; invoiceNo: string; invoiceDate: string; postingDate: string; dueDate: string; postingDescription: string;
  currency: string; net: number | null; vat: number | null; total: number | null; lines: Line[]; comment: string;
};
type Doc = {
  file: string; error?: string; loading?: boolean; scanned: boolean; currency: string; ids: string[];
  candidates: Candidate[]; vendor: Candidate | null; history: HistoryInvoice[]; suggestion: Suggestion | null;
  existing: { no: string; status: string }[]; warnings: string[];
};
// Valores editables de cada factura antes de crearla (importes como texto, formato es-ES)
type FormLine = Omit<Line, 'quantity' | 'unitCost'> & { quantity: string; unitCost: string };
type Form = { invoiceNo: string; invoiceDate: string; postingDate: string; dueDate: string; postingDescription: string; lines: FormLine[] };
type Status = { saving?: boolean; created?: { id: string; no: string; net: number | null; total: number | null; currency: string }; warnings?: string[]; error?: string | null };

const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v: number | null | undefined) => (v == null ? '—' : nf.format(v));
const toNum = (s: string) => parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
const toText = (v: number) => String(v).replace('.', ',');
const input = 'border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white';
const LINE_TYPES = ['Item', 'Account', 'Resource', 'Fixed Asset', 'Charge', 'Comment'];
const blank: FormLine = { lineType: 'Item', number: '', description: '', description2: '', quantity: '1', unitCost: '0', taxCode: '' };

// Adjunto extra (no se lee): va a la factura elegida al enviarla a BC
type Attachment = { file: File; target: string; done?: string; error?: string };

const toForm = (s: Suggestion | null): Form => ({
  invoiceNo: s?.invoiceNo || '', invoiceDate: s?.invoiceDate || '', postingDate: s?.postingDate || '', dueDate: s?.dueDate || '',
  postingDescription: s?.postingDescription || '',
  lines: (s?.lines || []).map(l => ({ ...l, quantity: toText(l.quantity), unitCost: toText(l.unitCost) })),
});

// OCR: facturas de proveedor en PDF → Purchase Invoice sin registrar en BC, con las líneas como en las facturas
// anteriores del mismo proveedor
export default function OcrPage() {
  const { selectedCompany } = useCompany();
  const [files, setFiles] = useState<File[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Un PDF por llamada (límite de 4,5 MB por petición en Vercel), dos a la vez
  const parse = async (file: File, vendor?: string) => {
    setDocs(l => l.map(d => (d.file === file.name ? { ...d, loading: true, error: undefined } : d)));
    try {
      const form = new FormData();
      form.append('file', file);
      if (vendor) form.append('vendor', vendor);
      const res = await fetch('/api/ocr/parse', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al leer el PDF');
      setDocs(l => l.map(d => (d.file === file.name ? { ...json, file: file.name, loading: false } : d)));
      setForms(f => ({ ...f, [file.name]: toForm(json.suggestion) }));
      setStatus(s => ({ ...s, [file.name]: {} }));
      if (json.vendor && json.suggestion?.documentType !== 'credit_note') setSelected(prev => new Set(prev).add(file.name));
    } catch (e: any) {
      setDocs(l => l.map(d => (d.file === file.name ? { ...d, loading: false, error: e.message } : d)));
    }
  };
  const read = async (list: File[]) => {
    const pdfs = list.filter(f => /\.pdf$/i.test(f.name) && !files.some(x => x.name === f.name));
    if (!pdfs.length) return;
    setFiles(l => [...l, ...pdfs]);
    setDocs(l => [...l, ...pdfs.map(f => ({ file: f.name, loading: true, scanned: false, currency: '', ids: [], candidates: [], vendor: null, history: [], suggestion: null, existing: [], warnings: [] }))]);
    const queue = [...pdfs];
    await Promise.all([0, 1].map(async () => { for (let f = queue.shift(); f; f = queue.shift()) await parse(f); }));
  };

  const setField = (file: string, k: Exclude<keyof Form, 'lines'>, v: string) => setForms(f => ({ ...f, [file]: { ...f[file], [k]: v } }));
  const setLine = (file: string, i: number, k: keyof FormLine, v: string) =>
    setForms(f => ({ ...f, [file]: { ...f[file], lines: f[file].lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) } }));
  const addLine = (file: string, from?: Line) =>
    setForms(f => ({ ...f, [file]: { ...f[file], lines: [...f[file].lines, from ? { ...from, quantity: toText(from.quantity), unitCost: toText(from.unitCost) } : { ...blank }] } }));
  const removeLine = (file: string, i: number) => setForms(f => ({ ...f, [file]: { ...f[file], lines: f[file].lines.filter((_, j) => j !== i) } }));
  const remove = (file: string) => {
    setDocs(l => l.filter(d => d.file !== file));
    setFiles(l => l.filter(f => f.name !== file));
    setForms(({ [file]: _f, ...rest }) => rest);
    setStatus(({ [file]: _s, ...rest }) => rest);
    setSelected(prev => { const n = new Set(prev); n.delete(file); return n; });
    setAttachments(l => l.map(a => (a.target === file ? { ...a, target: '' } : a)));
  };
  // Adjuntos: a la factura cuyo nº sale en el nombre del fichero, o a la única que haya; si no, se elige en la lista
  const guessTarget = (name: string) => {
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const byNo = docs.find(d => { const no = (forms[d.file]?.invoiceNo || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return no.length >= 4 && n.includes(no); });
    return byNo?.file || (docs.length === 1 ? docs[0].file : '');
  };
  const addAttachments = (list: File[]) => setAttachments(a => [...a, ...list.filter(f => !a.some(x => x.file.name === f.name)).map(f => ({ file: f, target: guessTarget(f.name) }))]);
  const uploadAttachments = async (file: string, id: string) => {
    for (const a of attachments.filter(x => x.target === file && !x.done)) {
      try {
        const form = new FormData();
        form.append('id', id);
        form.append('file', a.file);
        const res = await fetch('/api/ocr/attach', { method: 'POST', body: form });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Error al adjuntar');
        setAttachments(l => l.map(x => (x.file === a.file ? { ...x, done: id, error: undefined } : x)));
      } catch (e: any) {
        setAttachments(l => l.map(x => (x.file === a.file ? { ...x, error: e.message } : x)));
      }
    }
  };

  const changeVendor = (d: Doc, vendor: string) => { const f = files.find(x => x.name === d.file); if (f && vendor) parse(f, vendor); };

  const create = async (d: Doc, confirmed = false) => {
    const f = forms[d.file];
    if (!d.vendor || !f.invoiceNo.trim()) { setStatus(s => ({ ...s, [d.file]: { error: 'Elige el proveedor y escribe el nº de factura.' } })); return; }
    const force = d.existing.length > 0;
    if (force && !confirmed && !confirm(`La factura ${f.invoiceNo} de ${d.vendor.name} ya existe en BC (${d.existing.map(e => e.no).join(', ')}). ¿Crearla de nuevo?`)) return;
    setStatus(s => ({ ...s, [d.file]: { saving: true } }));
    try {
      const form = new FormData();
      form.append('data', JSON.stringify({
        vendor: d.vendor.number, invoiceNo: f.invoiceNo.trim(), invoiceDate: f.invoiceDate, postingDate: f.postingDate, dueDate: f.dueDate,
        postingDescription: f.postingDescription, ids: d.ids, force,
        lines: f.lines.map(l => ({ ...l, quantity: toNum(l.quantity), unitCost: toNum(l.unitCost) })),
      }));
      const pdf = files.find(x => x.name === d.file);
      if (pdf) form.append('pdf', pdf);
      const res = await fetch('/api/ocr/create', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al crear la factura');
      setStatus(s => ({ ...s, [d.file]: { created: json, warnings: json.warnings } }));
      await uploadAttachments(d.file, json.id);
      setSelected(prev => { const n = new Set(prev); n.delete(d.file); return n; });
    } catch (e: any) {
      setStatus(s => ({ ...s, [d.file]: { error: e.message } }));
    }
  };
  const ready = (d: Doc) => !d.error && !d.loading && !!d.vendor && !status[d.file]?.created;
  const toSend = docs.filter(d => ready(d) && selected.has(d.file));
  const createSelected = async () => {
    const again = toSend.filter(d => d.existing.length);
    if (again.length && !confirm(`${again.length} de las ${toSend.length} facturas ya existen en BC (${again.map(d => forms[d.file]?.invoiceNo).join(', ')}). ¿Crearlas de nuevo también?`)) return;
    for (const d of toSend) await create(d, true);
  };
  const toggle = (file: string) => setSelected(prev => { const n = new Set(prev); if (n.has(file)) n.delete(file); else n.add(file); return n; });
  const valid = docs.filter(ready);
  const allSelected = valid.length > 0 && valid.every(d => selected.has(d.file));

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <main className="w-full px-4 md:px-8 pt-6 space-y-4">
        <header>
          <h1 className="text-3xl font-black text-black tracking-tight flex items-center gap-2"><ScanText /> OCR</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Sube facturas de proveedor en PDF: se reconoce el proveedor y se proponen la cabecera y las líneas igual que en sus últimas facturas registradas en BC ({selectedCompany}).
            Revisa y crea cada una como Purchase Invoice sin registrar, con el PDF adjunto; regístrala (Post) en BC.
          </p>
        </header>

        {selectedCompany === 'ALL' ? (
          <div className="bg-white border rounded-lg p-4 text-sm text-gray-600">Selecciona una empresa en el menú.</div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-wrap items-center gap-3"
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); read(Array.from(e.dataTransfer.files)); }}>
            <label className="cursor-pointer inline-flex items-center gap-2 bg-black text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-gray-800"
              title="Se leen: proveedor, importes, fechas, Posting Description y líneas según sus facturas registradas en BC">
              <Upload size={16} /> Subir facturas PDF
              <input type="file" accept=".pdf" multiple className="hidden" onChange={e => { read(Array.from(e.target.files || [])); e.target.value = ''; }} />
            </label>
            <label className="cursor-pointer inline-flex items-center gap-2 bg-white border border-gray-300 text-gray-900 text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-gray-50"
              title="No se leen: se añaden como Attachment a la factura elegida al enviarla a BC">
              <Paperclip size={16} /> Subir adjuntos PDF
              <input type="file" accept=".pdf" multiple className="hidden" onChange={e => { addAttachments(Array.from(e.target.files || [])); e.target.value = ''; }} />
            </label>
            <span className="text-sm text-gray-500">{files.length ? `${files.length} factura${files.length > 1 ? 's' : ''}` : 'Facturas: también puedes arrastrarlas aquí'}{attachments.length ? ` · ${attachments.length} adjunto${attachments.length > 1 ? 's' : ''}` : ''}</span>
            {docs.some(d => d.loading) && <span className="text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Leyendo y buscando las facturas anteriores del proveedor…</span>}
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

        {attachments.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2">
            <p className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Paperclip size={15} /> Adjuntos <span className="font-normal text-gray-500">(no se leen; se añaden a la factura elegida al enviarla a BC)</span></p>
            {attachments.map(a => {
              const created = status[a.target]?.created;
              return (
                <div key={a.file.name} className="flex flex-wrap items-center gap-2 text-sm">
                  <FileText size={14} className="text-gray-400" />
                  <span className="font-medium">{a.file.name}</span>
                  <span className="text-gray-400">→</span>
                  <select value={a.target} disabled={!!a.done} onChange={e => setAttachments(l => l.map(x => (x.file === a.file ? { ...x, target: e.target.value } : x)))} className={`${input} max-w-[420px]`}>
                    <option value="">— elige la factura —</option>
                    {docs.filter(d => !d.error).map(d => (
                      <option key={d.file} value={d.file}>{forms[d.file]?.invoiceNo || d.file}{d.vendor ? ` · ${d.vendor.name}` : ''}</option>
                    ))}
                  </select>
                  {a.done ? <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-semibold"><CheckCircle2 size={13} /> Adjuntado a {created?.no}</span>
                    : created ? <button onClick={() => uploadAttachments(a.target, created.id)} className="text-xs font-semibold text-indigo-700 hover:underline">Adjuntar ahora a {created.no}</button>
                    : !a.target ? <span className="text-xs text-amber-800">Sin factura: no se envía</span> : null}
                  {a.error && <span className="text-xs text-red-700">{a.error}</span>}
                  {!a.done && <button onClick={() => setAttachments(l => l.filter(x => x.file !== a.file))} title="Quitar" className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><X size={14} /></button>}
                </div>
              );
            })}
          </div>
        )}

        {docs.map(d => (
          <DocCard key={d.file} d={d} f={forms[d.file]} attachments={attachments.filter(a => a.target === d.file).map(a => a.file.name)} st={status[d.file] || {}} selected={selected.has(d.file)}
            onToggle={() => toggle(d.file)} onRemove={() => remove(d.file)} onVendor={v => changeVendor(d, v)} onCreate={() => create(d)}
            setField={(k, v) => setField(d.file, k, v)} setLine={(i, k, v) => setLine(d.file, i, k, v)}
            addLine={l => addLine(d.file, l)} removeLine={i => removeLine(d.file, i)} />
        ))}
      </main>
    </div>
  );
}

function DocCard({ d, f, attachments, st, selected, onToggle, onRemove, onVendor, onCreate, setField, setLine, addLine, removeLine }: {
  d: Doc; f?: Form; attachments: string[]; st: Status; selected: boolean;
  onToggle: () => void; onRemove: () => void; onVendor: (v: string) => void; onCreate: () => void;
  setField: (k: Exclude<keyof Form, 'lines'>, v: string) => void; setLine: (i: number, k: keyof FormLine, v: string) => void;
  addLine: (l?: Line) => void; removeLine: (i: number) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const s = d.suggestion;
  const head = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 border-b border-gray-200">
      {!d.loading && !d.error && d.vendor && !st.created && <input type="checkbox" checked={selected} onChange={onToggle} title="Marcar para enviar junto con las demás" />}
      <FileText size={16} className="text-gray-400" />
      <span className="font-bold text-gray-900">{d.vendor ? `${d.vendor.number} · ${d.vendor.name}` : 'Proveedor sin reconocer'}</span>
      <span className="text-xs text-gray-500">{d.file}{d.scanned ? ' · escaneado (sin texto)' : ''}</span>
      {s && <span className="ml-auto text-sm text-gray-600">PDF: neto <b>{fmt(s.net)}</b> · IVA {fmt(s.vat)} · total <b>{fmt(s.total)} {s.currency || d.currency}</b></span>}
      <button onClick={onRemove} title="Quitar de la lista (no se envía a BC)" className={`${s ? '' : 'ml-auto '}p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50`}><X size={16} /></button>
    </div>
  );
  if (d.loading) return <section className="bg-white border border-gray-200 rounded-xl shadow-sm">{head}<p className="p-4 text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Leyendo el PDF…</p></section>;
  if (d.error) return <div className="rounded-lg border px-4 py-3 text-sm bg-red-50 border-red-200 text-red-800"><b>{d.file}</b>: {d.error}</div>;
  if (!f) return null;

  const sum = f.lines.filter(l => l.lineType !== 'Comment').reduce((a, l) => a + toNum(l.quantity) * toNum(l.unitCost), 0);
  const diff = s?.net != null ? Math.round((sum - s.net) * 100) / 100 : null;
  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
      {head}
      <div className="p-4 space-y-3">
        <VendorPicker d={d} onVendor={onVendor} />
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-xs font-semibold text-gray-500">Nº factura proveedor (Vendor Invoice No.)
            <input value={f.invoiceNo} onChange={e => setField('invoiceNo', e.target.value)} className={`${input} block mt-1 w-64 font-mono`} />
          </label>
          <label className="text-xs font-semibold text-gray-500">Fecha factura
            <input type="date" value={f.invoiceDate} onChange={e => setField('invoiceDate', e.target.value)} className={`${input} block mt-1`} />
          </label>
          <label className="text-xs font-semibold text-gray-500">Fecha registro
            <input type="date" value={f.postingDate} onChange={e => setField('postingDate', e.target.value)} className={`${input} block mt-1`} />
          </label>
          <label className="text-xs font-semibold text-gray-500">Vencimiento <span className="font-normal">(vacío: según términos de pago)</span>
            <input type="date" value={f.dueDate} onChange={e => setField('dueDate', e.target.value)} className={`${input} block mt-1`} />
          </label>
          <label className="text-xs font-semibold text-gray-500 flex-1 min-w-[260px]">Posting Description
            <input value={f.postingDescription} maxLength={100} onChange={e => setField('postingDescription', e.target.value)} className={`${input} block mt-1 w-full`} />
          </label>
        </div>

        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-gray-500 bg-gray-50">
            <tr>
              <th className="p-2 text-left">Tipo</th><th className="p-2 text-left">Nº</th><th className="p-2 text-left">Descripción</th><th className="p-2 text-left">Description 2</th>
              <th className="p-2 text-right">Cantidad</th><th className="p-2 text-right">Coste unit. ({d.vendor?.currency || s?.currency || ''})</th><th className="p-2 text-left">Grupo IVA</th>
              <th className="p-2 text-right">Importe</th><th />
            </tr>
          </thead>
          <tbody>
            {f.lines.map((l, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="p-1"><select value={l.lineType} onChange={e => setLine(i, 'lineType', e.target.value)} className={input}>{LINE_TYPES.map(t => <option key={t}>{t}</option>)}</select></td>
                <td className="p-1"><input value={l.number} onChange={e => setLine(i, 'number', e.target.value)} disabled={l.lineType === 'Comment'} className={`${input} w-28 font-mono ${!l.number && l.lineType !== 'Comment' ? 'border-red-400' : ''}`} /></td>
                <td className="p-1"><input value={l.description} maxLength={100} onChange={e => setLine(i, 'description', e.target.value)} className={`${input} w-full min-w-[260px]`} /></td>
                <td className="p-1"><input value={l.description2} maxLength={50} onChange={e => setLine(i, 'description2', e.target.value)} disabled={l.lineType === 'Comment'} className={`${input} w-full min-w-[140px]`} /></td>
                <td className="p-1"><input value={l.quantity} onChange={e => setLine(i, 'quantity', e.target.value)} disabled={l.lineType === 'Comment'} className={`${input} w-20 text-right tabular-nums`} /></td>
                <td className="p-1"><input value={l.unitCost} onChange={e => setLine(i, 'unitCost', e.target.value)} disabled={l.lineType === 'Comment'} className={`${input} w-28 text-right tabular-nums`} /></td>
                <td className="p-1"><input value={l.taxCode} onChange={e => setLine(i, 'taxCode', e.target.value)} disabled={l.lineType === 'Comment'} className={`${input} w-36`} /></td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{l.lineType === 'Comment' ? '' : fmt(toNum(l.quantity) * toNum(l.unitCost))}</td>
                <td className="p-1"><button onClick={() => removeLine(i)} title="Quitar línea" className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 size={14} /></button></td>
              </tr>
            ))}
            <tr className="border-t border-gray-200">
              <td colSpan={7} className="p-2">
                <button onClick={() => addLine()} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 hover:underline"><Plus size={13} /> Añadir línea</button>
              </td>
              <td className="p-2 text-right font-bold tabular-nums whitespace-nowrap">{fmt(sum)}</td><td />
            </tr>
          </tbody>
        </table>
        {diff != null && Math.abs(diff) >= 0.01 && (
          <p className="text-xs text-red-700 flex items-center gap-1"><AlertCircle size={13} /> Las líneas suman {fmt(sum)} y el neto del PDF es {fmt(s!.net)} (diferencia {fmt(diff)}).</p>
        )}
        {attachments.length > 0 && <p className="text-xs text-gray-600 flex items-center gap-1"><Paperclip size={13} /> Se adjuntarán también: {attachments.join(', ')}</p>}
        {s?.comment && <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2"><b>Propuesta:</b> {s.comment}</p>}
        {d.warnings.map(w => <p key={w} className="text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> {w}</p>)}
        {d.existing.map(e => <p key={e.no} className="text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> Ya existe en BC: {e.no} ({e.status === 'Draft' ? 'pendiente' : 'registrada'})<DocPdfLink documentNo={e.no} /></p>)}

        {d.history.length > 0 && (
          <div className="border border-gray-200 rounded-lg">
            <button onClick={() => setShowHistory(!showHistory)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50">
              {showHistory ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="font-semibold text-gray-900">Últimas facturas de {d.vendor?.name}</span>
              <span className="text-gray-500">{d.history.length} registradas · modelo de la propuesta</span>
            </button>
            {showHistory && (
              <table className="w-full text-sm border-t border-gray-200">
                <thead className="text-xs uppercase tracking-wider text-gray-500 bg-gray-50">
                  <tr><th className="p-2 text-left">Factura</th><th className="p-2 text-left">Fecha</th><th className="p-2 text-left">Tipo · Nº</th><th className="p-2 text-left">Descripción</th>
                    <th className="p-2 text-right">Cant.</th><th className="p-2 text-right">Coste unit.</th><th className="p-2 text-left">Grupo IVA</th><th /></tr>
                </thead>
                <tbody>
                  {d.history.map(h => (
                    <Fragment key={h.number}>
                      {h.lines.map((l, i) => (
                        <tr key={i} className={i ? '' : 'border-t border-gray-200'}>
                          <td className="p-2 whitespace-nowrap">{i ? '' : <><b>{h.number}</b> <span className="text-xs text-gray-500">{h.vendorInvoiceNumber}</span><DocPdfLink documentNo={h.number} />{h.postingDescription && <span className="block text-xs text-gray-500">{h.postingDescription}</span>}</>}</td>
                          <td className="p-2 text-gray-500 whitespace-nowrap">{i ? '' : h.postingDate}</td>
                          <td className="p-2 font-mono text-xs whitespace-nowrap">{l.lineType} · {l.number}</td>
                          <td className="p-2">{l.description}{l.description2 && <span className="text-gray-500"> · {l.description2}</span>}</td>
                          <td className="p-2 text-right tabular-nums">{l.lineType === 'Comment' ? '' : l.quantity}</td>
                          <td className="p-2 text-right tabular-nums">{l.lineType === 'Comment' ? '' : `${fmt(l.unitCost)} ${h.currency}`}</td>
                          <td className="p-2 text-xs">{l.taxCode}</td>
                          <td className="p-2"><button onClick={() => addLine(l)} title="Copiar esta línea a la factura" className="text-xs font-semibold text-indigo-700 hover:underline whitespace-nowrap">+ copiar</button></td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {st.warnings?.map(w => <p key={w} className="text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> {w}</p>)}
        {st.error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{st.error}</p>}
        <div className="flex items-center gap-3">
          {st.created ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
              <CheckCircle2 size={16} /> Purchase Invoice {st.created.no} creada · neto {fmt(st.created.net)} {st.created.currency}<DocPdfLink documentNo={st.created.no} />
            </span>
          ) : (
            <button onClick={onCreate} disabled={st.saving || !d.vendor}
              className="inline-flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed">
              {st.saving && <RefreshCw size={14} className="animate-spin" />} Enviar a BC{d.existing.length ? ' de nuevo' : ''}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// Proveedor: los candidatos reconocidos en el PDF o uno buscado por nº/nombre (vuelve a proponer las líneas)
function VendorPicker({ d, onVendor }: { d: Doc; onVendor: (v: string) => void }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<{ number: string; name: string; currency: string; invoices: number }[]>([]);
  const [searching, setSearching] = useState(false);
  const search = async () => {
    if (term.trim().length < 2) return;
    setSearching(true);
    try {
      const json = await (await fetch(`/api/ocr/vendors?q=${encodeURIComponent(term.trim())}`)).json();
      setResults(json.vendors || []);
    } finally {
      setSearching(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-xs font-semibold text-gray-500">Proveedor
        <select value={d.vendor?.number || ''} onChange={e => onVendor(e.target.value)} className={`${input} block mt-1 max-w-[520px]`}>
          {!d.vendor && <option value="">— elige un proveedor —</option>}
          {d.vendor && !d.candidates.some(c => c.number === d.vendor!.number) && <option value={d.vendor.number}>{d.vendor.number} · {d.vendor.name}</option>}
          {d.candidates.map(c => (
            <option key={c.number} value={c.number}>{c.number} · {c.name} ({c.currency}, {c.invoices} fact./año) — {c.reasons.join(', ')}</option>
          ))}
          {results.filter(r => r.number !== d.vendor?.number && !d.candidates.some(c => c.number === r.number)).map(r => (
            <option key={r.number} value={r.number}>{r.number} · {r.name} ({r.currency}, {r.invoices} fact./año)</option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-1">
        <input value={term} onChange={e => setTerm(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} placeholder="Buscar otro proveedor (nº o nombre)" className={`${input} w-64`} />
        <button onClick={search} className="p-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50" title="Buscar">
          {searching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
        </button>
      </div>
      {results.length > 0 && <span className="text-xs text-gray-500">{results.length} encontrados: elígelo en el desplegable</span>}
    </div>
  );
}
