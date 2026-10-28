'use client';

import { useState, useEffect, useMemo } from 'react';
import { RefreshCcw, User, Building2, CheckCircle } from 'lucide-react';
import DocPdfLink, { purchasePdfKind } from '@/components/DocPdfLink';

export default function MovimientosPage() {
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

  // Apply filters
  const filteredEntries = useMemo(() => {
    return entries.filter(e => {
      if (e.type !== viewMode) return false;
      if (selectedDocTypes.length > 0 && !selectedDocTypes.includes(e.documentType)) return false;
      if (selectedPaymentMethods.length > 0 && !selectedPaymentMethods.includes(e.paymentMethodCode)) return false;
      return true;
    });
  }, [entries, viewMode, selectedDocTypes, selectedPaymentMethods]);

  // Clear filters when switching view modes
  useEffect(() => {
    setSelectedDocTypes([]);
    setSelectedPaymentMethods([]);
  }, [viewMode]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 p-8 pb-32">
      <header className="flex flex-wrap justify-between items-end mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-extrabold text-black tracking-tight">
            Movimientos Abiertos
          </h1>
          <p className="text-gray-700 font-semibold mt-2">Consulta de entradas contables para Clientes y Proveedores.</p>
        </div>
        <div className="flex gap-4">
          <button 
            onClick={fetchEntries}
            className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg transition-all backdrop-blur-sm border border-white/10"
          >
            <RefreshCcw size={18} className={loading ? 'animate-spin' : ''} />
            Actualizar
          </button>
        </div>
      </header>

      {/* View Toggle */}
      <div className="flex justify-center mb-8">
        <div className="bg-slate-900/80 p-1 rounded-xl flex border border-white/10 backdrop-blur-md">
          <button
            onClick={() => setViewMode('Customer')}
            className={`flex items-center gap-2 px-8 py-3 rounded-lg font-medium transition-all ${
              viewMode === 'Customer'
                ? 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white shadow-lg'
                : 'text-gray-900 font-bold hover:text-white hover:bg-white/5'
            }`}
          >
            <User size={18} />
            Clientes
          </button>
          <button
            onClick={() => setViewMode('Vendor')}
            className={`flex items-center gap-2 px-8 py-3 rounded-lg font-medium transition-all ${
              viewMode === 'Vendor'
                ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg'
                : 'text-gray-900 font-bold hover:text-white hover:bg-white/5'
            }`}
          >
            <Building2 size={18} />
            Proveedores
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap gap-6 bg-white/5 p-4 rounded-xl border border-white/10 backdrop-blur-sm">
        {/* Document Type Filter */}
        {availableDocTypes.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-gray-800 font-medium font-medium">Filtrar por Tipo de Documento:</span>
            <div className="flex flex-wrap gap-2">
              {availableDocTypes.map(dt => (
                <button
                  key={dt}
                  onClick={() => {
                    if (selectedDocTypes.includes(dt)) {
                      setSelectedDocTypes(prev => prev.filter(d => d !== dt));
                    } else {
                      setSelectedDocTypes(prev => [...prev, dt]);
                    }
                  }}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    selectedDocTypes.includes(dt)
                      ? 'bg-indigo-500/20 text-indigo-700 font-bold border-indigo-500/50 shadow-[0_0_10px_rgba(99,102,241,0.2)]'
                      : 'bg-white/5 text-gray-900 font-bold border-white/10 hover:bg-white/10 hover:text-gray-800 font-medium'
                  }`}
                >
                  {dt || 'Vacio'}
                </button>
              ))}
              {selectedDocTypes.length > 0 && (
                <button 
                  onClick={() => setSelectedDocTypes([])}
                  className="px-2 py-1 text-xs text-gray-700 font-semibold font-bold hover:text-red-300 transition-colors underline decoration-red-400/30 underline-offset-2 ml-2"
                >
                  Limpiar Filtro
                </button>
              )}
            </div>
          </div>
        )}

        {/* Payment Method Filter */}
        {availablePaymentMethods.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-gray-800 font-medium font-medium">Filtrar por Forma de Pago:</span>
            <div className="flex flex-wrap gap-2">
              {availablePaymentMethods.map(pm => (
                <button
                  key={pm}
                  onClick={() => {
                    if (selectedPaymentMethods.includes(pm)) {
                      setSelectedPaymentMethods(prev => prev.filter(p => p !== pm));
                    } else {
                      setSelectedPaymentMethods(prev => [...prev, pm]);
                    }
                  }}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    selectedPaymentMethods.includes(pm)
                      ? 'bg-indigo-500/20 text-indigo-700 font-bold border-indigo-500/50 shadow-[0_0_10px_rgba(99,102,241,0.2)]'
                      : 'bg-white/5 text-gray-900 font-bold border-white/10 hover:bg-white/10 hover:text-gray-800 font-medium'
                  }`}
                >
                  {pm || 'Vacio'}
                </button>
              ))}
              {selectedPaymentMethods.length > 0 && (
                <button 
                  onClick={() => setSelectedPaymentMethods([])}
                  className="px-2 py-1 text-xs text-gray-700 font-semibold font-bold hover:text-red-300 transition-colors underline decoration-red-400/30 underline-offset-2 ml-2"
                >
                  Limpiar Filtro
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="text-center py-20 bg-white/5 rounded-2xl border border-white/10 backdrop-blur-sm shadow-lg">
          <CheckCircle className="mx-auto text-gray-900 font-bold mb-4" size={48} />
          <p className="text-xl text-gray-800 font-medium">No hay movimientos que coincidan con los filtros.</p>
        </div>
      ) : (
        <div className="bg-white/5 rounded-xl border border-white/10 backdrop-blur-sm overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-gray-800 font-medium">
              <thead className="bg-slate-900/50 text-gray-900 font-bold border-b border-white/10">
                <tr>
                  <th className="p-4 font-medium whitespace-nowrap">Nº {viewMode === 'Customer' ? 'Cliente' : 'Proveedor'}</th>
                  <th className="p-4 font-medium">Nombre</th>
                  <th className="p-4 font-medium">Posting Date</th>
                  <th className="p-4 font-medium">Doc. Type</th>
                  <th className="p-4 font-medium">Document No.</th>
                  <th className="p-4 font-medium">Ext. Doc. No.</th>
                  <th className="p-4 font-medium">Currency</th>
                  <th className="p-4 font-medium text-right">Original Amt.</th>
                  <th className="p-4 font-medium text-right">Remaining Amt.</th>
                  <th className="p-4 font-medium">Description</th>
                  <th className="p-4 font-medium">Payment Method</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredEntries.map((entry, idx) => (
                  <tr key={idx} className="hover:bg-white/5 transition-colors">
                    <td className="p-4 text-indigo-700 font-bold font-medium whitespace-nowrap">{entry.entityNo}</td>
                    <td className="p-4 text-white font-medium min-w-[200px]">{entry.entityName}</td>
                    <td className="p-4 text-gray-900 font-bold whitespace-nowrap">
                      {entry.postingDate ? new Date(entry.postingDate).toLocaleDateString() : '-'}
                    </td>
                    <td className="p-4">
                      <span className="px-2 py-1 rounded bg-gray-50 border border-gray-200 text-xs">
                        {entry.documentType || '-'}
                      </span>
                    </td>
                    <td className="p-4 text-gray-800 font-medium whitespace-nowrap">
                      {entry.documentNo}
                      {entry.type === 'Vendor' && <DocPdfLink documentNo={entry.documentNo} kind={purchasePdfKind(entry.documentType)} />}
                    </td>
                    <td className="p-4 text-gray-900 font-bold">{entry.externalDocumentNo || '-'}</td>
                    <td className="p-4 text-gray-900 font-bold">{entry.currencyCode || 'EUR'}</td>
                    <td className="p-4 text-right text-gray-800 font-medium">
                      {entry.originalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="p-4 text-right font-semibold text-gray-900 font-bold">
                      {entry.remainingAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="p-4 text-gray-900 font-bold min-w-[250px]">{entry.description}</td>
                    <td className="p-4 text-gray-700 font-semibold">{entry.paymentMethodCode || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
