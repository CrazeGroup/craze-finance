'use client';

import { useEffect, useState, useMemo } from 'react';
import { syncFromBc } from '@/lib/syncClient';
import { RefreshCcw, CheckCircle, ChevronDown, ChevronRight, FileText, CheckCircle2, XCircle, Clock } from 'lucide-react';

// Empresa activa (cookie que escribe CompanyContext)
const getSelectedCompany = () => decodeURIComponent(document.cookie.match(/(?:^|; )craze_selected_company=([^;]*)/)?.[1] || 'CRAZE');

export default function PagosPage() {
  const [rawInvoices, setRawInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // UI State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPaymentMethods, setSelectedPaymentMethods] = useState<string[]>([]);
  const [vendorSortBy, setVendorSortBy] = useState<'amtOpen' | 'amtOverdue'>('amtOverdue');
  const [invoiceSortBy, setInvoiceSortBy] = useState<'daysOverdue' | 'amount'>('daysOverdue');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const availablePaymentMethods = useMemo(() => {
    const methods = new Set<string>();
    rawInvoices.forEach(inv => {
      if (inv.paymentMethod) methods.add(inv.paymentMethod);
    });
    return Array.from(methods).sort();
  }, [rawInvoices]);

  const fetchInvoices = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/purchase-invoices', { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data)) {
        // Filter out closed invoices per user request
        setRawInvoices(data.filter(inv => inv.status !== 'Closed'));
      }
    } catch (error) {
      console.error('Failed to fetch purchase invoices', error);
    } finally {
      setLoading(false);
    }
  };

  const [syncing, setSyncing] = useState(false);
  const handleSync = async () => {
    setSyncing(true);
    try {
      // Paso a paso por empresa (una sola llamada con todo pasa del límite de 60 s de Vercel)
      const errors = await syncFromBc(getSelectedCompany());
      if (errors.length) console.error('Sync errors', errors);
      await fetchInvoices();
    } catch (error) {
      console.error('Failed to sync', error);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchInvoices();
  }, []);

  const toggleExpand = (vendorId: number) => {
    setExpanded(prev => ({ ...prev, [vendorId]: !prev[vendorId] }));
  };

  const groupedData = useMemo(() => {
    const map = new Map<string, any>();
    const query = searchQuery.toLowerCase().trim();
    const methodsFilter = new Set(selectedPaymentMethods);

    const matchingInvoiceIds = new Set<number>();
    const matchingVendorIds = new Set<string>();

    if (query) {
      rawInvoices.forEach(inv => {
        const vId = inv.vendor?.bcId || String(inv.vendorId);
        const vName = (inv.vendor?.name || '').toLowerCase();
        
        if (vId.toLowerCase().includes(query) || vName.includes(query)) {
          matchingVendorIds.add(vId);
        }
        if (inv.bcId.toLowerCase().includes(query)) {
          matchingInvoiceIds.add(inv.id);
        }
      });
    }

    rawInvoices.forEach(inv => {
      const vId = inv.vendor?.bcId || String(inv.vendorId);
      
      if (query) {
        const isVendorMatch = matchingVendorIds.has(vId);
        const isInvoiceMatch = matchingInvoiceIds.has(inv.id);
        if (!isVendorMatch && !isInvoiceMatch) return;
      }
      
      if (methodsFilter.size > 0 && !methodsFilter.has(inv.paymentMethod)) return;

      if (!map.has(vId)) {
        map.set(vId, {
          vendor: inv.vendor,
          invoices: [],
          totalCount: 0,
          amtOpen: 0,
          amtOverdue: 0,
          sumDaysOverdue: 0,
          overdueCount: 0
        });
      }
      const group = map.get(vId);
      group.invoices.push(inv);
      group.totalCount += 1;
      group.amtOpen += (inv.amount || 0);
      if (inv.isOverdue) {
        group.amtOverdue += (inv.amount || 0);
        group.sumDaysOverdue += (inv.daysOverdue || 0);
        group.overdueCount += 1;
      }
    });

    const arr = Array.from(map.values()).map(g => ({
      ...g,
      avgDaysOverdue: g.overdueCount > 0 ? Math.round(g.sumDaysOverdue / g.overdueCount) : 0
    }));

    arr.sort((a, b) => {
      if (vendorSortBy === 'amtOpen') return b.amtOpen - a.amtOpen;
      if (vendorSortBy === 'amtOverdue') return b.amtOverdue - a.amtOverdue;
      return 0;
    });

    arr.forEach(g => {
      g.invoices.sort((a: any, b: any) => {
        if (invoiceSortBy === 'daysOverdue') return b.daysOverdue - a.daysOverdue;
        if (invoiceSortBy === 'amount') return b.amount - a.amount;
        return 0;
      });
    });

    return arr;
  }, [rawInvoices, vendorSortBy, invoiceSortBy, searchQuery, selectedPaymentMethods]);

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-32">
      <header className="flex flex-wrap justify-between items-end mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-extrabold text-black tracking-tight">
            Pagos a Proveedores
          </h1>
          <p className="text-gray-700 font-semibold mt-2">Agrupación por proveedor y estado de aprobación de facturas.</p>
        </div>
        <div className="flex gap-4">
          <button 
            onClick={fetchInvoices}
            className="flex items-center gap-2 bg-white/10 hover:bg-gray-200 text-gray-900 px-4 py-2 rounded-lg transition-all backdrop-blur-sm border border-gray-200"
            disabled={loading || syncing}
          >
            <RefreshCcw size={18} className={loading && !syncing ? 'animate-spin' : ''} />
            Actualizar Local
          </button>
          <button 
            onClick={handleSync}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-gray-900 px-4 py-2 rounded-lg transition-all shadow-lg shadow-gray-500/20"
            disabled={loading || syncing}
          >
            <RefreshCcw size={18} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Sincronizando... (espera 1-2 min)' : 'Sincronizar BC'}
          </button>
        </div>
      </header>

      <div className="mb-6 flex flex-col md:flex-row gap-6 bg-gray-50 p-4 rounded-xl border border-gray-200 backdrop-blur-sm">
        <div className="flex-1">
          <input 
            type="text" 
            placeholder="Buscar por proveedor o nº factura..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white border border-gray-300 text-sm text-gray-900 rounded-lg px-4 py-2 outline-none focus:border-indigo-500 transition-colors placeholder-gray-500"
          />
        </div>
        
        <div className="flex flex-wrap gap-6 items-center">

          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-800 font-medium font-medium">Ordenar Proveedores por:</span>
            <select 
              className="bg-white border border-gray-300 text-sm text-gray-900 rounded-lg px-3 py-1.5 outline-none"
              value={vendorSortBy}
              onChange={(e) => setVendorSortBy(e.target.value as any)}
            >
              <option value="amtOverdue">Mayor Importe Vencido</option>
              <option value="amtOpen">Mayor Importe Total Abierto</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-800 font-medium font-medium">Ordenar Facturas por:</span>
            <select 
              className="bg-white border border-gray-300 text-sm text-gray-900 rounded-lg px-3 py-1.5 outline-none"
              value={invoiceSortBy}
              onChange={(e) => setInvoiceSortBy(e.target.value as any)}
            >
              <option value="daysOverdue">Más días vencidos</option>
              <option value="amount">Mayor importe</option>
            </select>
          </div>
        </div>
      </div>

      {/* Payment Method Filters */}
      {availablePaymentMethods.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-4 items-center bg-gray-50 p-4 rounded-xl border border-gray-200 backdrop-blur-sm">
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
                    : 'bg-gray-50 text-gray-900 font-bold border-gray-200 hover:bg-gray-200 hover:text-gray-800 font-medium'
                }`}
              >
                {pm}
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

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-purple-400"></div>
        </div>
      ) : groupedData.length === 0 ? (
        <div className="text-center py-20 bg-gray-50 rounded-2xl border border-gray-200 backdrop-blur-sm shadow-lg">
          <CheckCircle className="mx-auto text-gray-900 font-bold mb-4" size={48} />
          <p className="text-xl text-gray-800 font-medium">No hay facturas de proveedor abiertas.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedData.map((group) => {
            const isExpanded = expanded[group.vendor.id];

            return (
              <div key={group.vendor.bcId} className="rounded-xl border border-gray-200 bg-white/10 backdrop-blur-md shadow-xl overflow-hidden transition-all duration-300">
                <div 
                  className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between p-4 cursor-pointer hover:bg-gray-200 transition-colors gap-4"
                  onClick={() => toggleExpand(group.vendor.id)}
                >
                  <div className="flex items-center gap-4 flex-1 min-w-[250px]">
                    <div className="text-slate-500">
                      {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                    </div>
                    <div>
                      <h3 className="font-bold text-lg text-gray-900">
                        <span className="text-gray-700 font-semibold font-normal mr-2">#{group.vendor.bcId}</span>
                        {group.vendor.name}
                      </h3>
                      <p className="text-xs text-gray-700 font-semibold">{group.vendor.email || 'Sin email configurado'}</p>
                    </div>
                  </div>
                  
                  <div className="flex flex-wrap gap-6 text-sm flex-1 min-w-[350px]">
                    <div className="flex flex-col">
                      <span className="text-purple-700 font-bold text-xs">Total a Pagar</span>
                      <span className={`font-medium ${group.amtOpen > 0 ? 'text-gray-900 font-bold' : group.amtOpen < 0 ? 'text-gray-700 font-semibold font-bold' : 'text-gray-900'}`}>€{group.amtOpen.toLocaleString()}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-purple-700 font-bold text-xs">Total Vencido</span>
                      <span className={`font-medium ${group.amtOverdue > 0 ? 'text-gray-900 font-bold' : group.amtOverdue < 0 ? 'text-gray-700 font-semibold font-bold' : 'text-gray-900'}`}>€{group.amtOverdue.toLocaleString()}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-purple-700 font-bold text-xs">Documentos</span>
                      <span className="font-medium text-gray-900">{group.totalCount} ({group.overdueCount} vencidas)</span>
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="bg-white/40 p-4 border-t border-gray-200">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm text-gray-800 font-medium">
                        <thead className="text-gray-900 font-bold border-b border-gray-200">
                          <tr>
                            <th className="pb-2 font-medium">Documento</th>
                            <th className="pb-2 font-medium">Tipo</th>
                            <th className="pb-2 font-medium">Forma Pago</th>
                            <th className="pb-2 font-medium">Moneda</th>
                            <th className="pb-2 font-medium">Imp. Original</th>
                            <th className="pb-2 font-medium">Imp. Restante</th>
                            <th className="pb-2 font-medium">Vencimiento</th>
                            <th className="pb-2 font-medium">Fecha Pago Prevista</th>
                            <th className="pb-2 font-medium">Aprobación</th>
                            <th className="pb-2 font-medium">No Pagar</th>
                            <th className="pb-2 font-medium">Asignados</th>
                            <th className="pb-2 font-medium">Han Aprobado</th>
                            <th className="pb-2 font-medium">Faltan</th>
                            <th className="pb-2 font-medium">Rechazados</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {group.invoices.map((inv: any) => {
                            const assignedList = inv.approvalUsers ? inv.approvalUsers.split('|').filter(Boolean) : [];
                            const approvedList = inv.approvedUsers ? inv.approvedUsers.split('|').filter(Boolean) : [];
                            const rejectedList = inv.rejectedUsers ? inv.rejectedUsers.split('|').filter(Boolean) : [];
                            const pendingList = assignedList.filter((u: string) => !approvedList.includes(u) && !rejectedList.includes(u));

                            return (
                              <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                                <td className="py-2 font-bold text-slate-900">
                                  <div className="flex items-center gap-2">
                                    <FileText size={14} className="text-black" />
                                    {inv.bcId}
                                  </div>
                                </td>
                                <td className="py-2">
                                  <span className={inv.type === 'Credit Memo' ? 'text-gray-900 font-bold font-medium' : 'text-gray-600'}>{inv.type}</span>
                                </td>
                                <td className="py-2 text-gray-700 font-semibold">{inv.paymentMethod || '-'}</td>
                                <td className="py-2 text-gray-600">{inv.currencyCode || '-'}</td>
                                <td className="py-2 text-gray-900 font-bold">€{(inv.originalAmount || 0).toLocaleString()}</td>
                                <td className="py-2 font-semibold">
                                  <span className={inv.amount > 0 ? "text-gray-900 font-bold" : inv.amount < 0 ? "text-gray-700 font-semibold font-bold" : "text-gray-900"}>€{inv.amount.toLocaleString()}</span>
                                </td>
                                <td className="py-2 text-gray-700 font-semibold">
                                  <div className="flex items-center gap-2">
                                    {new Date(inv.dueDate).toLocaleDateString()}
                                    {inv.isOverdue && <span className="text-[10px] uppercase tracking-wider bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded border border-red-500/30">Vencida</span>}
                                  </div>
                                </td>
                                <td className="py-2 text-gray-700 font-semibold">
                                  {inv.schedulePaymentDate ? new Date(inv.schedulePaymentDate).toLocaleDateString() : <span className="text-slate-600">-</span>}
                                </td>
                                <td className="py-2">
                                  {inv.skipApproval ? (
                                    <span className="flex items-center gap-1 text-slate-500"><CheckCircle2 size={14}/> Omitida</span>
                                  ) : inv.percentagePaymentApproval > 0 ? (
                                    <div className="flex flex-col gap-1 w-24">
                                      <div className="flex justify-between items-center text-xs">
                                        <span className={inv.percentagePaymentApproval === 100 ? "text-gray-900 font-bold font-medium" : "text-amber-400 font-medium"}>
                                          {inv.percentagePaymentApproval}%
                                        </span>
                                      </div>
                                      <div className="w-full bg-gray-50 rounded-full h-1.5 overflow-hidden">
                                        <div 
                                          className={`h-1.5 rounded-full ${inv.percentagePaymentApproval === 100 ? 'bg-emerald-400' : 'bg-amber-400'}`} 
                                          style={{ width: `${inv.percentagePaymentApproval}%` }}
                                        />
                                      </div>
                                    </div>
                                  ) : (
                                    <span className="text-slate-500 text-xs">0%</span>
                                    )}
                                  </td>
                                  <td className="py-2 text-xs">
                                    {inv.noPayment ? (
                                      <span className="flex items-center gap-1 text-gray-700 font-semibold font-bold font-medium cursor-help" title={inv.noPaymentReason || 'Retenido'}>
                                        <XCircle size={14}/> Sí
                                      </span>
                                    ) : (
                                      <span className="text-slate-500">-</span>
                                    )}
                                  </td>
                                  <td className="py-2 text-xs">
                                  <div className="flex flex-col gap-1 text-gray-600">
                                    {assignedList.length > 0 ? assignedList.map((u: string, idx: number) => <span key={idx} className="break-words">{u.replace(/\./g, ' ')}</span>) : '-'}
                                  </div>
                                </td>
                                <td className="py-2 text-xs">
                                  <div className="flex flex-col gap-1 text-gray-900 font-bold">
                                    {approvedList.length > 0 ? approvedList.map((u: string, idx: number) => <span key={idx} className="break-words flex items-center gap-1"><CheckCircle2 size={12}/>{u.replace(/\./g, ' ')}</span>) : <span className="text-slate-500">-</span>}
                                  </div>
                                </td>
                                <td className="py-2 text-xs">
                                  <div className="flex flex-col gap-1 text-amber-400">
                                    {pendingList.length > 0 ? pendingList.map((u: string, idx: number) => <span key={idx} className="break-words flex items-center gap-1"><Clock size={12}/>{u.replace(/\./g, ' ')}</span>) : <span className="text-slate-500">-</span>}
                                  </div>
                                </td>
                                <td className="py-2 text-xs">
                                  <div className="flex flex-col gap-1 text-gray-700 font-semibold font-bold">
                                    {rejectedList.length > 0 ? rejectedList.map((u: string, idx: number) => <span key={idx} className="break-words flex items-center gap-1"><XCircle size={12}/>{u.replace(/\./g, ' ')}</span>) : <span className="text-slate-500">-</span>}
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
