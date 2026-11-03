'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { LogOut, Building2, ChevronDown, ChevronRight, FolderPlus, GripVertical, Pencil, Trash2, Check, Languages, Menu as MenuIcon, PanelLeftClose } from 'lucide-react';
import { useCompany, COMPANIES, companyLabel } from '@/contexts/CompanyContext';
import { useLanguage, LANGS, LANG_NAMES, type Lang } from '@/contexts/LanguageContext';

type Section = { id: string; name: string; items: string[]; collapsed?: boolean };
type Layout = { sections: Section[] };
type MenuItem = { href: string; label: string; module: string };

// Textos del menú (los nombres de las secciones son los que pone cada usuario)
const TEXT: Record<Lang, Record<string, string>> = {
  en: {
    menu: 'Menu', hide: 'Hide menu', show: 'Show menu', hello: 'Hi,', activeCompany: 'Active company', allCompanies: 'ALL COMPANIES', language: 'Language',
    noSection: 'No section', dragHere: 'Drag items here', newSection: 'New section', organize: 'Organize menu', done: 'Done', rename: 'Rename',
    deleteSection: 'Delete section (its items go back to "No section")', logout: 'Log out',
    '/': 'Main Dashboard', '/riesgos': 'Risks', '/recobros': 'Collections', '/movimientos': 'Open Entries', '/pagos': 'Vendor Payments',
    '/inventario': 'Inventory (Closing)', '/inventory-analysis': 'Inventory Analysis', '/notas-compra': 'Purchase Notes', '/aduanas': 'Customs', '/insurances': 'Insurance', '/contracts': 'Contracts',
    '/settings/users': 'Users', '/settings/logs': 'Audit Log', '/settings': 'Settings',
  },
  es: {
    menu: 'Menú', hide: 'Ocultar menú', show: 'Mostrar menú', hello: 'Hola,', activeCompany: 'Empresa activa', allCompanies: 'TODAS LAS EMPRESAS', language: 'Idioma',
    noSection: 'Sin sección', dragHere: 'Arrastra aquí los apartados', newSection: 'Nueva sección', organize: 'Organizar menú', done: 'Terminar', rename: 'Renombrar',
    deleteSection: 'Eliminar sección (sus apartados vuelven a «Sin sección»)', logout: 'Cerrar sesión',
  },
  de: {
    menu: 'Menü', hide: 'Menü ausblenden', show: 'Menü einblenden', hello: 'Hallo,', activeCompany: 'Aktive Firma', allCompanies: 'ALLE FIRMEN', language: 'Sprache',
    noSection: 'Ohne Bereich', dragHere: 'Einträge hierher ziehen', newSection: 'Neuer Bereich', organize: 'Menü organisieren', done: 'Fertig', rename: 'Umbenennen',
    deleteSection: 'Bereich löschen (seine Einträge gehen zurück zu „Ohne Bereich“)', logout: 'Abmelden',
    '/': 'Haupt-Dashboard', '/riesgos': 'Risiken', '/recobros': 'Inkasso', '/movimientos': 'Offene Posten', '/pagos': 'Lieferantenzahlungen',
    '/inventario': 'Inventar (Abschluss)', '/inventory-analysis': 'Bestandsanalyse', '/notas-compra': 'Einkaufsnotizen', '/aduanas': 'Zoll', '/insurances': 'Versicherungen', '/contracts': 'Verträge',
    '/settings/users': 'Benutzer', '/settings/logs': 'Protokoll', '/settings': 'Einstellungen',
  },
};
const HIDDEN_KEY = 'crz-menu-hidden';

export default function Sidebar({ permissions = [], username = '', authEnabled = true }: { permissions: string[], username: string, authEnabled?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { selectedCompany, setSelectedCompany } = useCompany();
  const { lang, setLang } = useLanguage();
  const tx = (k: string) => TEXT[lang][k] ?? TEXT.es[k] ?? k;
  const [hidden, setHidden] = useState(false);
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

  useEffect(() => {
    try { setHidden(localStorage.getItem(HIDDEN_KEY) === '1'); } catch { /* sin almacenamiento */ }
  }, []);
  const toggleHidden = (h: boolean) => {
    setHidden(h);
    try { localStorage.setItem(HIDDEN_KEY, h ? '1' : '0'); } catch { /* sin almacenamiento */ }
  };

  const save = (next: Layout) => {
    setLayout(next);
    fetch('/api/sidebar-layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
  };

  // Ocultar sidebar completamente si estamos en login
  if (pathname === '/login') return null;

  const hasPermission = (module: string) => {
    return permissions.includes('configuracion') || permissions.includes('admin') || permissions.includes(module);
  };

  const baseItems: MenuItem[] = [
    { href: '/', label: 'Dashboard Principal', module: 'dashboard' },
    { href: '/riesgos', label: 'Riesgos', module: 'riesgos' },
    { href: '/recobros', label: 'Recobros', module: 'recobros' },
    { href: '/movimientos', label: 'Mov. Abiertos', module: 'movimientos' },
    { href: '/pagos', label: 'Pagos a Prov.', module: 'pagos' },
    { href: '/cashflow', label: 'Cashflow', module: 'cashflow' },
    { href: '/banco', label: 'BANCO', module: 'banco' },
    { href: '/inventario', label: 'Inventario (Cierre)', module: 'inventario' },
    { href: '/bwa', label: 'BWA Analytics', module: 'bwa' },
    { href: '/reporting', label: 'Reporting', module: 'reporting' },
    { href: '/inventory-analysis', label: 'Análisis Inventario', module: 'reporting' },
    { href: '/controlling', label: 'Controlling', module: 'controlling' },
    { href: '/royalties', label: 'Royalties', module: 'royalties' },
    { href: '/commercial', label: 'Commercial Analysis', module: 'commercial' },
    { href: '/intercompany', label: 'Intercompany', module: 'intercompany' },
    { href: '/payment-proposal', label: 'Payment Proposal', module: 'payment_proposal' },
    { href: '/notas-compra', label: 'Notas de compra', module: 'notas_compra' },
    { href: '/aduanas', label: 'Aduanas', module: 'aduanas' },
    { href: '/ocr', label: 'OCR', module: 'ocr' },
    // Solo para Craze Entertainment
    ...(selectedCompany === 'Craze Entertainment' ? [{ href: '/magazines', label: 'MAGAZINES', module: 'dforce' }] : []),
    { href: '/insurances', label: 'Seguros', module: 'seguros' },
    { href: '/contracts', label: 'Contratos', module: 'contratos' },
    ...(authEnabled ? [{ href: '/settings/users', label: 'Usuarios', module: 'admin' }] : []),
    { href: '/settings/logs', label: 'Auditoría', module: 'auditoria' },
    { href: '/settings', label: 'Configuración', module: 'configuracion' },
  ];
  const menuItems = baseItems.map(i => ({ ...i, label: TEXT[lang][i.href] ?? i.label }));

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  // Menú oculto: sin barra; solo un botón flotante arriba a la izquierda (debajo del logo de la cabecera de la página)
  if (hidden) return (
    <button type="button" onClick={() => toggleHidden(false)} title={tx('show')}
      className="app-menu-toggle fixed top-[84px] left-3 z-50 flex items-center gap-1.5 bg-black text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg hover:bg-gray-800">
      <MenuIcon size={14} /> {tx('menu')}
    </button>
  );

  // Selector de idioma: dentro de la sección Config del usuario (o al final si no la tiene)
  const languageSelect = (
    <label key="lang" className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-gray-600">
      <Languages size={15} className="text-gray-400 shrink-0" />
      <span className="flex-1">{tx('language')}</span>
      <select value={lang} onChange={e => setLang(e.target.value as Lang)} aria-label={tx('language')}
        className="bg-gray-100 border-none text-xs font-semibold rounded-md px-2 py-1 text-gray-900 focus:ring-2 focus:ring-black outline-none cursor-pointer">
        {LANGS.map(l => <option key={l} value={l}>{l.toUpperCase()} · {LANG_NAMES[l]}</option>)}
      </select>
    </label>
  );
  const configSection = layout.sections.find(sec => /^conf/i.test(sec.name.trim()));

  return (
    <aside className="w-64 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-gray-500"><MenuIcon size={15} /> {tx('menu')}</span>
        <button type="button" onClick={() => toggleHidden(true)} title={tx('hide')} aria-label={tx('hide')}
          className="p-1.5 rounded-md text-gray-400 hover:text-black hover:bg-gray-100">
          <PanelLeftClose size={17} />
        </button>
      </div>
      <div className="p-6 border-b border-gray-200 flex flex-col items-start justify-center min-h-[100px]">
        <Image src="/logo.png" alt="Craze Group Logo" width={140} height={40} className="mb-2 object-contain" />
        {username && (
          <p className="text-gray-500 text-sm font-medium">{tx('hello')} {username}</p>
        )}
        
        {/* Company Selector */}
        <div className="mt-4 w-full">
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Building2 size={14} />
            {tx('activeCompany')}
          </label>
          <select
            value={selectedCompany}
            onChange={(e) => {
              const newCompany = e.target.value;
              setSelectedCompany(newCompany);
              
              // Trigger a refresh of the page to re-fetch data for the new company if needed,
              // or rely on SWR / React Query if they were used. 
              // Since this app uses fetch on component mount mostly, a refresh is safest.
              window.location.reload();
            }}
            className="w-full bg-gray-100 border-none text-sm font-semibold rounded-md px-3 py-2 text-gray-900 focus:ring-2 focus:ring-black outline-none cursor-pointer"
          >
            {COMPANIES.map(comp => (
              <option key={comp} value={comp}>{comp === 'ALL' ? tx('allCompanies') : companyLabel(comp)}</option>
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
                {editing && <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 px-1">{tx('noSection')}</p>}
                {loose.map(i => link(i, null))}
              </div>

              {layout.sections.map(sec => {
                const items = sec.items.map(h => byHref.get(h)).filter(Boolean) as MenuItem[];
                const isConfig = sec === configSection;
                if (!editing && !items.length && !isConfig) return null;
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
                          <button type="button" title={tx('rename')} onClick={() => setRenaming(sec.id)} className="p-1 text-gray-400 hover:text-gray-800"><Pencil size={12} /></button>
                          <button type="button" title={tx('deleteSection')}
                            onClick={() => save({ sections: layout.sections.filter(x => x.id !== sec.id) })} className="p-1 text-gray-400 hover:text-red-600"><Trash2 size={12} /></button>
                        </>
                      )}
                    </div>
                    {open && (
                      <div className={`space-y-1.5 ${editing ? `min-h-[40px] rounded-lg p-1 border border-dashed ${dropTarget === `sec:${sec.id}` ? 'border-black bg-gray-50' : 'border-gray-200'}` : ''}`}>
                        {items.map(i => link(i, sec.id))}
                        {editing && !items.length && <p className="text-xs text-gray-400 px-2 py-2">{tx('dragHere')}</p>}
                        {isConfig && !editing && languageSelect}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="pt-4 flex flex-col gap-1.5">
                {!configSection && !editing && languageSelect}
                {editing && (
                  <button type="button"
                    onClick={() => { const id = `s${Date.now()}`; save({ sections: [...layout.sections, { id, name: tx('newSection'), items: [] }] }); setRenaming(id); }}
                    className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-gray-700 border border-dashed border-gray-300 rounded-lg hover:border-black">
                    <FolderPlus size={15} /> {tx('newSection')}
                  </button>
                )}
                <button type="button" onClick={() => { setEditing(e => !e); setRenaming(null); }}
                  className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg ${editing ? 'bg-black text-white' : 'text-gray-400 hover:text-gray-800'}`}>
                  {editing ? <><Check size={14} /> {tx('done')}</> : <><Pencil size={13} /> {tx('organize')}</>}
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
          <LogOut size={18} /> {tx('logout')}
        </button>
      </div>
      )}
    </aside>
  );
}
