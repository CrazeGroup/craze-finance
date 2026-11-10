'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, Loader2, Plus, Send, Trash2, Upload } from 'lucide-react';
import { companyLabel, useCompany } from '@/contexts/CompanyContext';
import type { AccountType, MovementResult, SuggestedLine } from '@/lib/banco';

// BANCO: sube el extracto del banco (CSV o Excel), cuadra los movimientos con las Bank Account Ledger Entries de la cuenta elegida
// y sugiere las líneas del General Journal de los que faltan, para enviarlas al lote del banco (p. ej. SPARKASSE).
type Bank = { number: string; name: string; iban: string; currency: string };
type Journal = { code: string; name: string; bankNo: string };
type Row = MovementResult & { selected: boolean; documentNo: string; lines: SuggestedLine[] };
type Filter = 'new' | 'batch' | 'posted' | 'all';

const TYPES: { value: AccountType; label: string }[] = [
  { value: 'G/L Account', label: 'Cuenta' }, { value: 'Customer', label: 'Cliente' },
  { value: 'Vendor', label: 'Proveedor' }, { value: 'Bank Account', label: 'Banco' },
];
const fmt = (v: number) => v.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fdate = (d: string) => d.split('-').reverse().join('.');
const cents = (v: number) => Math.round(v * 100);
const linesOk = (r: Row) => r.lines.length > 0 && r.lines.every(l => l.accountType && l.accountNo.trim() && l.amount)
  && cents(r.lines.reduce((t, l) => t + l.amount, 0)) === cents(r.amount);

export default function BancoPage() {
  const { selectedCompany } = useCompany();
  const [banks, setBanks] = useState<Bank[]>([]);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [bankNo, setBankNo] = useState('');
  const [journalCode, setJournalCode] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [info, setInfo] = useState<{ warning: string; entries: number; from: string; held: { date: string; valueDate: string; name: string; purpose: string; amount: number }[] } | null>(null);
  const [filter, setFilter] = useState<Filter>('new');
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ lines: number; documentNumbers: string[]; warnings: string[] } | null>(null);
  // Amazon Vendor (AMAVEN): los pagos se leen de la API de Amazon en vez de un extracto
  const [period, setPeriod] = useState(() => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: iso(new Date(Date.now() - 30 * 86400000)), to: iso(new Date()) };
  });
  const isAmazon = (no: string) => /^AMAVEN$/i.test(no) || /amazon\s*vendor/i.test(banks.find(b => b.number === no)?.name || '');
  const amazon = isAmazon(bankNo);

  useEffect(() => {
    if (selectedCompany === 'ALL') return;
    setLoading('Cargando cuentas de banco…');
    fetch('/api/banco').then(r => r.json()).then(d => {
      if (d.error) throw new Error(d.error);
      setBanks(d.banks);
      setJournals(d.journals);
      let saved = '';
      try { saved = localStorage.getItem('crz-banco-bank') || ''; } catch { /* sin almacenamiento */ }
      const first = d.banks.find((b: Bank) => b.number === saved) || d.banks.find((b: Bank) => d.journals.some((j: Journal) => j.bankNo === b.number)) || d.banks[0];
      if (first) chooseBank(first.number, d.journals);
    }).catch(e => setError(e.message)).finally(() => setLoading(''));
  }, [selectedCompany]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseBank = (no: string, js = journals) => {
    setBankNo(no);
    setJournalCode(js.find(j => j.bankNo === no)?.code || '');
    setRows([]);
    setInfo(null);
    setSent(null);
    try { localStorage.setItem('crz-banco-bank', no); } catch { /* sin almacenamiento */ }
  };

  // Al elegir el fichero, selecciona la cuenta de BC con el IBAN del extracto (columna Auftragskonto)
  const chooseFile = async (f: File | null) => {
    setFile(f);
    setRows([]);
    setInfo(null);
    setSent(null);
    if (!f) return;
    // Solo en CSV (Sparkasse: Auftragskonto en la primera columna); en Excel la cuenta se elige a mano
    const iban = /\.csv$/i.test(f.name) ? (await f.text()).split(/\r?\n/)[1]?.split(';')[0]?.replace(/["\s]/g, '').toUpperCase() : '';
    const bank = iban && banks.find(b => b.iban === iban);
    if (bank && bank.number !== bankNo) {
      setBankNo(bank.number);
      setJournalCode(journals.find(j => j.bankNo === bank.number)?.code || '');
    }
  };

  const analyze = async () => {
    if ((!amazon && !file) || !bankNo) return;
    setLoading(amazon ? 'Leyendo los pagos de Amazon y cuadrándolos con AMAVEN (Amazon deja leer un pago cada 2 s)…' : 'Cuadrando el extracto con BC…');
    setError('');
    setSent(null);
    try {
      let res: Response;
      if (amazon) {
        res = await fetch('/api/banco/amazon', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bankNo, journalCode, from: period.from, to: period.to }),
        });
      } else {
        const form = new FormData();
        form.append('file', file!);
        form.append('bankNo', bankNo);
        form.append('journalCode', journalCode);
        res = await fetch('/api/banco', { method: 'POST', body: form });
      }
      const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(d.error || 'Error al analizar el extracto');
      setInfo({ warning: d.warning, entries: d.entries, from: d.from, held: d.held || [] });
      setRows(d.movements.map((m: MovementResult) => {
        const row: Row = { ...m, selected: false, documentNo: m.suggestion?.documentNo || '', lines: m.suggestion?.lines.map(l => ({ ...l })) || [] };
        row.selected = m.status === 'new' && !m.pending && !m.doubtful && linesOk(row);
        return row;
      }));
      setFilter('new');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading('');
    }
  };

  const update = (idx: number, change: (r: Row) => Row) => setRows(rs => rs.map(r => (r.idx === idx ? change(r) : r)));
  const setLine = (idx: number, i: number, patch: Partial<SuggestedLine>) =>
    update(idx, r => ({ ...r, lines: r.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const counts = useMemo(() => ({
    all: rows.length, posted: rows.filter(r => r.status === 'posted').length,
    batch: rows.filter(r => r.status === 'batch').length, new: rows.filter(r => r.status === 'new').length,
  }), [rows]);
  const shown = rows.filter(r => filter === 'all' || r.status === filter);
  const toSend = rows.filter(r => r.status === 'new' && r.selected);
  const invalid = toSend.filter(r => !linesOk(r));

  const send = async () => {
    if (!toSend.length || invalid.length) return;
    if (!confirm(`¿Enviar ${toSend.length} movimientos (${toSend.reduce((t, r) => t + r.lines.length, 0)} líneas) al lote ${journalCode}?`)) return;
    setLoading(`Enviando al lote ${journalCode}…`);
    setError('');
    try {
      const res = await fetch('/api/banco/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journalCode, bankNo, movements: toSend.map(r => ({ date: r.date, documentNo: r.documentNo, lines: r.lines })) }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Error al enviar a BC');
      setSent(d);
      const done = new Set(toSend.map(r => r.idx));
      setRows(rs => rs.map(r => (done.has(r.idx) ? { ...r, status: 'batch', selected: false } : r)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading('');
    }
  };

  if (selectedCompany === 'ALL') {
    return <div className="min-h-screen bg-[#F3F4F7] p-8"><p className="text-sm text-gray-600">Selecciona una empresa concreta en el menú lateral.</p></div>;
  }

  const input = 'border border-gray-200 rounded-md px-2 py-1 text-sm focus:ring-2 focus:ring-black outline-none';
  const th = 'px-3 py-2 font-semibold';
  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-28">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="w-full px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg">BANCO</p>
            <p className="text-xs text-gray-500">{companyLabel(selectedCompany)} · {amazon ? 'pagos de Amazon Vendor (API) → General Journal' : 'extracto del banco → General Journal'}</p>
          </div>
          {loading && <span className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={16} className="animate-spin" /> {loading}</span>}
        </div>
      </header>

      <main className="w-full px-4 md:px-8 pt-6 space-y-4">
        <section className="bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap items-end gap-4">
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Bank Account
            <select value={bankNo} onChange={e => chooseBank(e.target.value)} className={`${input} block mt-1 normal-case tracking-normal font-normal min-w-72`}>
              {banks.map(b => <option key={b.number} value={b.number}>{b.number} · {b.name}{b.currency ? ` (${b.currency})` : ''}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Lote del General Journal
            <select value={journalCode} onChange={e => setJournalCode(e.target.value)} className={`${input} block mt-1 normal-case tracking-normal font-normal min-w-56`}>
              <option value="">(ninguno)</option>
              {journals.map(j => <option key={j.code} value={j.code}>{j.code}{j.name && j.name !== j.code ? ` · ${j.name}` : ''}{j.bankNo ? ` → ${j.bankNo}` : ''}</option>)}
            </select>
          </label>
          {amazon ? (
            <>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Pagos de Amazon desde
                <input type="date" value={period.from} onChange={e => setPeriod(p => ({ ...p, from: e.target.value }))} className={`${input} block mt-1 normal-case tracking-normal font-normal`} />
              </label>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Hasta
                <input type="date" value={period.to} onChange={e => setPeriod(p => ({ ...p, to: e.target.value }))} className={`${input} block mt-1 normal-case tracking-normal font-normal`} />
              </label>
            </>
          ) : (
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Extracto (CSV o Excel)
            {/* El input de fichero, oculto: el botón es la etiqueta */}
            <label className={`mt-1 flex items-center gap-2 cursor-pointer border rounded-lg px-3 py-2 text-sm font-semibold normal-case tracking-normal max-w-xs ${file ? 'border-indigo-300 bg-indigo-50 text-indigo-800 hover:bg-indigo-100' : 'border-dashed border-indigo-400 bg-white text-indigo-700 hover:bg-indigo-50'}`}>
              <FileText size={16} className="shrink-0" />
              <span className="truncate">{file ? file.name : 'Seleccionar extracto…'}</span>
              <input type="file" accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={e => chooseFile(e.target.files?.[0] || null)} className="hidden" />
            </label>
          </div>
          )}
          <button onClick={analyze} disabled={(!amazon && !file) || !bankNo || !!loading}
            className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
            <Upload size={16} /> {amazon ? 'Leer pagos de Amazon' : 'Analizar'}
          </button>
        </section>

        {error && <p className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-center gap-2"><AlertCircle size={16} /> {error}</p>}
        {info?.warning && <p className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex items-center gap-2"><AlertCircle size={16} /> {info.warning}</p>}
        {!!info?.held.length && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700">
            <p className="font-semibold flex items-center gap-2"><AlertCircle size={16} className="text-gray-500" />
              {amazon
                ? `${info.held.length} ${info.held.length === 1 ? 'pago de Amazon en curso' : 'pagos de Amazon en curso'} (IN_PROGRESS, aún no enviados): no se sugieren ·`
                : `${info.held.length} ${info.held.length === 1 ? 'movimiento vorgemerkt' : 'movimientos vorgemerkt'} (retenidos, aún no cargados en la cuenta): no se sugieren ·`} {info.held.reduce((t, m) => t + m.amount, 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <ul className="mt-1 ml-6 text-xs text-gray-500 space-y-0.5">
              {info.held.map((m, i) => <li key={i}>{m.valueDate || m.date} · {m.name || '—'} · {m.purpose.slice(0, 90)} · <span className="font-mono">{m.amount.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></li>)}
            </ul>
          </div>
        )}
        {sent && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-900 space-y-1">
            <p className="flex items-center gap-2 font-semibold"><CheckCircle2 size={16} /> {sent.lines} líneas creadas en el lote {journalCode} (sin registrar){sent.documentNumbers.length ? `: ${sent.documentNumbers[0]}${sent.documentNumbers.length > 1 ? ` … ${sent.documentNumbers[sent.documentNumbers.length - 1]}` : ''}` : ''}</p>
            {sent.warnings.map((w, i) => <p key={i} className="text-amber-800">{w}</p>)}
          </div>
        )}

        {rows.length > 0 && (
          <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-3">
              <div className="flex bg-gray-100 rounded-lg p-1">
                {([['new', 'Por registrar'], ['batch', 'En el lote'], ['posted', 'Ya en BC'], ['all', 'Todos']] as [Filter, string][]).map(([id, label]) => (
                  <button key={id} onClick={() => setFilter(id)}
                    className={`px-3 py-1 rounded-md text-sm font-semibold ${filter === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}>
                    {label} <span className="text-gray-400 font-normal">{counts[id]}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-500">
                Cuadrado con {info?.entries} Bank Ledger Entries de {bankNo} desde el {info && fdate(info.from)}
                {journalCode ? ` y con las líneas pendientes del lote ${journalCode}` : ''}.
              </p>
              {filter === 'new' && counts.new > 0 && (
                <button onClick={() => setRows(rs => { const all = rs.filter(r => r.status === 'new').every(r => r.selected); return rs.map(r => (r.status === 'new' ? { ...r, selected: !all } : r)); })}
                  className="ml-auto text-xs font-semibold text-gray-600 hover:text-gray-900">Marcar / desmarcar todos</button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className={`${th} w-8`} />
                    <th className={`${th} text-left`}>Fecha</th>
                    <th className={`${th} text-left`}>Contrapartida / concepto</th>
                    <th className={`${th} text-right`}>Importe</th>
                    <th className={`${th} text-left`}>{filter === 'posted' || filter === 'batch' ? 'En BC' : 'Líneas del diario'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {shown.map(r => (
                    <tr key={r.idx} className={`align-top ${r.status === 'new' && !r.selected ? 'bg-gray-50/60' : ''}`}>
                      <td className="px-3 py-2">
                        {r.status === 'new' && <input type="checkbox" checked={r.selected} onChange={e => update(r.idx, x => ({ ...x, selected: e.target.checked }))} className="mt-1" />}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {fdate(r.date)}
                        {r.pending && <span className="block text-[11px] font-semibold text-amber-700">vorgemerkt</span>}
                      </td>
                      <td className="px-3 py-2 max-w-md">
                        <p className="font-medium text-gray-900">{r.name || r.text}</p>
                        <p className="text-xs text-gray-500 break-words">{r.purpose}</p>
                        {r.iban && <p className="text-[11px] text-gray-400">{r.iban}</p>}
                      </td>
                      <td className={`px-3 py-2 text-right whitespace-nowrap font-semibold ${r.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>{fmt(r.amount)}</td>
                      <td className="px-3 py-2">
                        {r.status !== 'new' ? (
                          <div className="space-y-0.5 text-xs text-gray-600">
                            {r.status === 'batch' && <p className="font-semibold text-sky-700">En el lote {journalCode}, sin registrar</p>}
                            {r.matched.map((e, i) => (
                              <p key={i}>{e.docNo} · {fdate(e.date)} · {e.balType ? `${e.balType} ${e.balNo} · ` : ''}{e.description}{r.matched.length > 1 ? ` · ${fmt(e.amount)}` : ''}</p>
                            ))}
                          </div>
                        ) : (
                          <LinesEditor row={r} input={input} setLine={(i, p) => setLine(r.idx, i, p)}
                            setDoc={v => update(r.idx, x => ({ ...x, documentNo: v }))}
                            addLine={() => update(r.idx, x => ({ ...x, lines: [...x.lines, { accountType: x.lines[0]?.accountType || '', accountNo: x.lines[0]?.accountNo || '', accountName: '', description: x.lines[0]?.description || '', amount: Math.round((x.amount - x.lines.reduce((t, l) => t + l.amount, 0)) * 100) / 100 }] }))}
                            removeLine={i => update(r.idx, x => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))} />
                        )}
                      </td>
                    </tr>
                  ))}
                  {!shown.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-500">Nada en esta vista.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {counts.new > 0 && (
        <div className="fixed bottom-0 left-64 right-0 z-20 bg-white border-t border-gray-200 px-4 md:px-8 py-3 flex flex-wrap items-center gap-4">
          <p className="text-sm text-gray-600 mr-auto">
            {toSend.length} movimientos marcados · {fmt(toSend.reduce((t, r) => t + r.amount, 0))}
            {invalid.length > 0 && <span className="text-red-700"> · {invalid.length} sin cuenta o con líneas que no suman el importe</span>}
          </p>
          <button onClick={send} disabled={!journalCode || !toSend.length || invalid.length > 0 || !!loading}
            className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-black disabled:opacity-40">
            <Send size={16} /> Enviar al lote {journalCode || '…'}
          </button>
        </div>
      )}
    </div>
  );
}

function LinesEditor({ row, input, setLine, setDoc, addLine, removeLine }: {
  row: Row; input: string; setLine: (i: number, patch: Partial<SuggestedLine>) => void; setDoc: (v: string) => void;
  addLine: () => void; removeLine: (i: number) => void;
}) {
  const s = row.suggestion;
  const diff = row.amount - row.lines.reduce((t, l) => t + l.amount, 0);
  return (
    <div className="space-y-1.5 min-w-[560px]">
      {row.lines.map((l, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <select value={l.accountType} onChange={e => setLine(i, { accountType: e.target.value as AccountType })} className={`${input} w-28 ${!l.accountType ? 'border-red-300' : ''}`}>
            <option value="">—</option>
            {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <input value={l.accountNo} onChange={e => setLine(i, { accountNo: e.target.value, accountName: '' })} placeholder="Nº cuenta"
            title={l.accountName} className={`${input} w-24 ${!l.accountNo.trim() ? 'border-red-300' : ''}`} />
          <input value={l.description} onChange={e => setLine(i, { description: e.target.value })} maxLength={100} className={`${input} flex-1 min-w-0`} />
          {row.lines.length > 1 ? (
            <input type="number" step="0.01" value={l.amount} onChange={e => setLine(i, { amount: parseFloat(e.target.value) || 0 })} className={`${input} w-28 text-right`} />
          ) : <span className="w-28 text-right text-gray-500">{fmt(l.amount)}</span>}
          {l.appliesToDocNo && (
            <button onClick={() => setLine(i, { appliesToDocNo: undefined, appliesToDocType: undefined })} title="Quitar la liquidación"
              className="text-[11px] bg-sky-50 text-sky-700 border border-sky-200 rounded px-1.5 py-0.5 whitespace-nowrap hover:line-through">liq. {l.appliesToDocNo}</button>
          )}
          {row.lines.length > 1 && <button onClick={() => removeLine(i)} className="text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input value={row.documentNo} onChange={e => setDoc(e.target.value)} placeholder="Nº documento (auto)" className={`${input} w-40 text-xs`} />
        <button onClick={addLine} className="flex items-center gap-1 font-semibold text-gray-600 hover:text-gray-900"><Plus size={12} /> Línea</button>
        {s?.source && <span className="bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 font-semibold">{s.source}</span>}
        {row.lines[0]?.accountName && <span className="text-gray-500">{row.lines[0].accountName}</span>}
        {s?.note && <span className={row.doubtful ? 'text-amber-700 font-semibold' : 'text-gray-500'}>{s.note}</span>}
        {cents(diff) !== 0 && <span className="text-red-700 font-semibold">Faltan {fmt(diff)}</span>}
      </div>
    </div>
  );
}
