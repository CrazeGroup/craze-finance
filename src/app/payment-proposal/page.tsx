'use client';

import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { ChevronDown, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

type Entry = {
  entryNo: number; vendorNo: string; vendorName: string; docType: string; docNo: string; extDocNo: string;
  description: string; postingDate: string; dueDate: string;
  remaining: number; remainingLCY: number | null; currency: string;
  approvalPct: number; approvedUsers: string; pendingUsers: string;
};
type Proposal = {
  company: string; from: string; to: string; lcy: string; entries: Entry[];
  fields: { pendingUsers: boolean; approvalUsers: boolean; currency: boolean; remainingLCY: boolean };
};

const APPROVED_PCT = 100;
const iso = (d: Date) => d.toISOString().substring(0, 10);
const dateEs = (d: string) => (d ? d.split('-').reverse().join('/') : '');
const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v: number | null | undefined) => (v == null ? '—' : nf.format(v));
const sum = (list: Entry[], f: (e: Entry) => number | null) => list.reduce((s, e) => s + (f(e) || 0), 0);

// Proveedor → movimientos, ordenado por nombre
function byVendor(list: Entry[]) {
  const map = new Map<string, Entry[]>();
  list.forEach(e => map.set(e.vendorName, [...(map.get(e.vendorName) || []), e]));
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

export default function PaymentProposalPage() {
  const { selectedCompany } = useCompany();
  const [range, setRange] = useState(() => ({ from: `${new Date().getFullYear()}-01-01`, to: iso(new Date()) }));
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedCompany === 'ALL' || !range.from || !range.to || range.from > range.to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/payment-proposal?from=${range.from}&to=${range.to}`)
      .then(async res => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(json.error || 'Error al leer los movimientos de proveedor'); setData(null); }
        else setData(json);
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCompany, range, reload]);

  const entries = data?.entries || [];
  const lcy = data?.lcy || 'EUR';
  // Divisas en columnas: la local primero
  const currencies = useMemo(() => Array.from(new Set(entries.map(e => e.currency))).sort((a, b) => (a === lcy ? -1 : b === lcy ? 1 : a.localeCompare(b))), [entries, lcy]);
  const approved = entries.filter(e => e.approvalPct >= APPROVED_PCT);
  const pending = entries.filter(e => e.approvalPct < APPROVED_PCT);

  const exportExcel = () => {
    const head = ['Proveedor', 'Nº proveedor', 'Document Type', 'Nº documento', 'Nº documento externo', 'Descripción', 'Fecha registro', 'Vencimiento', '% Payment Approval', 'Approved Users', 'Pending Users', 'Divisa', 'Remaining Amount', `Remaining Amt. (${lcy})`];
    const line = (e: Entry) => [e.vendorName, e.vendorNo, e.docType, e.docNo, e.extDocNo, e.description, e.postingDate, e.dueDate, e.approvalPct, e.approvedUsers, e.pendingUsers, e.currency, e.remaining, e.remainingLCY];
    const sheet = (title: string, list: Entry[]) => {
      const ws = XLSX.utils.aoa_to_sheet([[title], head, ...list.map(line)]);
      ws['!cols'] = [{ wch: 36 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 28 }, { wch: 11 }, { wch: 11 }, { wch: 8 }, { wch: 28 }, { wch: 28 }, { wch: 7 }, { wch: 14 }, { wch: 14 }];
      return ws;
    };
    const wb = XLSX.utils.book_new();
    const sub = `${selectedCompany} · vencimiento ${dateEs(range.from)} – ${dateEs(range.to)}`;
    XLSX.utils.book_append_sheet(wb, sheet(`Approved for Payment · ${sub}`, approved), 'Approved for Payment');
    XLSX.utils.book_append_sheet(wb, sheet(`Pending Approval · ${sub}`, [...pending].sort((a, b) => a.pendingUsers.localeCompare(b.pendingUsers) || a.vendorName.localeCompare(b.vendorName))), 'Pending Approval');
    XLSX.writeFile(wb, `Payment_Proposal_${selectedCompany}_${range.from}_${range.to}.xlsx`.replace(/\s+/g, '_'));
  };

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg">Payment Proposal</p>
            <p className="text-xs text-gray-500">{selectedCompany} · facturas y abonos abiertos · No Payment = No · forma de pago TRANSFER · sin proveedores CRAZE</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Due Date</span>
            <input type="date" value={range.from} max={range.to} onChange={e => e.target.value && setRange(r => ({ ...r, from: e.target.value }))}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" />
            <span className="text-gray-400 text-sm">–</span>
            <input type="date" value={range.to} min={range.from} onChange={e => e.target.value && setRange(r => ({ ...r, to: e.target.value }))}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold bg-white" />
            <button onClick={() => setReload(n => n + 1)} disabled={loading} title="Volver a leer de Business Central"
              className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={exportExcel} disabled={loading || !entries.length}
              className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
              <Download size={16} /> Exportar Excel
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-8 pt-6 space-y-6">
        {selectedCompany === 'ALL' ? (
          <p className="text-sm text-gray-600">Selecciona una empresa concreta en el menú lateral.</p>
        ) : error ? (
          <p className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700">{error}</p>
        ) : !data ? (
          <p className="text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Leyendo movimientos de proveedor de Business Central…</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Kpi label={`Approved for Payment (${lcy})`} value={money(sum(approved, e => e.remainingLCY))} sub={`${approved.length} documentos · ${byVendor(approved).length} proveedores`} />
              <Kpi label={`Pending Approval (${lcy})`} value={money(sum(pending, e => e.remainingLCY))} sub={`${pending.length} documentos · ${byVendor(pending).length} proveedores`} />
              <Kpi label={`Total propuesta (${lcy})`} value={money(sum(entries, e => e.remainingLCY))} sub={`Vencimiento ${dateEs(range.from)} – ${dateEs(range.to)}`} />
            </div>

            <ProposalTable title="Approved for Payment" subtitle={`% Payment Approval ≥ ${APPROVED_PCT}`} entries={approved} currencies={currencies} lcy={lcy} />
            <ProposalTable title="Pending Approval" subtitle={`% Payment Approval < ${APPROVED_PCT} · agrupado por Pending Users`} entries={pending} currencies={currencies} lcy={lcy} groupByPending />

            <p className="text-xs text-gray-500">
              Fuente: Vendor Ledger Entries de Business Central en directo. Importes = Remaining Amount en la divisa del documento; la columna {lcy} usa Remaining Amt. (LCY).
              {!data.fields.pendingUsers && ' Pending Users calculado como Approval Users menos Approved Users.'}
              {!data.fields.remainingLCY && data.entries.some(e => e.remainingLCY == null) && ` Los documentos en divisa no tienen importe en ${lcy} en la API: no suman en esa columna.`}
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 tabular-nums mt-1">{value}</p>
      {sub && <p className="text-xs mt-1 text-gray-500">{sub}</p>}
    </div>
  );
}

function ProposalTable({ title, subtitle, entries, currencies, lcy, groupByPending }: {
  title: string; subtitle: string; entries: Entry[]; currencies: string[]; lcy: string; groupByPending?: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const cols = currencies.length + 2;
  const amountCells = (list: Entry[], bold = false) => (
    <>
      {currencies.map(c => {
        const inCur = list.filter(e => e.currency === c);
        return <td key={c} className={`px-3 py-2 text-right tabular-nums ${bold ? 'font-bold' : ''}`}>{inCur.length ? money(sum(inCur, e => e.remaining)) : ''}</td>;
      })}
      <td className={`px-3 py-2 text-right tabular-nums ${bold ? 'font-bold' : 'font-semibold'}`}>{money(sum(list, e => e.remainingLCY))}</td>
    </>
  );
  const groups: [string, Entry[]][] = groupByPending
    ? Array.from(entries.reduce((m, e) => m.set(e.pendingUsers, [...(m.get(e.pendingUsers) || []), e]), new Map<string, Entry[]>()).entries()).sort((a, b) => a[0].localeCompare(b[0]))
    : [['', entries]];

  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-sm font-bold text-gray-900">{title}</h2>
        <span className="text-xs text-gray-500">{subtitle} · haz clic en un proveedor para ver sus facturas</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="text-left px-3 py-2">{groupByPending ? 'Pending Users / Proveedor' : 'Proveedor'}</th>
              {currencies.map(c => <th key={c} className="text-right px-3 py-2">{c}</th>)}
              <th className="text-right px-3 py-2">Total ({lcy})</th>
            </tr>
          </thead>
          <tbody>
            {!entries.length && <tr><td colSpan={cols} className="px-3 py-6 text-center text-gray-500">No hay documentos.</td></tr>}
            {groups.map(([pendingUsers, list]) => (
              <React.Fragment key={pendingUsers || '-'}>
                {groupByPending && (
                  <tr className="border-t border-gray-200 bg-indigo-50/60 text-gray-900">
                    <td className="px-3 py-2 font-bold">{pendingUsers || '(sin usuarios pendientes)'}</td>
                    {amountCells(list, true)}
                  </tr>
                )}
                {byVendor(list).map(([vendor, docs]) => {
                  const key = `${pendingUsers}|${vendor}`;
                  const isOpen = open.has(key);
                  return (
                    <React.Fragment key={key}>
                      <tr onClick={() => toggle(key)} className="border-t border-gray-100 cursor-pointer hover:bg-gray-50 text-gray-900">
                        <td className={`py-2 pr-3 ${groupByPending ? 'pl-7' : 'pl-3'}`}>
                          <span className="inline-flex items-center gap-1.5">
                            {isOpen ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                            {vendor}
                            <span className="text-xs text-gray-400">({docs.length})</span>
                          </span>
                        </td>
                        {amountCells(docs)}
                      </tr>
                      {isOpen && (
                        <tr className="bg-gray-50/70">
                          <td colSpan={cols} className={`py-2 pr-3 ${groupByPending ? 'pl-12' : 'pl-8'}`}>
                            <table className="w-full text-xs">
                              <thead className="text-gray-500">
                                <tr>
                                  <th className="text-left py-1 pr-3">Tipo</th>
                                  <th className="text-left py-1 pr-3">Nº documento</th>
                                  <th className="text-left py-1 pr-3">Nº doc. externo</th>
                                  <th className="text-left py-1 pr-3">Descripción</th>
                                  <th className="text-left py-1 pr-3">Registro</th>
                                  <th className="text-left py-1 pr-3">Vencimiento</th>
                                  <th className="text-right py-1 pr-3">% Aprob.</th>
                                  <th className="text-left py-1 pr-3">Aprobado por</th>
                                  {groupByPending && <th className="text-left py-1 pr-3">Pendiente de</th>}
                                  <th className="text-right py-1 pr-3">Importe</th>
                                  <th className="text-right py-1">{lcy}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {docs.map(d => (
                                  <tr key={d.entryNo} className="border-t border-gray-200 text-gray-800">
                                    <td className="py-1 pr-3 whitespace-nowrap">{d.docType === 'Credit Memo' ? 'Abono' : 'Factura'}</td>
                                    <td className="py-1 pr-3 font-mono">{d.docNo}</td>
                                    <td className="py-1 pr-3">{d.extDocNo}</td>
                                    <td className="py-1 pr-3">{d.description}</td>
                                    <td className="py-1 pr-3 whitespace-nowrap">{dateEs(d.postingDate)}</td>
                                    <td className="py-1 pr-3 whitespace-nowrap">{dateEs(d.dueDate)}</td>
                                    <td className="py-1 pr-3 text-right tabular-nums">{d.approvalPct}</td>
                                    <td className="py-1 pr-3">{d.approvedUsers || '—'}</td>
                                    {groupByPending && <td className="py-1 pr-3">{d.pendingUsers || '—'}</td>}
                                    <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{money(d.remaining)} {d.currency}</td>
                                    <td className="py-1 text-right tabular-nums">{money(d.remainingLCY)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
          {entries.length > 0 && (
            <tfoot className="bg-gray-50 text-gray-900">
              <tr className="border-t-2 border-gray-300">
                <td className="px-3 py-2 font-bold">Total general</td>
                {amountCells(entries, true)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
