'use client';

import { useEffect, useState, useMemo } from 'react';
import { CustomerCard } from '@/components/CustomerCard';
import { RefreshCcw } from 'lucide-react';

export default function Dashboard() {
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Filtros y ordenación
  const [showZeroBalance, setShowZeroBalance] = useState(true);
  const [sortMode, setSortMode] = useState<string>('none');
  const [paymentFilters, setPaymentFilters] = useState<string[]>([]);
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [layoutMode, setLayoutMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');

  const fetchCustomers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/customers', { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data)) {
        setCustomers(data);
      }
    } catch (error) {
      console.error('Failed to fetch customers', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCustomers();
  }, []);

  const paymentMethods = Array.from(new Set(customers.map(c => c.paymentMethod || 'Empty'))).filter(Boolean) as string[];
  const statuses = Array.from(new Set(customers.map(c => c.calculatedRisk || 'Unknown'))).filter(Boolean) as string[];

  const filteredAndSortedCustomers = useMemo(() => {
    let result = [...customers];
    
    if (searchQuery) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(c => 
        (c.name && c.name.toLowerCase().includes(q)) || 
        (String(c.bcId || '').toLowerCase().includes(q))
      );
    }

    if (!showZeroBalance) {
      result = result.filter(c => c.balance !== 0);
    }
    
    if (paymentFilters.length > 0) {
      result = result.filter(c => paymentFilters.includes(c.paymentMethod || 'Empty'));
    }
    
    if (statusFilters.length > 0) {
      result = result.filter(c => statusFilters.includes(c.calculatedRisk || 'Unknown'));
    }
    
    if (sortMode === 'balance') {
      result.sort((a, b) => b.balance - a.balance);
    } else if (sortMode === 'riskLimit') {
      result.sort((a, b) => b.riskLimit - a.riskLimit);
    }
    
    return result;
  }, [customers, showZeroBalance, sortMode, paymentFilters, statusFilters, searchQuery]);

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-32">
      <div className="w-full">
        <header className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-4xl font-black text-black tracking-tight">
              Análisis de Riesgos
            </h1>
            <p className="text-gray-700 font-semibold font-medium mt-2">Optimización Financiera - Craze</p>
          </div>
          <button 
            onClick={fetchCustomers}
            className="flex items-center gap-2 bg-white/10 hover:bg-gray-200 text-gray-900 px-4 py-2 rounded-lg transition-all backdrop-blur-sm border border-gray-200"
          >
            <RefreshCcw size={18} className={loading ? 'animate-spin' : ''} />
            Actualizar Datos
          </button>
        </header>

        {/* Controls */}
        <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 backdrop-blur-sm mb-6 flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-4 items-center">
            {/* Search Input */}
            <input
              type="text"
              placeholder="Buscar cliente por nombre o ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-white text-sm text-gray-900 px-3 py-1.5 rounded border border-gray-200 focus:outline-none focus:ring-1 focus:ring-black min-w-[200px]"
            />

            {/* Show zero balance toggle */}
            <button 
              onClick={() => setShowZeroBalance(!showZeroBalance)}
              className={`px-3 py-1.5 rounded text-sm transition-colors border ${showZeroBalance ? 'bg-gray-200 text-black border-gray-300' : 'bg-white text-gray-700 font-semibold border-gray-200'}`}
            >
              {showZeroBalance ? 'Ocultar Saldo 0' : 'Mostrar Saldo 0'}
            </button>
            
            {/* Sort mode */}
            <select 
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value)}
              className="bg-white text-sm text-gray-900 px-3 py-1.5 rounded border border-gray-200 focus:outline-none"
            >
              <option value="none">Ordenar por...</option>
              <option value="balance">Saldo Abierto (Mayor a Menor)</option>
              <option value="riskLimit">Límite Riesgo (Mayor a Menor)</option>
            </select>
            
            {/* Payment filter */}
            <div className="flex flex-wrap gap-2 items-center bg-white p-1.5 rounded border border-gray-200 shadow-sm">
              <span className="text-xs text-gray-700 font-semibold px-2 uppercase tracking-wider font-bold">Pagos:</span>
              {paymentMethods.map(pm => (
                <button
                  key={pm}
                  onClick={() => setPaymentFilters(prev => prev.includes(pm) ? prev.filter(p => p !== pm) : [...prev, pm])}
                  className={`text-xs px-2.5 py-1 rounded-full transition-colors font-medium border ${paymentFilters.includes(pm) ? 'bg-black text-white border-black shadow-sm' : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border-transparent'}`}
                >
                  {pm}
                </button>
              ))}
            </div>

            {/* Status filter */}
            <div className="flex flex-wrap gap-2 items-center bg-white p-1.5 rounded border border-gray-200 shadow-sm">
              <span className="text-xs text-gray-700 font-semibold px-2 uppercase tracking-wider font-bold">Estado:</span>
              {statuses.map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilters(prev => prev.includes(s) ? prev.filter(p => p !== s) : [...prev, s])}
                  className={`text-xs px-2.5 py-1 rounded-full transition-colors font-medium border ${statusFilters.includes(s) ? 'bg-black text-white border-black shadow-sm' : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border-transparent'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setLayoutMode('grid')}
              className={`text-sm px-3 py-1.5 rounded transition-colors ${layoutMode === 'grid' ? 'bg-gray-200 text-gray-900' : 'bg-gray-50 text-gray-900 font-bold hover:bg-gray-200'}`}
            >
              Cuadrícula
            </button>
            <button 
              onClick={() => setLayoutMode('list')}
              className={`text-sm px-3 py-1.5 rounded transition-colors ${layoutMode === 'list' ? 'bg-gray-200 text-gray-900' : 'bg-gray-50 text-gray-900 font-bold hover:bg-gray-200'}`}
            >
              Lista
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-emerald-400"></div>
          </div>
        ) : customers.length === 0 ? (
          <div className="text-center py-20 bg-gray-50 rounded-2xl border border-gray-200 backdrop-blur-sm">
            <p className="text-xl text-gray-800 font-medium">No hay clientes en la base de datos.</p>
            <p className="text-sm text-gray-900 font-bold mt-2">Ve a Configuración para cargar el archivo Excel o configurar la API.</p>
          </div>
        ) : filteredAndSortedCustomers.length === 0 ? (
          <div className="text-center py-20 bg-gray-50 rounded-2xl border border-gray-200 backdrop-blur-sm">
            <p className="text-xl text-gray-800 font-medium">Ningún cliente coincide con los filtros aplicados.</p>
          </div>
        ) : (
          <div className={layoutMode === 'grid' ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" : "flex flex-col gap-4"}>
            {filteredAndSortedCustomers.map((customer) => (
              <CustomerCard key={customer.id} customer={customer} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
