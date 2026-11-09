'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Copy, Loader2, MessageSquare, Plus, Trash2, Upload, X } from 'lucide-react';
import { useCompany, companyLabel } from '@/contexts/CompanyContext';

// Tracking Cierre Mensual: tareas del cierre por empresa y año, con cada mes hecho / pendiente / vacío (la tarea no toca
// ese mes) y un comentario por celda. Cada empresa puede tener subempresas (p. ej. Allike en GmbH), cada una en su tabla.
const COMPANIES = ['CRAZE', 'Craze Iberia SL', 'Craze UK', 'CRAZE Group AG', 'Craze Entertainment'];
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
type Cell = { id: number; taskId: number; month: number; done: boolean | null; comment: string | null; updatedBy: string | null; updatedAt: string };
type Task = { id: number; number: number; description: string; assignee: string | null; notes: string | null; group: string | null; cells: Cell[] };

const shortUser = (u: string | null) => (u ? u.split('@')[0] : '');
const label = companyLabel;

export default function CierreMensualPage() {
  const { selectedCompany } = useCompany();
  const [company, setCompany] = useState(COMPANIES.includes(selectedCompany) ? selectedCompany : 'CRAZE');
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [previousYearTasks, setPreviousYearTasks] = useState(0);
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [commentCell, setCommentCell] = useState<{ task: Task; month: number; x: number; y: number; text: string } | null>(null);
  const [newTask, setNewTask] = useState<{ description: string; assignee: string; group: string | null } | null>(null);
  // Subempresas creadas en pantalla que aún no tienen tareas
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (COMPANIES.includes(selectedCompany)) setCompany(selectedCompany); }, [selectedCompany]);

  const load = async () => {
    setLoading('Cargando…');
    setError('');
    try {
      const res = await fetch(`/api/closing?company=${encodeURIComponent(company)}&year=${year}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Error al cargar las tareas');
      setTasks(d.tasks);
      setUsers(d.users);
      setPreviousYearTasks(d.previousYearTasks);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading('');
    }
  };
  useEffect(() => { setExtraGroups([]); load(); }, [company, year]); // eslint-disable-line react-hooks/exhaustive-deps

  const cellOf = (t: Task, month: number) => t.cells.find(c => c.month === month);
  const replaceCell = (cell: Cell) => setTasks(ts => ts.map(t => (t.id === cell.taskId
    ? { ...t, cells: [...t.cells.filter(c => c.month !== cell.month), cell] } : t)));

  const saveCell = async (t: Task, month: number, patch: { done?: boolean | null; comment?: string }) => {
    const before = cellOf(t, month);
    replaceCell({ ...(before || { id: 0, taskId: t.id, month, done: null, comment: null, updatedBy: null, updatedAt: '' }), ...patch } as Cell);
    try {
      const res = await fetch('/api/closing/cell', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: t.id, month, ...patch }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'No se ha podido guardar');
      replaceCell(d);
    } catch (e: any) {
      if (before) replaceCell(before); else setTasks(ts => ts.map(x => (x.id === t.id ? { ...x, cells: x.cells.filter(c => c.month !== month) } : x)));
      setError(e.message);
    }
  };
  // Clic: vacío → hecho → pendiente → vacío
  const cycle = (t: Task, month: number) => {
    const done = cellOf(t, month)?.done ?? null;
    saveCell(t, month, { done: done === null ? true : done ? false : null });
  };

  const patchTask = async (t: Task, patch: Partial<Task>) => {
    setTasks(ts => ts.map(x => (x.id === t.id ? { ...x, ...patch } : x)));
    const res = await fetch(`/api/closing/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'No se ha podido guardar'); load(); }
  };
  const deleteTask = async (t: Task) => {
    if (!confirm(`¿Eliminar la tarea ${t.number}. ${t.description} de ${year}?`)) return;
    const res = await fetch(`/api/closing/${t.id}`, { method: 'DELETE' });
    if (res.ok) setTasks(ts => ts.filter(x => x.id !== t.id)); else setError((await res.json()).error);
  };
  const addTask = async () => {
    if (!newTask?.description.trim()) return;
    const res = await fetch(`/api/closing?company=${encodeURIComponent(company)}&year=${year}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newTask),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error); return; }
    setTasks(ts => [...ts, d]);
    setNewTask(null);
  };
  const copyPrevious = async () => {
    const res = await fetch(`/api/closing?company=${encodeURIComponent(company)}&year=${year}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ copyFrom: year - 1 }),
    });
    if (!res.ok) setError((await res.json()).error); else load();
  };

  const addGroup = () => {
    const name = prompt(`Nombre de la subempresa de ${label(company)} (p. ej. Allike)`)?.trim();
    if (!name) return;
    if (groups.includes(name)) { setError(`Ya existe la subempresa ${name}.`); return; }
    setExtraGroups(g => [...g, name]);
    setNewTask({ description: '', assignee: '', group: name });
  };
  const renameGroup = async (from: string) => {
    const to = prompt('Nuevo nombre de la subempresa', from)?.trim();
    if (!to || to === from) return;
    if (!tasks.some(t => t.group === from)) { setExtraGroups(g => g.map(x => (x === from ? to : x))); return; }
    const res = await fetch(`/api/closing?company=${encodeURIComponent(company)}&year=${year}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }),
    });
    if (!res.ok) setError((await res.json()).error); else setTasks(ts => ts.map(t => (t.group === from ? { ...t, group: to } : t)));
  };
  const deleteGroup = async (group: string) => {
    const n = tasks.filter(t => t.group === group).length;
    if (n && !confirm(`¿Eliminar la subempresa ${group} y sus ${n} tareas de ${year}?`)) return;
    if (n) {
      const res = await fetch(`/api/closing?company=${encodeURIComponent(company)}&year=${year}&group=${encodeURIComponent(group)}`, { method: 'DELETE' });
      if (!res.ok) { setError((await res.json()).error); return; }
    }
    setTasks(ts => ts.filter(t => t.group !== group));
    setExtraGroups(g => g.filter(x => x !== group));
  };

  const importExcel = async (file: File | null) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!confirm(`El Excel sustituye las tareas de ${year} de cada empresa que tenga una pestaña (GmbH, Iberia, UK, AG, Entertainment; Allike como subempresa de GmbH). ¿Continuar?`)) return;
    setLoading('Importando el Excel…');
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('year', String(year));
      const res = await fetch('/api/closing/import', { method: 'POST', body: form });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Error al importar');
      setMessage(`Importado ${year}: ${d.summary.map((s: any) => `${label(s.company)}${s.group ? ` / ${s.group}` : ''} ${s.tasks}`).join(' · ')}${d.skipped.length ? ` · pestañas sin empresa: ${d.skipped.join(', ')}` : ''}`);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading('');
    }
  };

  const assignees = useMemo(() => Array.from(new Set([...users, ...tasks.map(t => t.assignee).filter((a): a is string => !!a)])), [users, tasks]);
  const shown = tasks.filter(t => !assigneeFilter || t.assignee === assigneeFilter);
  const currentMonth = year === thisYear ? new Date().getMonth() + 1 : 0;
  const statsOf = (list: Task[]) => MONTHS.map((_, i) => {
    const cells = list.map(t => cellOf(t, i + 1)).filter(c => c && c.done !== null && c.done !== undefined);
    return { done: cells.filter(c => c!.done).length, total: cells.length };
  });
  // Tabla principal y una por subempresa, en el orden de sus tareas
  const groups: string[] = Array.from(new Set([...tasks.map(t => t.group).filter((g): g is string => !!g), ...extraGroups]));

  const input = 'border border-gray-200 rounded-md px-2 py-1 text-sm focus:ring-2 focus:ring-black outline-none';
  const th = 'px-2 py-2 font-semibold';
  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24" onClick={() => setCommentCell(null)}>
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg">Tracking Cierre Mensual</p>
            <p className="text-xs text-gray-500">Clic en un mes: hecho → pendiente → vacío (no toca) · clic derecho: comentario</p>
          </div>
          {loading && <span className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={16} className="animate-spin" /> {loading}</span>}
          <select value={year} onChange={e => setYear(Number(e.target.value))} className={input}>
            {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={() => fileRef.current?.click()} className="flex items-center gap-2 border border-gray-200 text-sm font-semibold px-3 py-2 rounded-lg hover:bg-gray-50">
            <Upload size={16} /> Importar Excel
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => importExcel(e.target.files?.[0] || null)} />
          <button onClick={addGroup} className="flex items-center gap-2 border border-gray-200 text-sm font-semibold px-3 py-2 rounded-lg hover:bg-gray-50">
            <Plus size={16} /> Nueva subempresa
          </button>
          <button onClick={() => setNewTask({ description: '', assignee: '', group: null })} className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black">
            <Plus size={16} /> Nueva tarea
          </button>
        </div>
        <div className="w-full px-4 md:px-8 pb-3 flex flex-wrap items-center gap-3">
          <div className="flex bg-gray-100 rounded-lg p-1 flex-wrap">
            {COMPANIES.map(c => (
              <button key={c} onClick={() => setCompany(c)}
                className={`px-3 py-1.5 rounded-md text-sm font-semibold ${company === c ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                {label(c)}
              </button>
            ))}
          </div>
          <select value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)} className={input}>
            <option value="">Todos los responsables</option>
            {assignees.map(a => <option key={a} value={a}>{shortUser(a)}</option>)}
          </select>
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-6 space-y-4">
        {error && <p className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-center gap-2"><AlertCircle size={16} /> {error}<button onClick={() => setError('')} className="ml-auto"><X size={14} /></button></p>}
        {message && <p className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-900 flex items-center gap-2"><Check size={16} /> {message}<button onClick={() => setMessage('')} className="ml-auto"><X size={14} /></button></p>}

        {[null, ...groups].map(group => {
          const list = shown.filter(t => (t.group || null) === group);
          const stats = statsOf(list);
          return (
        <section key={group || ''} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {group && (
            <div className="px-4 py-2.5 border-b border-gray-200 flex flex-wrap items-center gap-3">
              <p className="font-bold text-gray-900">{group}</p>
              <span className="text-xs text-gray-500">subempresa de {label(company)}</span>
              <button onClick={() => setNewTask({ description: '', assignee: '', group })} className="ml-auto flex items-center gap-1 text-xs font-semibold text-gray-700 hover:text-gray-900"><Plus size={12} /> Tarea</button>
              <button onClick={() => renameGroup(group)} className="text-xs font-semibold text-gray-500 hover:text-gray-900">Renombrar</button>
              <button onClick={() => deleteGroup(group)} className="text-xs font-semibold text-gray-400 hover:text-red-600" title="Eliminar la subempresa"><Trash2 size={13} /></button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className={`${th} text-left w-12`}>Nº</th>
                  <th className={`${th} text-left min-w-72`}>Descripción</th>
                  <th className={`${th} text-left`}>Responsable</th>
                  {MONTHS.map((m, i) => <th key={m} className={`${th} text-center w-12 ${i + 1 === currentMonth ? 'bg-amber-100 text-amber-900' : ''}`}>{m}</th>)}
                  <th className={`${th} text-left min-w-48`}>Notas</th>
                  <th className={`${th} w-8`} />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map(t => (
                  <tr key={t.id} className="group">
                    <td className="px-2 py-1">
                      <input defaultValue={t.number} key={`n${t.id}-${t.number}`} onBlur={e => Number(e.target.value) !== t.number && patchTask(t, { number: Number(e.target.value) })}
                        className="w-10 bg-transparent text-gray-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-gray-300 rounded px-1" />
                    </td>
                    <td className="px-2 py-1">
                      <input defaultValue={t.description} key={`d${t.id}-${t.description}`} onBlur={e => e.target.value.trim() && e.target.value !== t.description && patchTask(t, { description: e.target.value })}
                        className="w-full bg-transparent font-medium text-gray-900 focus:bg-white focus:outline-none focus:ring-1 focus:ring-gray-300 rounded px-1" />
                    </td>
                    <td className="px-2 py-1">
                      <select value={t.assignee || ''} onChange={e => {
                        let v = e.target.value;
                        if (v === '__other') { v = prompt('Nombre del responsable (sin usuario en la web)')?.trim() || ''; if (!v) return; }
                        patchTask(t, { assignee: v || null });
                      }} className="bg-transparent text-sm text-gray-700 rounded px-1 py-0.5 hover:bg-gray-50 focus:outline-none">
                        <option value="">—</option>
                        {assignees.map(a => <option key={a} value={a}>{shortUser(a)}{users.includes(a) ? '' : ' (sin usuario)'}</option>)}
                        <option value="__other">Otro…</option>
                      </select>
                    </td>
                    {MONTHS.map((_, i) => {
                      const month = i + 1;
                      const c = cellOf(t, month);
                      const done = c?.done ?? null;
                      return (
                        <td key={month} className={`p-0.5 text-center ${month === currentMonth ? 'bg-amber-50' : ''}`}>
                          <button
                            onClick={e => { e.stopPropagation(); cycle(t, month); }}
                            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCommentCell({ task: t, month, x: e.clientX, y: e.clientY, text: c?.comment || '' }); }}
                            title={[c?.comment, c?.updatedBy ? `${shortUser(c.updatedBy)} · ${new Date(c.updatedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}` : ''].filter(Boolean).join('\n')}
                            className={`relative w-10 h-8 rounded-md font-bold text-sm transition-colors ${done === true ? 'bg-green-100 text-green-700 hover:bg-green-200' : done === false ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'text-gray-300 hover:bg-gray-100'}`}>
                            {done === true ? '✓' : done === false ? '✗' : '·'}
                            {c?.comment && <span className="absolute top-0 right-0 w-0 h-0 border-t-[7px] border-l-[7px] border-t-sky-500 border-l-transparent rounded-tr-md" />}
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-2 py-1">
                      <input defaultValue={t.notes || ''} key={`o${t.id}-${t.notes}`} onBlur={e => e.target.value.trim() !== (t.notes || '') && patchTask(t, { notes: e.target.value })}
                        placeholder="—" className="w-full bg-transparent text-xs text-gray-600 focus:bg-white focus:outline-none focus:ring-1 focus:ring-gray-300 rounded px-1" />
                    </td>
                    <td className="px-2 py-1">
                      <button onClick={() => deleteTask(t)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600" title="Eliminar tarea"><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
                {newTask && newTask.group === group && (
                  <tr className="bg-gray-50">
                    <td className="px-2 py-2 text-gray-400">+</td>
                    <td className="px-2 py-2"><input autoFocus value={newTask.description} onChange={e => setNewTask({ ...newTask, description: e.target.value })} onKeyDown={e => e.key === 'Enter' && addTask()} placeholder="Descripción de la tarea" className={`${input} w-full`} /></td>
                    <td className="px-2 py-2">
                      <select value={newTask.assignee} onChange={e => setNewTask({ ...newTask, assignee: e.target.value })} className={input}>
                        <option value="">—</option>
                        {assignees.map(a => <option key={a} value={a}>{shortUser(a)}</option>)}
                      </select>
                    </td>
                    <td colSpan={14} className="px-2 py-2">
                      <div className="flex gap-2">
                        <button onClick={addTask} disabled={!newTask.description.trim()} className="bg-gray-900 text-white text-sm font-semibold px-3 py-1.5 rounded-lg hover:bg-black disabled:opacity-40">Añadir</button>
                        <button onClick={() => setNewTask(null)} className="text-sm font-semibold text-gray-500 hover:text-gray-900 px-2">Cancelar</button>
                      </div>
                    </td>
                  </tr>
                )}
                {group && !list.length && !(newTask && newTask.group === group) && (
                  <tr><td colSpan={17} className="px-3 py-6 text-center text-gray-500">Sin tareas{assigneeFilter ? ' de este responsable' : ''}.</td></tr>
                )}
                {!group && !shown.length && !groups.length && !loading && !newTask && (
                  <tr><td colSpan={17} className="px-3 py-10 text-center text-gray-500">
                    No hay tareas de {label(company)} en {year}.
                    {previousYearTasks > 0 && !assigneeFilter && (
                      <button onClick={copyPrevious} className="ml-3 inline-flex items-center gap-1 font-semibold text-gray-900 hover:underline"><Copy size={14} /> Copiar las {previousYearTasks} tareas de {year - 1}</button>
                    )}
                  </td></tr>
                )}
              </tbody>
              {list.length > 0 && (
                <tfoot className="bg-gray-50 text-xs text-gray-500 border-t border-gray-200">
                  <tr>
                    <td colSpan={3} className="px-2 py-2 font-semibold uppercase tracking-wider">Hechas</td>
                    {stats.map((s, i) => (
                      <td key={i} className={`px-1 py-2 text-center font-semibold ${s.total && s.done === s.total ? 'text-green-700' : ''} ${i + 1 === currentMonth ? 'bg-amber-100 text-amber-900' : ''}`}>
                        {s.total ? `${s.done}/${s.total}` : ''}
                      </td>
                    ))}
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
          );
        })}
      </main>

      {commentCell && (
        <div onClick={e => e.stopPropagation()} style={{ left: Math.min(commentCell.x, window.innerWidth - 340), top: Math.min(commentCell.y + 8, window.innerHeight - 220) }}
          className="fixed z-30 w-80 bg-white border border-gray-200 rounded-xl shadow-xl p-3 space-y-2">
          <p className="text-xs font-semibold text-gray-500 flex items-center gap-1.5"><MessageSquare size={13} /> {commentCell.task.number}. {commentCell.task.description} · {MONTHS[commentCell.month - 1]} {year}</p>
          <textarea autoFocus rows={4} value={commentCell.text} onChange={e => setCommentCell({ ...commentCell, text: e.target.value })}
            className={`${input} w-full resize-none`} placeholder="Comentario" />
          <div className="flex gap-2 justify-end">
            {cellOf(commentCell.task, commentCell.month)?.comment && (
              <button onClick={() => { saveCell(commentCell.task, commentCell.month, { comment: '' }); setCommentCell(null); }} className="text-sm font-semibold text-red-600 hover:text-red-800 mr-auto">Borrar</button>
            )}
            <button onClick={() => setCommentCell(null)} className="text-sm font-semibold text-gray-500 hover:text-gray-900 px-2">Cancelar</button>
            <button onClick={() => { saveCell(commentCell.task, commentCell.month, { comment: commentCell.text }); setCommentCell(null); }}
              className="bg-gray-900 text-white text-sm font-semibold px-3 py-1.5 rounded-lg hover:bg-black">Guardar</button>
          </div>
        </div>
      )}
    </div>
  );
}
