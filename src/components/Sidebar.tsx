'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Building2 } from 'lucide-react';
import { useCompany, COMPANIES } from '@/contexts/CompanyContext';

export default function Sidebar({ permissions = [], username = '', authEnabled = true }: { permissions: string[], username: string, authEnabled?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { selectedCompany, setSelectedCompany } = useCompany();

  // Ocultar sidebar completamente si estamos en login
  if (pathname === '/login') return null;

  const hasPermission = (module: string) => {
    return permissions.includes('configuracion') || permissions.includes('admin') || permissions.includes(module);
  };

  const menuItems = [
    { href: '/', label: 'Dashboard Principal', module: 'dashboard' },
    { href: '/riesgos', label: 'Riesgos', module: 'riesgos' },
    { href: '/recobros', label: 'Recobros', module: 'recobros' },
    { href: '/movimientos', label: 'Mov. Abiertos', module: 'movimientos' },
    { href: '/pagos', label: 'Pagos a Prov.', module: 'pagos' },
    { href: '/cashflow', label: 'Cashflow', module: 'cashflow' },
    { href: '/inventario', label: 'Inventario (Cierre)', module: 'inventario' },
    { href: '/bwa', label: 'BWA Analytics', module: 'bwa' },
    { href: '/reporting', label: 'Reporting', module: 'reporting' },
    { href: '/insurances', label: 'Seguros', module: 'seguros' },
    { href: '/contracts', label: 'Contratos', module: 'contratos' },
    ...(authEnabled ? [{ href: '/settings/users', label: 'Usuarios', module: 'admin' }] : []),
    { href: '/settings/logs', label: 'Auditoría', module: 'auditoria' },
    { href: '/settings', label: 'Configuración', module: 'configuracion' },
  ];

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  return (
    <aside className="w-64 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="p-6 border-b border-gray-200 flex flex-col items-start justify-center min-h-[100px]">
        <Image src="/logo.png" alt="Craze Group Logo" width={140} height={40} className="mb-2 object-contain" />
        {username && (
          <p className="text-gray-500 text-sm font-medium">Hola, {username}</p>
        )}
        
        {/* Company Selector */}
        <div className="mt-4 w-full">
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Building2 size={14} />
            Empresa Activa
          </label>
          <select
            value={selectedCompany}
            onChange={(e) => {
              const newCompany = e.target.value;
              setSelectedCompany(newCompany);
              document.cookie = `craze_selected_company=${encodeURIComponent(newCompany)}; path=/; max-age=31536000`;
              
              // Trigger a refresh of the page to re-fetch data for the new company if needed,
              // or rely on SWR / React Query if they were used. 
              // Since this app uses fetch on component mount mostly, a refresh is safest.
              window.location.reload();
            }}
            className="w-full bg-gray-100 border-none text-sm font-semibold rounded-md px-3 py-2 text-gray-900 focus:ring-2 focus:ring-black outline-none cursor-pointer"
          >
            {COMPANIES.map(comp => (
              <option key={comp} value={comp}>{comp === 'ALL' ? 'TODAS LAS EMPRESAS' : comp}</option>
            ))}
          </select>
        </div>
      </div>
      <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
        {menuItems.map(item => {
          if (!hasPermission(item.module)) return null;
          
          // Check if active
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          
          return (
            <Link 
              key={item.href} 
              href={item.href} 
              className={`block px-4 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                isActive 
                  ? 'bg-black text-white shadow-md' 
                  : 'text-gray-600 hover:text-black hover:bg-gray-100'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      {authEnabled && (
      <div className="p-4 border-t border-gray-200">
        <button 
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          <LogOut size={18} /> Cerrar Sesión
        </button>
      </div>
      )}
    </aside>
  );
}
