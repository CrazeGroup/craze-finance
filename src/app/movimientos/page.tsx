'use client';

import { useState, useEffect, useMemo } from 'react';
import { RefreshCcw, User, Building2, CheckCircle, ArrowUp, ArrowDown, Lightbulb, AlertCircle, Shuffle, Send, X } from 'lucide-react';
import DocPdfLink, { purchasePdfKind } from '@/components/DocPdfLink';
import { companyLabel, useCompany } from '@/contexts/CompanyContext';

export default function MovimientosPage() {
  const { selectedCompany } = useCompany();
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'Customer' | 'Vendor'>('Customer');

  // Filter States
  const [selectedDocTypes, setSelectedDocTypes] = useState<string[]>([]);
  const [selectedPaymentMethods, setSelectedPaymentMethods] = useState<string[]>([]);

  // Comentarios de la app por línea ('Customer:<entryNo>' / 'Vendor:<entryNo>')
  const [comments, setComments] = useState<Record<string, { text: string; by?: string; at: string }>>({});
  const loadComments = () => fetch('/api/ledger-entries/comments', { cache: 'no-store' }).then(r => r.json()).then(d => d.comments && setComments(d.comments)).catch(() => {});
  const saveComment = async (key: string, text: string) => {
    if ((comments[key]?.text || '') === text.trim()) return;
    try {
      const res = await fetch('/api/ledger-entries/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, text }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setComments(d.comments);
    } catch (e: any) { alert(`No se ha podido guardar el comentario: ${e.message}`); }
  };

  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchEntries = async () => {
    setLoadError(null);
    // Con "todas las empresas" no hay movimientos que mostrar: hay que elegir una
    if (selectedCompany === 'ALL') { setEntries([]); setLoading(false); return; }
    setLoading(true);
    loadComments();
    try {
      const res = await fetch('/api/ledger-entries', { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data)) setEntries(data);
      else { setEntries([]); setLoadError(data?.error || 'Error al cargar los movimientos'); }
    } catch (e: any) {
      setEntries([]); setLoadError(`Error de conexión: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEntries();
  }, [selectedCompany]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute available filters based on current entries and viewMode
  const availableDocTypes = useMemo(() => {
    const types = new Set<string>();
    entries.filter(e => e.type === viewMode).forEach(inv => {
      if (inv.documentType) types.add(inv.documentType);
    });
    return Array.from(types).sort();
  }, [entries, viewMode]);

  const availablePaymentMethods = useMemo(() => {
    const methods = new Set<string>();
    entries.filter(e => e.type === viewMode).forEach(inv => {
      if (inv.paymentMethodCode) methods.add(inv.paymentMethodCode);
    });
    return Array.from(methods).sort();
  }, [entries, viewMode]);

  // Excluir Amazon (clientes y proveedores cuyo nombre contiene "Amazon"); se recuerda en el navegador
  const [noAmazon, setNoAmazon] = useState(false);
  const [onlySuggested, setOnlySuggested] = useState(false);
  const [onlyCross, setOnlyCross] = useState(false);
  // Cierre cruzado: el par elegido (diálogo) y los ya enviados al lote ('Customer:<entryNo>' → texto)
  const [clearing, setClearing] = useState<any | null>(null);
  const [sentPairs, setSentPairs] = useState<Record<string, string>>({});
  useEffect(() => { try { setNoAmazon(localStorage.getItem('movimientos:sinAmazon') === '1'); } catch { /* sin almacenamiento */ } }, []);
  const changeNoAmazon = (v: boolean) => { setNoAmazon(v); try { localStorage.setItem('movimientos:sinAmazon', v ? '1' : '0'); } catch { /* sin almacenamiento */ } };

  // Orden por columna (clic en la cabecera: ascendente, descendente)
  type SortKey = 'entityNo' | 'entityName' | 'postingDate' | 'documentType' | 'documentNo' | 'externalDocumentNo' | 'currencyCode' | 'originalAmount' | 'remainingAmount' | 'description' | 'paymentMethodCode'
    | 'salesReturnOrderNo' | 'messageToRecipient' | 'comment' | 'suggestion' | 'cross';
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const sortBy = (key: SortKey) => setSort(p => (p?.key === key ? (p.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));

  // Apply filters
  const filteredEntries = useMemo(() => {
    const list = entries.filter(e => {
      if (e.type !== viewMode) return false;
      if (noAmazon && /amazon/i.test(e.entityName || '')) return false;
      if (onlySuggested && !e.suggestion) return false;
      if (onlyCross && !e.cross) return false;
      if (selectedDocTypes.length > 0 && !selectedDocTypes.includes(e.documentType)) return false;
      if (selectedPaymentMethods.length > 0 && !selectedPaymentMethods.includes(e.paymentMethodCode)) return false;
      return true;
    });
    if (!sort) return list;
    const { key, dir } = sort;
    const num = key === 'originalAmount' || key === 'remainingAmount';
    const val = (e: any) => (key === 'comment' ? comments[`${e.type}:${e.entryNo}`]?.text || '' : e[key]);
    const rank = (e: any) => (e.suggestion ? SUGGESTION[e.suggestion.kind as keyof typeof SUGGESTION].rank : 9);
    return [...list].sort((a, b) => {
      if (key === 'suggestion') return (rank(a) - rank(b)) * dir;
      if (key === 'cross') return String(a.cross?.entityName || '\uffff').localeCompare(String(b.cross?.entityName || '\uffff'), 'es', { sensitivity: 'base' }) * dir;
      if (key === 'comment') return String(val(a)).localeCompare(String(val(b)), 'es', { sensitivity: 'base' }) * dir;
      if (num) return ((Number(a[key]) || 0) - (Number(b[key]) || 0)) * dir;
      return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'es', { numeric: true, sensitivity: 'base' }) * dir;
    });
  }, [entries, viewMode, selectedDocTypes, selectedPaymentMethods, noAmazon, onlySuggested, onlyCross, sort, comments]);
  const crossCount = useMemo(() => entries.filter(e => e.type === viewMode && e.cross && (!noAmazon || !/amazon/i.test(e.entityName || ''))).length, [entries, viewMode, noAmazon]);
  const suggestedCount = useMemo(() => entries.filter(e => e.type === viewMode && e.suggestion && (!noAmazon || !/amazon/i.test(e.entityName || ''))).length, [entries, viewMode, noAmazon]);
  const amazonCount = useMemo(() => entries.filter(e => e.type === viewMode && /amazon/i.test(e.entityName || '')).length, [entries, viewMode]);

  // Clear filters when switching view modes
  useEffect(() => {
    setSelectedDocTypes([]);
    setSelectedPaymentMethods([]);
  }, [viewMode]);

  const nf = (v: number) => v.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateEs = (d: string) => (d ? d.substring(0, 10).split('-').reverse().join('.') : '—');
  const toggle = (list: string[], set: (f: (p: string[]) => string[]) => void, v: string) => set(p => (p.includes(v) ? p.filter(x => x !== v) : [...p, v]));
  const chip = (on: boolean) => `px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${on ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`;
  const th = 'px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap';

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-28">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg">Movimientos abiertos</p>
            <p className="text-xs text-gray-500">{companyLabel(selectedCompany)} · movimientos pendientes de clientes y proveedores</p>
          </div>
          <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
            {([['Customer', 'Clientes', User], ['Vendor', 'Proveedores', Building2]] as const).map(([v, label, Icon]) => (
              <button key={v} onClick={() => setViewMode(v)}
                className={`flex items-center gap-2 px-4 py-1.5 font-semibold ${viewMode === v ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
          <button onClick={fetchEntries} disabled={loading}
            className="flex items-center gap-2 border border-gray-300 bg-white text-gray-700 text-sm font-semibold px-3 py-1.5 rounded-lg hover:bg-gray-50 disabled:opacity-50">
            <RefreshCcw size={15} className={loading ? 'animate-spin' : ''} /> Actualizar
          </button>
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-6 space-y-4">
        {(availableDocTypes.length > 0 || availablePaymentMethods.length > 0) && (
          <section className="bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap items-start gap-x-8 gap-y-3">
            {availableDocTypes.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Tipo de documento</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {availableDocTypes.map(dt => (
                    <button key={dt} onClick={() => toggle(selectedDocTypes, setSelectedDocTypes, dt)} className={chip(selectedDocTypes.includes(dt))}>{dt || 'Vacío'}</button>
                  ))}
                  {selectedDocTypes.length > 0 && <button onClick={() => setSelectedDocTypes([])} className="ml-1 text-xs text-gray-500 hover:text-gray-900 underline">Limpiar</button>}
                </div>
              </div>
            )}
            {availablePaymentMethods.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Forma de pago</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {availablePaymentMethods.map(pm => (
                    <button key={pm} onClick={() => toggle(selectedPaymentMethods, setSelectedPaymentMethods, pm)} className={chip(selectedPaymentMethods.includes(pm))}>{pm || 'Vacío'}</button>
                  ))}
                  {selectedPaymentMethods.length > 0 && <button onClick={() => setSelectedPaymentMethods([])} className="ml-1 text-xs text-gray-500 hover:text-gray-900 underline">Limpiar</button>}
                </div>
              </div>
            )}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Amazon</p>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none pt-0.5">
                <input type="checkbox" checked={noAmazon} onChange={e => changeNoAmazon(e.target.checked)} />
                Excluir {viewMode === 'Customer' ? 'clientes' : 'proveedores'} Amazon{amazonCount ? ` (${amazonCount} mov.)` : ''}
              </label>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Para cerrar</p>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none pt-0.5">
                <input type="checkbox" checked={onlySuggested} onChange={e => setOnlySuggested(e.target.checked)} />
                Solo con sugerencia ({suggestedCount})
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none pt-1">
                <input type="checkbox" checked={onlyCross} onChange={e => setOnlyCross(e.target.checked)} />
                Solo con importe en otro cliente / proveedor ({crossCount})
              </label>
            </div>
            <p className="ml-auto self-end text-xs text-gray-500">{filteredEntries.length} movimientos</p>
          </section>
        )}

        {selectedCompany === 'ALL' ? (
          <div className="bg-white rounded-xl border border-gray-200 py-16 text-center">
            <Building2 className="mx-auto text-gray-400 mb-3" size={32} />
            <p className="text-sm text-gray-700 font-semibold">Selecciona una empresa concreta en el menú</p>
            <p className="text-xs text-gray-500 mt-1">Los movimientos abiertos se leen de BC empresa a empresa.</p>
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-xl border border-red-200 py-10 text-center">
            <AlertCircle className="mx-auto text-red-500 mb-3" size={28} />
            <p className="text-sm text-red-700">{loadError}</p>
            <button onClick={fetchEntries} className="mt-3 text-sm font-semibold text-gray-700 underline">Reintentar</button>
          </div>
        ) : loading ? (
          <div className="bg-white rounded-xl border border-gray-200 py-16 flex justify-center text-sm text-gray-500 gap-2 items-center">
            <RefreshCcw size={16} className="animate-spin" /> Cargando movimientos…
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 py-16 text-center">
            <CheckCircle className="mx-auto text-emerald-500 mb-3" size={36} />
            <p className="text-sm text-gray-600">No hay movimientos que coincidan con los filtros.</p>
          </div>
        ) : (
          <section className="table-scroll bg-white rounded-xl border border-gray-200 [--table-offset:84px]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {([
                    ['entityNo', `Nº ${viewMode === 'Customer' ? 'cliente' : 'proveedor'}`], ['entityName', 'Nombre'], ['postingDate', 'Posting Date'],
                    ['documentType', 'Doc. Type'], ['documentNo', 'Document No.'], ['externalDocumentNo', 'Ext. Doc. No.'],
                    ...(viewMode === 'Customer' ? [['salesReturnOrderNo', 'Sales Return Order No.']] : []), ['currencyCode', 'Divisa'],
                    ['originalAmount', 'Original Amt.', true], ['remainingAmount', 'Remaining Amt.', true], ['suggestion', 'Sugerencia para cerrar'], ['cross', 'En otro cliente / proveedor'], ['description', 'Description'],
                    ...(viewMode === 'Customer' ? [['messageToRecipient', 'Message to Recipient']] : []), ['paymentMethodCode', 'Payment Method'], ['comment', 'Comentario'],
                  ] as [SortKey, string, boolean?][]).map(([key, label, right]) => (
                    <th key={key} className={`${th} ${right ? 'text-right' : 'text-left'}`}>
                      <button onClick={() => sortBy(key)} title="Ordenar" className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-gray-900 ${sort?.key === key ? 'text-gray-900' : ''}`}>
                        {label}
                        {sort?.key === key && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry, idx) => (
                  <tr key={idx} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-gray-900 whitespace-nowrap">{entry.entityNo}</td>
                    <td className="px-3 py-2 font-semibold text-gray-900 max-w-[200px] truncate" title={entry.entityName}>{entry.entityName}</td>
                    <td className="px-3 py-2 text-gray-600 tabular-nums whitespace-nowrap">{dateEs(entry.postingDate)}</td>
                    <td className="px-3 py-2">
                      <span className="px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-xs font-semibold text-gray-700 whitespace-nowrap">{entry.documentType || '—'}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-900 whitespace-nowrap">
                      {entry.documentNo}
                      {entry.type === 'Vendor' && <DocPdfLink documentNo={entry.documentNo} kind={purchasePdfKind(entry.documentType)} />}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-600 max-w-[170px] truncate" title={entry.externalDocumentNo}>{entry.externalDocumentNo || '—'}</td>
                    {viewMode === 'Customer' && (
                      <td className="px-3 py-2 font-mono whitespace-nowrap">
                        {entry.salesReturnOrderNo
                          ? <span className="text-gray-900">{entry.salesReturnOrderNo}</span>
                          : entry.documentType === 'Refund'
                            ? <span className="text-xs font-sans font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5" title="Los Refund deberían llevar el Sales Return Order No.">Falta</span>
                            : <span className="text-gray-300">—</span>}
                      </td>
                    )}
                    <td className="px-3 py-2 text-gray-600">{entry.currencyCode || 'EUR'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600 whitespace-nowrap">{nf(entry.originalAmount)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold whitespace-nowrap ${entry.remainingAmount < 0 ? 'text-red-600' : 'text-gray-900'}`}>{nf(entry.remainingAmount)}</td>
                    <td className="px-3 py-2 min-w-[180px]"><SuggestionCell s={entry.suggestion} nf={nf} dateEs={dateEs} /></td>
                    <td className="px-3 py-2 min-w-[220px]">
                      <CrossCell c={entry.cross} nf={nf} dateEs={dateEs} sent={sentPairs[`${entry.type}:${entry.entryNo}`]} onClose={() => setClearing(entry)} />
                    </td>
                    <td className="px-3 py-2 text-gray-700 max-w-[220px] truncate" title={entry.description}>{entry.description}</td>
                    {viewMode === 'Customer' && <td className="px-3 py-2 text-gray-700 max-w-[220px] truncate" title={entry.messageToRecipient}>{entry.messageToRecipient || <span className="text-gray-300">—</span>}</td>}
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{entry.paymentMethodCode || '—'}</td>
                    <td className="px-2 py-1.5 min-w-[200px]">
                      <CommentCell key={`${entry.type}:${entry.entryNo}:${comments[`${entry.type}:${entry.entryNo}`]?.at || ''}`}
                        value={comments[`${entry.type}:${entry.entryNo}`]} onSave={t => saveComment(`${entry.type}:${entry.entryNo}`, t)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>
      {clearing && (
        <ClearDialog entry={clearing} nf={nf} onCancel={() => setClearing(null)}
          onSent={(text) => {
            setSentPairs(p => ({ ...p, [`${clearing.type}:${clearing.entryNo}`]: text, [`${clearing.cross.type}:${clearing.cross.entryNo}`]: text }));
          }} />
      )}
    </div>
  );
}

const sideLabel = (t: string) => (t === 'Customer' ? 'Cliente' : 'Proveedor');
type Cross = {
  type: 'Customer' | 'Vendor'; entryNo: number; entityNo: string; entityName: string; documentType: string; documentNo: string;
  externalDocumentNo: string; postingDate: string | null; remaining: number; reason: 'cited' | 'name'; cited: boolean; count: number;
};

// El mismo importe (de signo contrario) abierto en otro cliente o proveedor, con el botón para cerrar ambos
function CrossCell({ c, nf, dateEs, sent, onClose }: { c?: Cross | null; nf: (v: number) => string; dateEs: (d: string) => string; sent?: string; onClose: () => void }) {
  if (!c) return <span className="text-gray-300">—</span>;
  return (
    <div className="flex items-start gap-2">
      <span className={`inline-flex items-start gap-1 border rounded px-1.5 py-0.5 text-xs ${c.reason === 'cited' ? 'bg-violet-50 text-violet-800 border-violet-200' : 'bg-orange-50 text-orange-800 border-orange-200'}`}
        title={`${sideLabel(c.type)} ${c.entityNo} · ${c.entityName}\n${c.documentType} ${c.documentNo}${c.externalDocumentNo ? ` (${c.externalDocumentNo})` : ''} · ${dateEs(c.postingDate || '')} · ${nf(c.remaining)}${c.count > 1 ? `\n${c.count} movimientos con ese importe: se muestra ${c.cited ? 'el que se cita' : 'el de fecha más cercana'}` : ''}`}>
        <Shuffle size={12} className="mt-0.5 shrink-0" />
        <span>
          <span className="font-semibold">{c.entityName}</span>
          <span className="block text-[11px] opacity-80">{sideLabel(c.type)} {c.entityNo} · {c.documentType} {c.documentNo} · {nf(c.remaining)} · {c.reason === 'cited' ? 'se citan' : 'nombre parecido'}{c.count > 1 ? ` · ${c.count} posibles` : ''}</span>
        </span>
      </span>
      {sent
        ? <span className="text-[11px] font-semibold text-sky-700 whitespace-nowrap">{sent}</span>
        : <button onClick={onClose} className="shrink-0 text-[11px] font-semibold border border-gray-300 rounded px-1.5 py-0.5 bg-white hover:bg-gray-50 whitespace-nowrap">Cerrar ambos</button>}
    </div>
  );
}

// Diálogo: dos líneas al lote del General Journal, misma fecha y mismo asiento, sin contrapartida (suman 0)
function ClearDialog({ entry, nf, onCancel, onSent }: { entry: any; nf: (v: number) => string; onCancel: () => void; onSent: (text: string) => void }) {
  const c: Cross = entry.cross;
  const [journals, setJournals] = useState<{ code: string; name: string; bankNo: string }[]>([]);
  const [journalCode, setJournalCode] = useState('');
  // BC no deja liquidar un movimiento posterior a la fecha del asiento: como mínimo, la del más reciente de los dos
  const minDate = [entry.postingDate, c.postingDate].filter(Boolean).sort().pop() || '';
  const [date, setDate] = useState(() => { const t = new Date().toISOString().substring(0, 10); return t < minDate ? minDate : t; });
  const tooEarly = !!minDate && date < minDate;
  const [busy, setBusy] = useState('Cargando lotes…');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ documentNumber: string; warnings: string[] } | null>(null);
  const descr = `Cierre ${entry.documentNo} / ${c.documentNo}`;
  const lines = [
    { accountType: entry.type, accountNo: entry.entityNo, name: entry.entityName, amount: -entry.remainingAmount, description: descr, appliesToDocType: entry.documentType, appliesToDocNo: entry.documentNo, currencyCode: entry.currencyCode || '', postingDate: entry.postingDate },
    { accountType: c.type, accountNo: c.entityNo, name: c.entityName, amount: -c.remaining, description: descr, appliesToDocType: c.documentType, appliesToDocNo: c.documentNo, currencyCode: entry.currencyCode || '', postingDate: c.postingDate },
  ];

  // Mismo lote por defecto que BANCO: el de la cuenta de banco que se usó la última vez
  useEffect(() => {
    fetch('/api/banco').then(r => r.json()).then(d => {
      if (d.error) throw new Error(d.error);
      setJournals(d.journals || []);
      let bank = '';
      try { bank = localStorage.getItem('crz-banco-bank') || ''; } catch { /* sin almacenamiento */ }
      const js = d.journals || [];
      const banks = d.banks || [];
      const firstBank = banks.find((b: any) => js.some((j: any) => j.bankNo === b.number))?.number;
      setJournalCode((js.find((j: any) => j.bankNo === bank) || js.find((j: any) => j.bankNo === firstBank) || js[0])?.code || '');
    }).catch(e => setError(e.message)).finally(() => setBusy(''));
  }, []);

  const send = async () => {
    setBusy('Enviando al lote…'); setError('');
    try {
      const res = await fetch('/api/ledger-entries/clear', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journalCode, date, lines: lines.map(({ name, ...l }) => l) }), // eslint-disable-line @typescript-eslint/no-unused-vars
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setResult(d);
      onSent(`En el lote ${journalCode}${d.documentNumber ? ` · ${d.documentNumber}` : ''}`);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };

  const input = 'border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm bg-white';
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-bold text-gray-900">Cerrar ambos movimientos</p>
            <p className="text-xs text-gray-500">Dos líneas en el General Journal (sin registrar), misma fecha y mismo nº de documento, sin cuenta de contrapartida.</p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Lote del General Journal
            <select value={journalCode} onChange={e => setJournalCode(e.target.value)} className={`${input} block mt-1 normal-case tracking-normal font-normal min-w-56`}>
              {journals.map(j => <option key={j.code} value={j.code}>{j.code}{j.name && j.name !== j.code ? ` · ${j.name}` : ''}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Fecha
            <input type="date" value={date} min={minDate || undefined} onChange={e => setDate(e.target.value)} className={`${input} block mt-1 normal-case tracking-normal font-normal ${tooEarly ? 'border-red-400' : ''}`} />
            {tooEarly && <span className="block mt-1 normal-case tracking-normal font-normal text-red-600">No antes del {minDate.split('-').reverse().join('/')}</span>}
          </label>
        </div>
        <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
          <thead className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500">
            <tr><th className="px-3 py-2 text-left">Cuenta</th><th className="px-3 py-2 text-left">Liquida</th><th className="px-3 py-2 text-left">Descripción</th><th className="px-3 py-2 text-right">Importe</th></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="px-3 py-2"><span className="font-semibold">{sideLabel(l.accountType)} {l.accountNo}</span><span className="block text-xs text-gray-500">{l.name}</span></td>
                <td className="px-3 py-2 font-mono text-xs">{l.appliesToDocType} {l.appliesToDocNo}</td>
                <td className="px-3 py-2 text-gray-700">{l.description}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">{nf(l.amount)} {l.currencyCode || 'EUR'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        {result && (
          <div className="text-sm bg-sky-50 border border-sky-200 text-sky-800 rounded-lg px-3 py-2">
            <p className="font-semibold">Líneas creadas en el lote {journalCode}{result.documentNumber ? ` · ${result.documentNumber}` : ''} (sin registrar)</p>
            {result.warnings.map((w, i) => <p key={i} className="text-amber-800">{w}</p>)}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm font-semibold border border-gray-300 rounded-lg bg-white hover:bg-gray-50">{result ? 'Cerrar' : 'Cancelar'}</button>
          {!result && (
            <button onClick={send} disabled={!journalCode || !date || tooEarly || !!busy}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-semibold rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50">
              {busy ? <RefreshCcw size={15} className="animate-spin" /> : <Send size={15} />} {busy || `Enviar al lote ${journalCode || '…'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Comentario editable de una línea: se guarda al salir del campo o con Enter (vacío = se borra)
function CommentCell({ value, onSave }: { value?: { text: string; by?: string; at: string }; onSave: (t: string) => void }) {
  const [text, setText] = useState(value?.text || '');
  return (
    <input value={text} onChange={e => setText(e.target.value)} onBlur={() => onSave(text)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      placeholder="Añadir comentario…" title={value ? `${value.by ? `${value.by} · ` : ''}${value.at.substring(0, 10)}` : undefined}
      className={`w-full rounded px-2 py-1 text-sm border ${text ? 'border-indigo-200 bg-indigo-50/50 text-gray-900' : 'border-transparent hover:border-gray-200 text-gray-700'} focus:border-gray-400 focus:bg-white outline-none`} />
  );
}

// Sugerencia para cerrar el movimiento con otros abiertos del mismo cliente / proveedor
const SUGGESTION = {
  exact_ref: { rank: 0, label: 'Mismo importe y se citan', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  exact: { rank: 1, label: 'Mismo importe', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  combo: { rank: 2, label: 'Suman el importe', cls: 'bg-sky-50 text-sky-800 border-sky-200' },
  ref: { rank: 3, label: 'Se citan (otro importe)', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
} as const;
type Sug = { kind: keyof typeof SUGGESTION; note: string; entries: { entryNo: number; documentType: string; documentNo: string; postingDate: string | null; remaining: number }[] };
function SuggestionCell({ s, nf, dateEs }: { s?: Sug | null; nf: (v: number) => string; dateEs: (d: string) => string }) {
  if (!s) return <span className="text-gray-300">—</span>;
  const k = SUGGESTION[s.kind];
  const tip = `${s.note}\n${s.entries.map(e => `${e.documentType} ${e.documentNo} · ${dateEs(e.postingDate || '')} · ${nf(e.remaining)}`).join('\n')}`;
  return (
    <span className={`inline-flex items-start gap-1 border rounded px-1.5 py-0.5 text-xs ${k.cls}`} title={tip}>
      <Lightbulb size={12} className="mt-0.5 shrink-0" />
      <span>
        <span className="font-semibold">{s.entries.map(e => e.documentNo).join(' + ')}</span>
        <span className="block text-[11px] opacity-80">{k.label}{s.entries.length === 1 ? ` · ${s.entries[0].documentType} ${nf(s.entries[0].remaining)}` : ''}</span>
      </span>
    </span>
  );
}
