'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { LogOut, Building2, ChevronDown, ChevronRight, FolderPlus, GripVertical, Pencil, Trash2, Check } from 'lucide-react';
import { useCompany, COMPANIES } from '@/contexts/CompanyContext';

type Section = { id: string; name: string; items: string[]; collapsed?: boolean };
type Layout = { sections: Section[] };
type MenuItem = { href: string; label: string; module: string };

export default function Sidebar({ permissions = [], username = '', authEnabled = true }: { permissions: string[], username: string, authEnabled?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { selectedCompany, setSelectedCompany } = useCompany();
  const [layout, setLayout] = useState<Layout>({ sections: [] });
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Secciones del usuario (se guardan en la base de datos)
  useEffect(() => {
    if (pathname === '/login') return;
    fetch('/api/sidebar-layout', { cache: 'no-store' }).then(r => r.json()).then(d => Array.isArray(d?.sections) && setLayout(d)).catch(() => {});
  }, [pathname === '/login']); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (next: Layout) => {
    setLayout(next);
    fetch('/api/sidebar-layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
  };

  // Ocultar sidebar completamente si estamos en login
  if (pathname === '/login') return null;

  const hasPermission = (module: string) => {
    return permissions.includes('configuracion') || permissions.includes('admin') || permissions.includes(module);
  };

  const menuItems: MenuItem[] = [
    { href: '/', label: 'Dashboard Principal', module: 'dashboard' },
    { href: '/riesgos', label: 'Riesgos', module: 'riesgos' },
    { href: '/recobros', label: 'Recobros', module: 'recobros' },
    { href: '/movimientos', label: 'Mov. Abiertos', module: 'movimientos' },
    { href: '/pagos', label: 'Pagos a Prov.', module: 'pagos' },
    { href: '/cashflow', label: 'Cashflow', module: 'cashflow' },
    { href: '/inventario', label: 'Inventario (Cierre)', module: 'inventario' },
    { href: '/bwa', label: 'BWA Analytics', module: 'bwa' },
    { href: '/reporting', label: 'Reporting', module: 'reporting' },
    { href: '/controlling', label: 'Controlling', module: 'controlling' },
    { href: '/royalties', label: 'Royalties', module: 'royalties' },
    { href: '/commercial', label: 'Commercial Analysis', module: 'commercial' },
    { href: '/payment-proposal', label: 'Payment Proposal', module: 'payment_proposal' },
    // Solo para Craze Entertainment
    ...(selectedCompany === 'Craze Entertainment' ? [{ href: '/dforce', label: 'D-FORCE', module: 'dforce' }] : []),
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
        {(() => {
          const visible = menuItems.filter(i => hasPermission(i.module));
          const byHref = new Map(visible.map(i => [i.href, i]));
          const inSection = new Set(layout.sections.flatMap(sec => sec.items));
          const loose = visible.filter(i => !inSection.has(i.href));

          // Mover un apartado a una sección (o fuera de ellas: sectionId null), antes de otro apartado o al final
          const moveTo = (href: string, sectionId: string | null, beforeHref?: string) => {
            const sections = layout.sections.map(sec => ({ ...sec, items: sec.items.filter(h => h !== href) }));
            if (sectionId) {
              const sec = sections.find(x => x.id === sectionId);
              if (sec) {
                const at = beforeHref ? sec.items.indexOf(beforeHref) : -1;
                if (at >= 0) sec.items.splice(at, 0, href); else sec.items.push(href);
              }
            }
            save({ sections });
          };
          const onDrop = (sectionId: string | null, beforeHref?: string) => (e: React.DragEvent) => {
            e.preventDefault(); e.stopPropagation();
            setDropTarget(null);
            const href = dragged.current;
            dragged.current = null;
            if (href && href !== beforeHref) moveTo(href, sectionId, beforeHref);
          };
          const over = (id: string) => (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDropTarget(id); };

          const link = (item: MenuItem, sectionId: string | null) => {
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            if (editing) return (
              <div key={item.href} draggable
                onDragStart={() => { dragged.current = item.href; }} onDragEnd={() => { dragged.current = null; setDropTarget(null); }}
                onDragOver={over(`item:${item.href}`)} onDrop={onDrop(sectionId, item.href)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-gray-700 bg-gray-50 border cursor-grab active:cursor-grabbing ${dropTarget === `item:${item.href}` ? 'border-black border-dashed' : 'border-gray-200'}`}>
                <GripVertical size={14} className="text-gray-400 shrink-0" /> {item.label}
              </div>
            );
            return (
              <Link key={item.href} href={item.href}
                className={`block px-4 py-2.5 rounded-lg text-sm font-semibold transition-all ${isActive ? 'bg-black text-white shadow-md' : 'text-gray-600 hover:text-black hover:bg-gray-100'}`}>
                {item.label}
              </Link>
            );
          };

          return (
            <>
              {/* Apartados sin sección */}
              <div onDragOver={over('loose')} onDrop={onDrop(null)}
                className={`space-y-1.5 ${editing ? `min-h-[40px] rounded-lg p-1 border border-dashed ${dropTarget === 'loose' ? 'border-black bg-gray-50' : 'border-gray-200'}` : ''}`}>
                {editing && <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 px-1">Sin sección</p>}
                {loose.map(i => link(i, null))}
              </div>

              {layout.sections.map(sec => {
                const items = sec.items.map(h => byHref.get(h)).filter(Boolean) as MenuItem[];
                if (!editing && !items.length) return null;
                const open = editing || !sec.collapsed;
                return (
                  <div key={sec.id} className="pt-3" onDragOver={over(`sec:${sec.id}`)} onDrop={onDrop(sec.id)}>
                    <div className="flex items-center gap-1 px-2 mb-1">
                      {editing && renaming === sec.id ? (
                        <input autoFocus defaultValue={sec.name}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          onBlur={e => { setRenaming(null); save({ sections: layout.sections.map(x => (x.id === sec.id ? { ...x, name: e.target.value.trim() || x.name } : x)) }); }}
                          className="flex-1 text-xs font-bold uppercase tracking-wider border border-gray-300 rounded px-1.5 py-0.5" />
                      ) : (
                        <button type="button" disabled={editing}
                          onClick={() => save({ sections: layout.sections.map(x => (x.id === sec.id ? { ...x, collapsed: !x.collapsed } : x)) })}
                          className="flex-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-700 text-left">
                          {!editing && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)} {sec.name}
                        </button>
                      )}
                      {editing && (
                        <>
                          <button type="button" title="Renombrar" onClick={() => setRenaming(sec.id)} className="p-1 text-gray-400 hover:text-gray-800"><Pencil size={12} /></button>
                          <button type="button" title="Eliminar sección (sus apartados vuelven a «Sin sección»)"
                            onClick={() => save({ sections: layout.sections.filter(x => x.id !== sec.id) })} className="p-1 text-gray-400 hover:text-red-600"><Trash2 size={12} /></button>
                        </>
                      )}
                    </div>
                    {open && (
                      <div className={`space-y-1.5 ${editing ? `min-h-[40px] rounded-lg p-1 border border-dashed ${dropTarget === `sec:${sec.id}` ? 'border-black bg-gray-50' : 'border-gray-200'}` : ''}`}>
                        {items.map(i => link(i, sec.id))}
                        {editing && !items.length && <p className="text-xs text-gray-400 px-2 py-2">Arrastra aquí los apartados</p>}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="pt-4 flex flex-col gap-1.5">
                {editing && (
                  <button type="button"
                    onClick={() => { const id = `s${Date.now()}`; save({ sections: [...layout.sections, { id, name: 'Nueva sección', items: [] }] }); setRenaming(id); }}
                    className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-gray-700 border border-dashed border-gray-300 rounded-lg hover:border-black">
                    <FolderPlus size={15} /> Nueva sección
                  </button>
                )}
                <button type="button" onClick={() => { setEditing(e => !e); setRenaming(null); }}
                  className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg ${editing ? 'bg-black text-white' : 'text-gray-400 hover:text-gray-800'}`}>
                  {editing ? <><Check size={14} /> Terminar</> : <><Pencil size={13} /> Organizar menú</>}
                </button>
              </div>
            </>
          );
        })()}
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
