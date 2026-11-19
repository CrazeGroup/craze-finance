'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { LogOut, Building2, ChevronDown, ChevronRight, FolderPlus, GripVertical, Pencil, Trash2, Check, Languages, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, Star } from 'lucide-react';
import { useCompany, COMPANIES, companyLabel } from '@/contexts/CompanyContext';
import { useLanguage, useT, LANGS, LANG_NAMES, type Lang } from '@/contexts/LanguageContext';

type Section = { id: string; name: string; items: string[]; collapsed?: boolean };
type Layout = { sections: Section[] };
type MenuItem = { href: string; label: string; module: string };

const HIDDEN_KEY = 'crz-menu-hidden';
const COLLAPSED_KEY = 'crz-menu-collapsed';

export default function Sidebar({ permissions = [], username = '', authEnabled = true }: { permissions: string[], username: string, authEnabled?: boolean }) {
  const pathname = usePathname();
  // Casos de feedback pendientes (se recarga al cambiar de página y cada 5 minutos)
  const [feedbackPending, setFeedbackPending] = useState(0);
  useEffect(() => {
    const load = () => fetch('/api/feedback?count=1', { cache: 'no-store' }).then(r => r.json()).then(d => setFeedbackPending(Number(d.pending) || 0)).catch(() => {});
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [pathname]);
  const router = useRouter();
  const { selectedCompany, setSelectedCompany } = useCompany();
  const { lang, setLang } = useLanguage();
  const { t } = useT();
  const [hidden, setHidden] = useState(false);
  const [layout, setLayout] = useState<Layout>({ sections: [] });
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);
  // Sección que se arrastra para cambiar el orden de las secciones
  const draggedSec = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // Favoritos de cada usuario (base de datos): salen arriba del todo, en el orden en que se marcaron
  const [favorites, setFavorites] = useState<string[]>([]);
  useEffect(() => {
    if (pathname === '/login') return;
    fetch('/api/sidebar-favorites', { cache: 'no-store' }).then(r => r.json()).then(d => { if (Array.isArray(d?.items)) setFavorites(d.items); }).catch(() => {});
  }, [pathname === '/login']); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleFavorite = (href: string) => setFavorites(f => {
    const next = f.includes(href) ? f.filter(h => h !== href) : [...f, href];
    fetch('/api/sidebar-favorites', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: next }) }).catch(() => {});
    return next;
  });

  // Secciones del menú, comunes a todos (se guardan en la base de datos); las plegadas son de cada navegador
  useEffect(() => {
    if (pathname === '/login') return;
    fetch('/api/sidebar-layout', { cache: 'no-store' }).then(r => r.json()).then((d: Layout) => {
      if (!Array.isArray(d?.sections)) return;
      setLayout(d);
      // Primera vez en este navegador: respeta las secciones que ya estaban plegadas en el menú antiguo (por usuario)
      let stored: string | null = null;
      try { stored = localStorage.getItem(COLLAPSED_KEY); } catch { /* sin almacenamiento */ }
      if (stored === null) setCollapsed(d.sections.filter(x => x.collapsed).map(x => x.id));
    }).catch(() => {});
  }, [pathname === '/login']); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try { setHidden(localStorage.getItem(HIDDEN_KEY) === '1'); } catch { /* sin almacenamiento */ }
    try { setCollapsed(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch { /* sin almacenamiento */ }
  }, []);
  const toggleCollapsed = (id: string) => setCollapsed(c => {
    const next = c.includes(id) ? c.filter(x => x !== id) : [...c, id];
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* sin almacenamiento */ }
    return next;
  });
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
    // 'ocr|banco': con cualquiera de los dos
    return permissions.includes('configuracion') || permissions.includes('admin') || module.split('|').some(m => permissions.includes(m));
  };

  const baseItems: MenuItem[] = [
    { href: '/', label: 'Main Dashboard', module: 'dashboard' },
    { href: '/riesgos', label: 'Risks', module: 'riesgos' },
    { href: '/recobros', label: 'Collections', module: 'recobros' },
    { href: '/movimientos', label: 'Open Entries', module: 'movimientos' },
    { href: '/pagos', label: 'Payments to Vendors', module: 'pagos' },
    { href: '/cashflow', label: 'Cashflow', module: 'cashflow' },
    { href: '/banco', label: 'BANK', module: 'banco' },
    { href: '/cierre-mensual', label: 'Month-End Close Tracking', module: 'cierre' },
    { href: '/inventario', label: 'Inventory (Closing)', module: 'inventario' },
    { href: '/reporting', label: 'Reporting', module: 'reporting' },
    { href: '/inventory-analysis', label: 'Inventory Analysis', module: 'reporting' },
    { href: '/controlling', label: 'Controlling', module: 'controlling' },
    { href: '/royalties', label: 'Royalties', module: 'royalties' },
    { href: '/commercial', label: 'Commercial Analysis', module: 'commercial' },
    { href: '/amazon', label: 'Amazon', module: 'amazon' },
    // Solo para CRAZE GmbH
    ...(selectedCompany === 'CRAZE' ? [{ href: '/logistic-cost', label: 'Logistic Cost', module: 'logistic_cost' }, { href: '/customer-margin', label: 'Customer Margin', module: 'customer_margin' }] : []),
    { href: '/intercompany', label: 'Intercompany', module: 'intercompany' },
    { href: '/payment-proposal', label: 'Payment Proposal', module: 'payment_proposal' },
    { href: '/notas-compra', label: 'Purchase Notes', module: 'notas_compra' },
    { href: '/aduanas', label: 'Customs', module: 'aduanas' },
    { href: '/ocr', label: 'OCR', module: 'ocr' },
    { href: '/feedback', label: 'OCR / Bank Feedback', module: 'ocr|banco' },
    // Solo para Craze Entertainment
    ...(selectedCompany === 'Craze Entertainment' ? [
      { href: '/magazines', label: 'D-FORCE/MF', module: 'dforce' },
      { href: '/magazine-profitability', label: 'Magazine Profitability', module: 'magazine_profitability' },
    ] : []),
    { href: '/insurances', label: 'Insurance', module: 'seguros' },
    { href: '/contracts', label: 'Contracts', module: 'contratos' },
    ...(authEnabled ? [{ href: '/settings/users', label: 'Users', module: 'admin' }] : []),
    { href: '/settings/logs', label: 'Audit Log', module: 'auditoria' },
    { href: '/settings', label: 'Settings', module: 'configuracion' },
  ];
  const menuItems = baseItems.map(i => {
    const label = t(i.label);
    // Feedback OCR / Banco: casos pendientes entre paréntesis
    return i.href === '/feedback' && feedbackPending ? { ...i, label: `${label} (${feedbackPending})` } : { ...i, label };
  });

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  // Menú oculto: sin barra; solo un botón flotante arriba a la izquierda (debajo del logo de la cabecera de la página)
  // Oculto: una franja estrecha a la izquierda (ocupa su propio espacio, no tapa la página) con el botón para abrirlo
  if (hidden) return (
    <aside className="app-menu-toggle w-11 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col items-center h-full">
      <button type="button" onClick={() => toggleHidden(false)} title={t('Show menu')} aria-label={t('Show menu')}
        className="mt-2 p-2 rounded-md text-gray-500 hover:text-black hover:bg-gray-100">
        <PanelLeftOpen size={18} />
      </button>
      <button type="button" onClick={() => toggleHidden(false)} title={t('Show menu')}
        className="mt-3 text-[11px] font-bold uppercase tracking-[0.14em] text-gray-400 hover:text-black [writing-mode:vertical-rl] rotate-180">
        {t('Menu')}
      </button>
    </aside>
  );

  // Selector de idioma: dentro de la sección Config del usuario (o al final si no la tiene)
  const languageSelect = (
    <label key="lang" className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-gray-600">
      <Languages size={15} className="text-gray-400 shrink-0" />
      <span className="flex-1">{t('Language')}</span>
      <select value={lang} onChange={e => setLang(e.target.value as Lang)} aria-label={t('Language')}
        className="bg-gray-100 border-none text-xs font-semibold rounded-md px-2 py-1 text-gray-900 focus:ring-2 focus:ring-black outline-none cursor-pointer">
        {LANGS.map(l => <option key={l} value={l}>{l.toUpperCase()} · {LANG_NAMES[l]}</option>)}
      </select>
    </label>
  );
  const configSection = layout.sections.find(sec => /^conf/i.test(sec.name.trim()));

  return (
    <aside className="w-64 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-gray-500"><MenuIcon size={15} /> {t('Menu')}</span>
        <button type="button" onClick={() => toggleHidden(true)} title={t('Hide menu')} aria-label={t('Hide menu')}
          className="p-1.5 rounded-md text-gray-400 hover:text-black hover:bg-gray-100">
          <PanelLeftClose size={17} />
        </button>
      </div>
      <div className="p-6 border-b border-gray-200 flex flex-col items-start justify-center min-h-[100px]">
        <Image src="/logo.png" alt="Craze Group Logo" width={140} height={40} className="mb-2 object-contain" />
        {username && (
          <p className="text-gray-500 text-sm font-medium">{t('Hi,')} {username}</p>
        )}
        
        {/* Company Selector */}
        <div className="mt-4 w-full">
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Building2 size={14} />
            {t('Active company')}
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
              <option key={comp} value={comp}>{comp === 'ALL' ? t('ALL COMPANIES') : companyLabel(comp)}</option>
            ))}
          </select>
        </div>
      </div>
      <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
        {(() => {
          const visible = menuItems.filter(i => hasPermission(i.module));
          const byHref = new Map(visible.map(i => [i.href, i]));
          const inSection = new Set(layout.sections.flatMap(sec => sec.items));
          // Los favoritos salen arriba y no se repiten en su sitio (al organizar el menú se ven todos donde están)
          const favItems = editing ? [] : favorites.map(h => byHref.get(h)).filter(Boolean) as MenuItem[];
          const isFav = new Set(favItems.map(i => i.href));
          const loose = visible.filter(i => !inSection.has(i.href) && !isFav.has(i.href));

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
          // Mover una sección delante de otra (sobre los apartados sin sección: arriba del todo)
          const moveSection = (id: string, beforeId: string | null) => {
            if (id === beforeId) return;
            const sec = layout.sections.find(x => x.id === id);
            if (!sec) return;
            const rest = layout.sections.filter(x => x.id !== id);
            const at = beforeId ? rest.findIndex(x => x.id === beforeId) : 0;
            rest.splice(at < 0 ? rest.length : at, 0, sec);
            save({ sections: rest });
          };
          const onDrop = (sectionId: string | null, beforeHref?: string) => (e: React.DragEvent) => {
            e.preventDefault(); e.stopPropagation();
            setDropTarget(null);
            if (draggedSec.current) { const id = draggedSec.current; draggedSec.current = null; moveSection(id, sectionId); return; }
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
            const fav = favorites.includes(item.href);
            return (
              <div key={item.href} className="relative group">
                <Link href={item.href}
                  className={`block pl-4 pr-9 py-2.5 rounded-lg text-sm font-semibold transition-all ${isActive ? 'bg-black text-white shadow-md' : 'text-gray-600 hover:text-black hover:bg-gray-100'}`}>
                  {item.label}
                </Link>
                <button type="button" onClick={() => toggleFavorite(item.href)}
                  title={(fav ? t('Remove from favorites') : t('Add to favorites'))} aria-label={(fav ? t('Remove from favorites') : t('Add to favorites'))} aria-pressed={fav}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-opacity ${fav ? 'text-amber-400 opacity-100' : `${isActive ? 'text-gray-400 hover:text-white' : 'text-gray-300 hover:text-amber-500'} opacity-60 group-hover:opacity-100`}`}>
                  <Star size={14} fill={fav ? 'currentColor' : 'none'} />
                </button>
              </div>
            );
          };

          return (
            <>
              {/* Favoritos del usuario */}
              {favItems.length > 0 && (
                <div className="pb-2 mb-1 border-b border-gray-100 space-y-1.5">
                  <p className="flex items-center gap-1 px-2 mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">
                    <Star size={11} className="text-amber-400" fill="currentColor" /> {t('Favorites')}
                  </p>
                  {favItems.map(i => link(i, null))}
                </div>
              )}

              {/* Apartados sin sección */}
              <div onDragOver={over('loose')} onDrop={onDrop(null)}
                className={`space-y-1.5 ${editing ? `min-h-[40px] rounded-lg p-1 border border-dashed ${dropTarget === 'loose' ? 'border-black bg-gray-50' : 'border-gray-200'}` : ''}`}>
                {editing && <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 px-1">{t('No section')}</p>}
                {loose.map(i => link(i, null))}
              </div>

              {layout.sections.map(sec => {
                const items = sec.items.map(h => byHref.get(h)).filter(Boolean).filter(i => !isFav.has(i!.href)) as MenuItem[];
                const isConfig = sec === configSection;
                if (!editing && !items.length && !isConfig) return null;
                const open = editing || !collapsed.includes(sec.id);
                return (
                  <div key={sec.id} className="pt-3" onDragOver={over(`sec:${sec.id}`)} onDrop={onDrop(sec.id)}>
                    <div className={`flex items-center gap-1 px-2 mb-1 ${editing ? 'cursor-grab active:cursor-grabbing' : ''}`} draggable={editing && renaming !== sec.id}
                      title={editing ? t('Drag to reorder the section') : undefined}
                      onDragStart={e => { e.stopPropagation(); draggedSec.current = sec.id; }} onDragEnd={() => { draggedSec.current = null; setDropTarget(null); }}>
                      {editing && <GripVertical size={12} className="text-gray-400 shrink-0" />}
                      {editing && renaming === sec.id ? (
                        <input autoFocus defaultValue={sec.name}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          onBlur={e => { setRenaming(null); save({ sections: layout.sections.map(x => (x.id === sec.id ? { ...x, name: e.target.value.trim() || x.name } : x)) }); }}
                          className="flex-1 text-xs font-bold uppercase tracking-wider border border-gray-300 rounded px-1.5 py-0.5" />
                      ) : (
                        <button type="button" disabled={editing}
                          onClick={() => toggleCollapsed(sec.id)}
                          className="flex-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-700 text-left">
                          {!editing && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)} {sec.name}
                        </button>
                      )}
                      {editing && (
                        <>
                          <button type="button" title={t('Rename')} onClick={() => setRenaming(sec.id)} className="p-1 text-gray-400 hover:text-gray-800"><Pencil size={12} /></button>
                          <button type="button" title={t('Delete section (its items go back to "No section")')}
                            onClick={() => save({ sections: layout.sections.filter(x => x.id !== sec.id) })} className="p-1 text-gray-400 hover:text-red-600"><Trash2 size={12} /></button>
                        </>
                      )}
                    </div>
                    {open && (
                      <div className={`space-y-1.5 ${editing ? `min-h-[40px] rounded-lg p-1 border border-dashed ${dropTarget === `sec:${sec.id}` ? 'border-black bg-gray-50' : 'border-gray-200'}` : ''}`}>
                        {items.map(i => link(i, sec.id))}
                        {editing && !items.length && <p className="text-xs text-gray-400 px-2 py-2">{t('Drag items here')}</p>}
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
                    onClick={() => { const id = `s${Date.now()}`; save({ sections: [...layout.sections, { id, name: t('New section'), items: [] }] }); setRenaming(id); }}
                    className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-gray-700 border border-dashed border-gray-300 rounded-lg hover:border-black">
                    <FolderPlus size={15} /> {t('New section')}
                  </button>
                )}
                <button type="button" onClick={() => { setEditing(e => !e); setRenaming(null); }}
                  className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg ${editing ? 'bg-black text-white' : 'text-gray-400 hover:text-gray-800'}`}>
                  {editing ? <><Check size={14} /> {t('Done')}</> : <><Pencil size={13} /> {t('Organize menu')}</>}
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
          <LogOut size={18} /> {t('Log out')}
        </button>
      </div>
      )}
    </aside>
  );
}
