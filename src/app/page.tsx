'use client';

import { useEffect, useState } from 'react';
import { 
  Banknote, AlertCircle, TrendingDown, ArrowUpRight, 
  ArrowDownRight, CheckCircle2, Clock, Globe2, 
  ShoppingCart, Landmark, Wallet, Undo2, PackageSearch, RefreshCw
} from 'lucide-react';
import Link from 'next/link';
import { useCompany } from '@/contexts/CompanyContext';
import { syncFromBc } from '@/lib/syncClient';

export default function Dashboard() {
  const [kpis, setKpis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { selectedCompany } = useCompany();
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [lastSync, setLastSync] = useState<Record<string, string>>({});

  const fetchKpis = async (force = false) => {
    try {
      const [res, last] = await Promise.all([
        fetch(`/api/dashboard${force ? '?force=1' : ''}`, { cache: 'no-store' }),
        fetch('/api/sync-bc', { cache: 'no-store' }).then(r => r.json()).catch(() => ({})),
      ]);
      setKpis(await res.json());
      setLastSync(last || {});
    } catch (error) {
      console.error('Failed to fetch KPIs', error);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { fetchKpis(); }, [selectedCompany]);

  // Actualizar en vivo: sincroniza con BC la empresa activa (todas en "ALL") paso a paso y recarga las cifras
  const syncNow = async () => {
    setSyncErrors([]);
    const errors = await syncFromBc(selectedCompany, setSyncing);
    setSyncing('Recalculando el dashboard…');
    await fetchKpis(true);
    setSyncErrors(errors);
    setSyncing(null);
  };
  const lastIso = selectedCompany === 'ALL' ? Object.values(lastSync).sort()[0] : lastSync[selectedCompany];
  const ago = (iso?: string) => {
    if (!iso) return 'nunca';
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return min < 1 ? 'hace menos de 1 min' : min < 60 ? `hace ${min} min` : min < 48 * 60 ? `hace ${Math.round(min / 60)} h` : new Date(iso).toLocaleString('es-ES');
  };

  const formatCurrency = (val: number, currencyCode: string = 'EUR') => {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: currencyCode }).format(val || 0);
  };

  const KPICard = ({ title, value, icon, trend, link, currency }: any) => (
    <div className="bg-white border border-gray-200 p-6 rounded-xl shadow-sm hover:shadow-md hover:border-gray-300 transition-all group">
      <div className="flex justify-between items-start mb-4">
        <div className="p-3 bg-gray-50 rounded-lg text-gray-700">
          {icon}
        </div>
        {link && (
          <Link href={link} className="text-gray-400 hover:text-black transition-colors">
            <ArrowUpRight size={20} className="group-hover:scale-110 transition-transform" />
          </Link>
        )}
      </div>
      <div>
        <p className="text-xs text-gray-500 font-bold mb-1 uppercase tracking-wider">{title}</p>
        <h3 className="text-2xl font-black text-black tracking-tight">{formatCurrency(value, currency || 'EUR')}</h3>
        {trend && (
          <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
            {trend}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen p-8 pb-32 overflow-y-auto">
      <div className="w-full space-y-12">
        
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl font-black text-black tracking-tight">
              Dashboard Contable
            </h1>
            <p className="text-gray-500 mt-2 font-medium">Visión global de cobros, pagos y métricas financieras.</p>
          </div>
          <div className="text-right">
            <button onClick={syncNow} disabled={!!syncing}
              className="inline-flex items-center gap-2 bg-black text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-gray-800 disabled:opacity-60">
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Actualizando…' : 'Actualizar desde BC'}
            </button>
            <p className="text-xs text-gray-500 mt-1.5">
              {syncing || `Última sincronización: ${ago(lastIso)} · automática cada hora`}
            </p>
          </div>
        </header>
        {syncErrors.length > 0 && (
          <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Algunos pasos no se han podido sincronizar: {syncErrors.join(' · ')}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center items-center h-64">
             <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
          </div>
        ) : (
          <div className="space-y-10">
            
            {/* COBROS */}
            <div>
              <h2 className="text-xl font-bold text-black mb-4 flex items-center gap-2 border-b border-gray-200 pb-2">
                <ArrowDownRight className="text-gray-700" /> 
                Gestión de Cobros (Clientes)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <KPICard 
                  title="Cartera de Clientes" 
                  value={kpis?.totalCarteraClientes} 
                  icon={<Banknote size={24} />} 

                  link="/recobros"
                />
                <KPICard 
                  title="Total Vencido" 
                  value={kpis?.totalVencido} 
                  icon={<AlertCircle size={24} />} 

                  link="/recobros"
                />
                <KPICard 
                  title="Total Amazon" 
                  value={kpis?.totalAmazon} 
                  icon={<ShoppingCart size={24} />} 

                />
              </div>
            </div>

            {/* MARKANT */}
            <div>
              <h2 className="text-xl font-bold text-black mb-4 flex items-center gap-2 border-b border-gray-200 pb-2">
                <Landmark className="text-gray-700" /> 
                Markant
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <KPICard 
                  title="Total Markant" 
                  value={kpis?.totalEnMarkant} 
                  icon={<ShoppingCart size={24} />} 
                />
                <KPICard 
                  title="Confirmado Markant" 
                  value={kpis?.totalConfirmadoMarkant} 
                  icon={<CheckCircle2 size={24} />} 
                  trend="Con fecha de pago confirmada"
                />
                <KPICard 
                  title="Pendiente de confirmar Markant" 
                  value={kpis?.totalPendienteMarkant} 
                  icon={<Clock size={24} />} 
                  trend="Sin fecha de pago confirmada"
                />
              </div>
            </div>

            {/* PAGOS */}
            <div>
              <h2 className="text-xl font-bold text-black mb-4 flex items-center gap-2 border-b border-gray-200 pb-2">
                <ArrowUpRight className="text-gray-700" /> 
                Gestión de Pagos (Proveedores)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <KPICard 
                  title="Cartera Proveedores" 
                  value={kpis?.totalCarteraProveedores} 
                  icon={<Banknote size={24} />} 
                  link="/pagos"
                />
                <KPICard 
                  title="Vencida Aprobada" 
                  value={kpis?.totalCarteraVencidaAprobada} 
                  icon={<CheckCircle2 size={24} />} 

                  link="/pagos"
                />
                <KPICard 
                  title="Vencida NO Aprobada" 
                  value={kpis?.totalCarteraVencidaNoAprobada} 
                  icon={<Clock size={24} />} 
                  link="/pagos"
                />
              </div>
            </div>

            {/* PAGOS CHINA */}
            <div>
              <h2 className="text-xl font-bold text-black mb-4 flex items-center gap-2 border-b border-gray-200 pb-2">
                <Globe2 className="text-gray-700" /> 
                Pagos Internacionales (China)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <KPICard 
                  title="Total China" 
                  value={kpis?.totalChina} 
                  icon={<Globe2 size={24} />} 

                />
                <KPICard 
                  title="Confirmado China" 
                  value={kpis?.totalConfirmadoChina} 
                  icon={<CheckCircle2 size={24} />} 

                />
                <KPICard 
                  title="Pendiente China" 
                  value={kpis?.totalPendienteChina} 
                  icon={<Clock size={24} />} 

                />
              </div>
            </div>

            {/* DEVOLUCIONES Y REFUNDS */}
            <div>
              <h2 className="text-xl font-bold text-black mb-4 flex items-center gap-2 border-b border-gray-200 pb-2">
                <Undo2 className="text-gray-700" /> 
                Devoluciones y Refunds
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <KPICard 
                  title="Refunds Abiertos (Cliente)" 
                  value={Math.abs(kpis?.totalRefundsAbiertosCliente || 0)} 
                  icon={<Undo2 size={24} />} 

                />
                <KPICard 
                  title="Refunds Abiertos (Prov.)" 
                  value={Math.abs(kpis?.totalRefundsAbiertoProveedor || 0)} 
                  icon={<Undo2 size={24} />} 

                />
                <KPICard 
                  title="Sales Return Orders" 
                  value={kpis?.salesReturnOrdersAbiertas} 
                  icon={<ShoppingCart size={24} />} 

                />
              </div>
            </div>

            {/* CASHFLOW */}
            <div>
              <h2 className="text-xl font-bold text-black mb-4 flex items-center gap-2 border-b border-gray-200 pb-2">
                <Landmark className="text-gray-700" /> 
                Tesorería (Disponible Hoy)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {kpis?.cashflowAvailable && Object.keys(kpis.cashflowAvailable).map(currency => (
                  <KPICard 
                    key={currency}
                    title={`Disponible ${currency}`} 
                    value={kpis.cashflowAvailable[currency]} 
                    icon={<Wallet size={24} />} 
                    currency={currency}
                  />
                ))}
                {(!kpis?.cashflowAvailable || Object.keys(kpis.cashflowAvailable).length === 0) && (
                  <KPICard 
                    title="Cashflow" 
                    value={0} 
                    icon={<Wallet size={24} />} 
                  />
                )}
              </div>
            </div>

            {/* INVENTORY VALUATION */}
            <div>
              <div className="flex items-center justify-between mb-4 border-b border-gray-200 pb-2">
                <h2 className="text-xl font-bold text-black flex items-center gap-2">
                  <PackageSearch className="text-gray-700" /> 
                  Inventario (Coste Medio)
                </h2>
                {kpis?.latestValuation && (
                  <span className="text-sm text-gray-500 font-medium">
                    Último cierre: {new Date(kpis.latestValuation.month).toLocaleDateString(undefined, {month: 'long', year: 'numeric'})}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <KPICard 
                  title="Valoración Sistema (BC)" 
                  value={kpis?.latestValuation?.totalSystemVal || 0} 
                  icon={<PackageSearch size={24} />} 
                />
                <KPICard 
                  title="Valoración Coste Medio" 
                  value={kpis?.latestValuation?.totalNewVal || 0} 
                  icon={<ShoppingCart size={24} />} 
                />
                <div className={`p-6 rounded-xl border flex flex-col justify-between shadow-sm transition-all hover:shadow-md ${kpis?.latestValuation?.difference > 0 ? 'bg-green-50 border-green-200' : kpis?.latestValuation?.difference < 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100'}`}>
                  <div className="flex justify-between items-start mb-4">
                    <p className="text-sm font-semibold text-gray-600 uppercase tracking-wider">Diferencia Total</p>
                    <div className="p-2 rounded-lg bg-gray-50/50">
                      <TrendingDown size={24} className={kpis?.latestValuation?.difference > 0 ? "text-green-600" : "text-red-600"} />
                    </div>
                  </div>
                  <h3 className={`text-3xl font-black ${kpis?.latestValuation?.difference > 0 ? 'text-green-700' : kpis?.latestValuation?.difference < 0 ? 'text-red-700' : 'text-gray-900'}`}>
                    {kpis?.latestValuation?.difference > 0 ? '+' : ''}
                    {kpis?.latestValuation ? `€${kpis.latestValuation.difference.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '€0.00'}
                  </h3>
                </div>
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
