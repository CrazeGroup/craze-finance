'use client';

import { useState, useEffect, useMemo } from 'react';
import { RefreshCcw, User, Building2, CheckCircle, ArrowUp, ArrowDown } from 'lucide-react';
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

  const fetchEntries = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ledger-entries', { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data)) {
        setEntries(data);
      } else {
        alert(data?.error ? `Error al cargar movimientos: ${data.error}` : 'Error al cargar movimientos');
      }
    } catch (e) {
      console.error(e);
      alert('Error en conexión');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEntries();
  }, []);

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
  useEffect(() => { try { setNoAmazon(localStorage.getItem('movimientos:sinAmazon') === '1'); } catch { /* sin almacenamiento */ } }, []);
  const changeNoAmazon = (v: boolean) => { setNoAmazon(v); try { localStorage.setItem('movimientos:sinAmazon', v ? '1' : '0'); } catch { /* sin almacenamiento */ } };

  // Orden por columna (clic en la cabecera: ascendente, descendente)
  type SortKey = 'entityNo' | 'entityName' | 'postingDate' | 'documentType' | 'documentNo' | 'externalDocumentNo' | 'currencyCode' | 'originalAmount' | 'remainingAmount' | 'description' | 'paymentMethodCode';
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const sortBy = (key: SortKey) => setSort(p => (p?.key === key ? (p.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));

  // Apply filters
  const filteredEntries = useMemo(() => {
    const list = entries.filter(e => {
      if (e.type !== viewMode) return false;
      if (noAmazon && /amazon/i.test(e.entityName || '')) return false;
      if (selectedDocTypes.length > 0 && !selectedDocTypes.includes(e.documentType)) return false;
      if (selectedPaymentMethods.length > 0 && !selectedPaymentMethods.includes(e.paymentMethodCode)) return false;
      return true;
    });
    if (!sort) return list;
    const { key, dir } = sort;
    const num = key === 'originalAmount' || key === 'remainingAmount';
    return [...list].sort((a, b) => {
      if (num) return ((Number(a[key]) || 0) - (Number(b[key]) || 0)) * dir;
      return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'es', { numeric: true, sensitivity: 'base' }) * dir;
    });
  }, [entries, viewMode, selectedDocTypes, selectedPaymentMethods, noAmazon, sort]);
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
            <p className="ml-auto self-end text-xs text-gray-500">{filteredEntries.length} movimientos</p>
          </section>
        )}

        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 py-16 flex justify-center text-sm text-gray-500 gap-2 items-center">
            <RefreshCcw size={16} className="animate-spin" /> Cargando movimientos…
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 py-16 text-center">
            <CheckCircle className="mx-auto text-emerald-500 mb-3" size={36} />
            <p className="text-sm text-gray-600">No hay movimientos que coincidan con los filtros.</p>
          </div>
        ) : (
          <section className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {([
                    ['entityNo', `Nº ${viewMode === 'Customer' ? 'cliente' : 'proveedor'}`], ['entityName', 'Nombre'], ['postingDate', 'Posting Date'],
                    ['documentType', 'Doc. Type'], ['documentNo', 'Document No.'], ['externalDocumentNo', 'Ext. Doc. No.'], ['currencyCode', 'Divisa'],
                    ['originalAmount', 'Original Amt.', true], ['remainingAmount', 'Remaining Amt.', true], ['description', 'Description'], ['paymentMethodCode', 'Payment Method'],
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
                    <td className="px-3 py-2 font-semibold text-gray-900 min-w-[200px]">{entry.entityName}</td>
                    <td className="px-3 py-2 text-gray-600 tabular-nums whitespace-nowrap">{dateEs(entry.postingDate)}</td>
                    <td className="px-3 py-2">
                      <span className="px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-xs font-semibold text-gray-700 whitespace-nowrap">{entry.documentType || '—'}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-900 whitespace-nowrap">
                      {entry.documentNo}
                      {entry.type === 'Vendor' && <DocPdfLink documentNo={entry.documentNo} kind={purchasePdfKind(entry.documentType)} />}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-600">{entry.externalDocumentNo || '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{entry.currencyCode || 'EUR'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600 whitespace-nowrap">{nf(entry.originalAmount)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold whitespace-nowrap ${entry.remainingAmount < 0 ? 'text-red-600' : 'text-gray-900'}`}>{nf(entry.remainingAmount)}</td>
                    <td className="px-3 py-2 text-gray-700 min-w-[250px]">{entry.description}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{entry.paymentMethodCode || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </div>
  );
}
