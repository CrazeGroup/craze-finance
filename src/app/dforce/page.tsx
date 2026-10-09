'use client';

import { useMemo, useState, type ReactNode } from 'react';
import * as XLSX from 'xlsx';
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, FileText, RefreshCw } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { ACC_PROVISION, buildProvisions, journalLines, PROVISION_RATE } from '@/lib/dforceProvisions';

type SalesLine = {
  documentType: 'Invoice' | 'Credit Memo'; lineNo: number; no: string; description: string; description2: string;
  quantity: number; unitPrice: number; unitCost: number | null; amount: number; returnReason: string; project: string; task: string;
  appendix: string;
};
type PurchaseLine = {
  lineNo: number; no: string; description: string; description2: string; quantity: number; directUnitCost: number;
  project: string; task: string; lineAmount: number;
};
type Result = {
  creditNo: string; period: string; invoice: SalesLine[]; credit: SalesLine[]; purchase: PurchaseLine[]; warnings: string[];
  totals: { invoice: number; returns: number; nonRecReversals: number; creditMemo: number; purchase: number; net: number; pdfNet: number | null };
  customerNo: string; vendorNo: string; location: string; files: { pdf: string; excel: string };
};

const DFORCE_COMPANY = 'Craze Entertainment';
const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 5 });
const qf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const money = (v: number | null | undefined) => (v == null ? '' : nf.format(v));

const SALES_HEAD = ['Document Type', 'Document No.', 'Line No.', 'Sell-to Customer No.', 'Type', 'No.', 'Location Code', 'Description', 'Description 2', 'Quantity', 'Unit Price', 'Unit Cost (LCY)', 'Amount', 'VAT Prod. Posting Group', 'Return Reason Code', 'Project No.', 'Project Task No.', 'Project Task No.2'];
const PURCHASE_HEAD = ['Document Type', 'Document No.', 'Line No.', 'Buy-from Vendor No.', 'Type', 'No.', 'Location Code', 'Description', 'Description 2', 'Quantity', 'Direct Unit Cost', 'Project No.', 'VAT Prod. Posting Group', 'Line Amount', 'Project Task No.'];

export default function DForcePage() {
  const { selectedCompany } = useCompany();
  const [pdf, setPdf] = useState<File | null>(null);
  const [excel, setExcel] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Result | null>(null);
  // Nº de los documentos ya creados en BC (cabeceras) a los que se importan las líneas
  const [docNo, setDocNo] = useState({ invoice: '', credit: '', purchase: '' });
  // Provisiones: coste unitario por artículo (de BC, editable) y fecha de registro (fin del periodo de la Gutschrift)
  const [costOverride, setCostOverride] = useState<Record<string, string>>({});
  const [postingDate, setPostingDate] = useState('');

  const unitCosts = useMemo(() => {
    const m: Record<string, number | null> = {};
    [...(data?.invoice || []), ...(data?.credit || [])].forEach(l => { if (m[l.no] == null) m[l.no] = l.unitCost; });
    Object.entries(costOverride).forEach(([k, v]) => { const n = parseFloat(v.replace(',', '.')); if (!isNaN(n)) m[k] = n; });
    return m;
  }, [data, costOverride]);
  const provisions = useMemo(() => (data ? buildProvisions(data.invoice, data.credit, unitCosts) : []), [data, unitCosts]);
  const journal = useMemo(() => journalLines(provisions, postingDate, data?.creditNo || ''), [provisions, postingDate, data]);

  const process = async () => {
    if (!pdf || !excel) return;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('pdf', pdf);
      form.append('excel', excel);
      const res = await fetch('/api/dforce/process', { method: 'POST', body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Error al procesar (${res.status})`);
      setData(json);
      setCostOverride({});
      // "01.08.2026 – 31.08.2026" → 2026-08-31
      const end = String(json.period || '').match(/(\d{2})\.(\d{2})\.(\d{4})\s*$/);
      setPostingDate(end ? `${end[3]}-${end[2]}-${end[1]}` : '');
    } catch (e: any) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  // Excel con el formato de los paquetes de configuración "D-FORCE" (Sales Line 37 y Purchase Line 39)
  const exportExcel = () => {
    if (!data) return;
    const salesRow = (l: SalesLine) => [
      l.documentType, l.documentType === 'Invoice' ? docNo.invoice : docNo.credit, l.lineNo, data.customerNo, 'Item', l.no, data.location,
      l.description, l.description2, l.quantity, l.unitPrice, l.unitCost ?? '', l.amount, '7% GOODS', l.returnReason, l.project, l.task, '',
    ];
    const purchaseRow = (l: PurchaseLine) => [
      'Invoice', docNo.purchase, l.lineNo, data.vendorNo, 'Item', l.no, '', l.description, l.description2, l.quantity, l.directUnitCost,
      l.project, '7% SERVICE', l.lineAmount, l.task,
    ];
    const sheet = (title: string, table: string, head: string[], rows: any[][]) => {
      const ws = XLSX.utils.aoa_to_sheet([['D-FORCE', title, table], [], head, ...rows]);
      ws['!cols'] = head.map(h => ({ wch: /Description$/.test(h) ? 50 : /Description 2/.test(h) ? 26 : 16 }));
      return ws;
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet('Sales Line', '37', SALES_HEAD, [...data.invoice, ...data.credit].map(salesRow)), 'Sales Line');
    XLSX.utils.book_append_sheet(wb, sheet('Purchase Line', '39', PURCHASE_HEAD, data.purchase.map(purchaseRow)), '39 Purchase Line');
    const jHead = ['Posting Date', 'Document No.', 'Account Type', 'Account No.', 'Description', 'Amount', 'Bal. Account Type', 'Bal. Account No.'];
    const jRows = journal.map(j => [j.postingDate, j.documentNo, 'G/L Account', j.accountNo, j.description, j.amount, 'G/L Account', j.balAccountNo]);
    XLSX.utils.book_append_sheet(wb, sheet('Gen. Journal Line', '81', jHead, jRows), 'Provisiones 3071 00');
    XLSX.writeFile(wb, `D-FORCE_${data.creditNo || 'Gutschrift'}.xlsx`);
  };

  if (selectedCompany !== DFORCE_COMPANY) {
    return (
      <div className="min-h-screen bg-[#F3F4F7] p-8">
        <p className="text-sm text-gray-600">D-FORCE solo está disponible para {DFORCE_COMPANY}. Selecciónala en el menú lateral.</p>
      </div>
    );
  }

  const net = data?.totals;
  const balanced = net && net.pdfNet != null && Math.abs(net.net - net.pdfNet) < 0.05;

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="max-w-[1800px] mx-auto px-4 md:px-8 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight text-lg">D-FORCE</p>
            <p className="text-xs text-gray-500">{DFORCE_COMPANY} · Gutschrift de D-FORCE-ONE (PDF + Excel) → Sales Invoice, Sales Credit Memo y Purchase Invoice</p>
          </div>
          <button onClick={exportExcel} disabled={!data}
            className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
            <Download size={16} /> Exportar Excel (Output Format)
          </button>
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto px-4 md:px-8 pt-6 space-y-6">
        <section className="bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap items-end gap-4">
          <FilePick label="PDF de la Gutschrift" accept=".pdf" icon={<FileText size={16} />} file={pdf} onChange={setPdf} />
          <FilePick label="Excel (Curasoft DatenExport)" accept=".xlsx,.xls" icon={<FileSpreadsheet size={16} />} file={excel} onChange={setExcel} />
          <button onClick={process} disabled={!pdf || !excel || loading}
            className="flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> {loading ? 'Procesando…' : 'Procesar'}
          </button>
          <div className="flex flex-wrap items-end gap-3 ml-auto">
            {([['invoice', 'Nº Sales Invoice'], ['credit', 'Nº Sales Credit Memo'], ['purchase', 'Nº Purchase Invoice']] as const).map(([k, label]) => (
              <label key={k} className="text-xs text-gray-500 flex flex-col gap-1">
                {label}
                <input value={docNo[k]} onChange={e => setDocNo(d => ({ ...d, [k]: e.target.value }))} placeholder="p. ej. SIN-00065"
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-semibold text-gray-900 w-40" />
              </label>
            ))}
          </div>
        </section>

        {error && <p className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-center gap-2"><AlertCircle size={16} /> {error}</p>}

        {data && (
          <>
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <Kpi label="Sales Invoice" value={money(data.totals.invoice)} sub={`${data.invoice.length} líneas`} />
              <Kpi label="Sales Credit Memo" value={money(data.totals.creditMemo)} sub={`Devoluciones ${money(data.totals.returns)} · contrapartidas NON-REC ${money(data.totals.nonRecReversals)}`} />
              <Kpi label="Purchase Invoice" value={money(data.totals.purchase)} sub={`${data.purchase.length} líneas · proveedor ${data.vendorNo}`} />
              <Kpi label="Neto (factura − devoluciones − compra)" value={money(data.totals.net)} sub={data.totals.pdfNet != null ? `Gutschrift: ${money(data.totals.pdfNet)}` : 'Sin Summe Netto en el PDF'} />
              <div className={`rounded-xl border p-4 flex items-center gap-2 text-sm ${balanced && !data.warnings.length ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-900'}`}>
                {balanced && !data.warnings.length ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                <div>
                  <p className="font-semibold">Gutschrift {data.creditNo}</p>
                  <p className="text-xs">{data.period}{balanced ? ' · cuadra con el PDF' : ' · revisa los avisos'}</p>
                </div>
              </div>
            </section>
            {data.warnings.length > 0 && (
              <ul className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 list-disc list-inside space-y-0.5">
                {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}

            <SalesTable title="Sales Invoice" docNo={docNo.invoice} lines={data.invoice} customer={data.customerNo} />
            <SalesTable title="Sales Credit Memo" docNo={docNo.credit} lines={data.credit} customer={data.customerNo} />
            <PurchaseTable docNo={docNo.purchase} lines={data.purchase} vendor={data.vendorNo} />
            <ProvisionsSection rows={provisions} journal={journal} costOverride={costOverride} setCostOverride={setCostOverride}
              postingDate={postingDate} setPostingDate={setPostingDate} creditNo={data.creditNo} />
          </>
        )}
      </main>
    </div>
  );
}

function ProvisionsSection({ rows, journal, costOverride, setCostOverride, postingDate, setPostingDate, creditNo }: {
  rows: ReturnType<typeof buildProvisions>; journal: ReturnType<typeof journalLines>;
  costOverride: Record<string, string>; setCostOverride: (f: (o: Record<string, string>) => Record<string, string>) => void;
  postingDate: string; setPostingDate: (d: string) => void; creditNo: string;
}) {
  const t = (f: (r: typeof rows[number]) => number) => rows.reduce((s, r) => s + f(r), 0);

  // Excel solo de provisiones: asientos (nº de asiento PROV./INV.PROV.<revista><MM>/<AA>) y resumen por número
  const exportProvisions = () => {
    const toDate = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return y ? new Date(Date.UTC(y, m - 1, dd)) : d; };
    const jHead = ['Posting Date', 'Document No.', 'Account Type', 'Account No.', 'Description', 'Amount', 'Bal. Account Type', 'Bal. Account No.'];
    const ws1 = XLSX.utils.aoa_to_sheet([jHead, ...journal.map(j => [toDate(j.postingDate), j.documentNo, 'G/L Account', j.accountNo, j.description, j.amount, 'G/L Account', j.balAccountNo])], { cellDates: true });
    const sHead = ['Nº asiento venta', 'Nº asiento existencias', 'Artículo', 'Uds vendidas', 'Venta', `Prov. menos venta (${PROVISION_RATE * 100}%)`, 'Coste unitario',
      `Prov. más existencias (${PROVISION_RATE * 100}%)`, 'Uds devueltas', 'Devolución', 'Cancelación venta', 'Cancelación existencias'];
    const ws2 = XLSX.utils.aoa_to_sheet([sHead, ...rows.map(r => [`PROV.${r.code}`, `INV.PROV.${r.code}`, r.item, r.soldQty, r2x(r.soldAmount), r.salesProvision, r.unitCost ?? '',
      r.inventoryProvision, r.returnedQty, r2x(r.returnedAmount), r.salesRelease, r.inventoryRelease])]);
    for (const [ws, numCols, from] of [[ws1, [5], 1], [ws2, [4, 5, 7, 9, 10, 11], 1]] as const) {
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      for (let r = from; r <= range.e.r; r++) {
        const d = ws[XLSX.utils.encode_cell({ r, c: 0 })];
        if (d && d.t === 'd') d.z = 'dd/mm/yyyy';
        for (const c of numCols) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && cell.t === 'n') cell.z = '#,##0.00'; }
      }
    }
    ws1['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 12 }, { wch: 11 }, { wch: 34 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    ws2['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 20 }, ...Array(9).fill({ wch: 16 })];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Asientos 3071 00');
    XLSX.utils.book_append_sheet(wb, ws2, 'Resumen por número');
    XLSX.writeFile(wb, `D-FORCE_Provisiones_${creditNo || 'Gutschrift'}_${postingDate}.xlsx`);
  };
  const created = t(r => r.salesProvision + r.inventoryProvision);
  const released = t(r => r.salesRelease + r.inventoryRelease);
  const missingCost = rows.filter(r => (r.delivered && r.soldQty) || r.returnedQty).filter(r => !r.unitCost);
  const pct = `${PROVISION_RATE * 100}%`;
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="mr-auto">
          <h2 className="text-sm font-bold text-gray-900">Provisiones de devoluciones ({ACC_PROVISION})</h2>
          <p className="text-xs text-gray-500">
            Factura: provisión de menos venta = {pct} del importe vendido (4300 00) y de más existencias = {pct} de las unidades × coste unitario (5881 00),
            solo en los números entregados en el mes. Abono: las devoluciones cancelan ambas provisiones al 100 %.
          </p>
        </div>
        <label className="text-xs text-gray-500 flex items-center gap-2">Fecha de registro
          <input type="date" value={postingDate} onChange={e => setPostingDate(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1 text-sm font-semibold text-gray-900" />
        </label>
        <button onClick={exportProvisions} disabled={!journal.length}
          className="flex items-center gap-2 border border-gray-300 bg-white text-gray-700 text-sm font-semibold px-3 py-1.5 rounded-lg hover:text-gray-900 disabled:opacity-40">
          <Download size={14} /> Exportar provisiones
        </button>
      </div>
      {missingCost.length > 0 && (
        <p className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900">
          Sin coste unitario (la provisión de existencias sale a 0 hasta que lo indiques): {missingCost.map(r => r.item).join(', ')}.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className={`${th} text-left`}>Nº asiento</th><th className={`${th} text-left`}>Artículo</th>
              <th className={`${th} text-right`}>Uds vendidas</th><th className={`${th} text-right`}>Venta</th>
              <th className={`${th} text-right`}>Prov. menos venta</th><th className={`${th} text-right`}>Coste unit.</th>
              <th className={`${th} text-right`}>Prov. más existencias</th>
              <th className={`${th} text-right`}>Uds devueltas</th><th className={`${th} text-right`}>Devolución</th>
              <th className={`${th} text-right`}>Cancel. venta</th><th className={`${th} text-right`}>Cancel. existencias</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.item} className="border-t border-gray-100 text-gray-900">
                <td className={`${td} font-mono text-xs`}><span className="font-semibold">PROV.{r.code}</span><br /><span className="text-gray-500">INV.PROV.{r.code}</span></td>
                <td className={`${td} font-mono text-xs`}>{r.item}</td>
                <td className={`${td} text-right tabular-nums`}>{r.soldQty ? qf.format(r.soldQty) : ''}</td>
                <td className={`${td} text-right tabular-nums`}>{r.soldAmount ? money(r.soldAmount) : ''}</td>
                <td className={`${td} text-right tabular-nums font-semibold`} title={!r.delivered && r.soldQty ? 'Solo diferencias de entrega: sin provisión' : ''}>
                  {r.salesProvision ? money(r.salesProvision) : r.soldQty ? <span className="text-gray-400 text-xs">sin prov.</span> : ''}
                </td>
                <td className={`${td} text-right`}>
                  <input value={costOverride[r.item] ?? (r.unitCost == null ? '' : String(r.unitCost).replace('.', ','))}
                    onChange={e => setCostOverride(o => ({ ...o, [r.item]: e.target.value }))} inputMode="decimal"
                    className={`w-20 border rounded px-1.5 py-0.5 text-right text-sm tabular-nums ${r.unitCost ? 'border-gray-300' : 'border-amber-400 bg-amber-50'}`} />
                </td>
                <td className={`${td} text-right tabular-nums font-semibold`}>{r.inventoryProvision ? money(r.inventoryProvision) : ''}</td>
                <td className={`${td} text-right tabular-nums`}>{r.returnedQty ? qf.format(r.returnedQty) : ''}</td>
                <td className={`${td} text-right tabular-nums`}>{r.returnedAmount ? money(r.returnedAmount) : ''}</td>
                <td className={`${td} text-right tabular-nums text-red-700`}>{r.salesRelease ? money(r.salesRelease) : ''}</td>
                <td className={`${td} text-right tabular-nums text-red-700`}>{r.inventoryRelease ? money(r.inventoryRelease) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-50 font-bold text-gray-900">
            <tr className="border-t-2 border-gray-300">
              <td className={td} colSpan={3}>Total</td>
              <td className={`${td} text-right tabular-nums`}>{money(t(r => r.soldAmount))}</td>
              <td className={`${td} text-right tabular-nums`}>{money(t(r => r.salesProvision))}</td>
              <td />
              <td className={`${td} text-right tabular-nums`}>{money(t(r => r.inventoryProvision))}</td>
              <td />
              <td className={`${td} text-right tabular-nums`}>{money(t(r => r.returnedAmount))}</td>
              <td className={`${td} text-right tabular-nums`}>{money(t(r => r.salesRelease))}</td>
              <td className={`${td} text-right tabular-nums`}>{money(t(r => r.inventoryRelease))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="px-4 py-3 border-t border-gray-200 space-y-2">
        <p className="text-xs text-gray-600">
          Provisiones nuevas {money(created)} · cancelaciones {money(released)} · movimiento neto contra {ACC_PROVISION}: <b>{money(-(created + released))}</b>
        </p>
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-gray-900">Asientos sugeridos ({journal.length} líneas de diario, contrapartida {ACC_PROVISION})</summary>
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className={`${th} text-left`}>Fecha</th><th className={`${th} text-left`}>Nº documento</th><th className={`${th} text-left`}>Cuenta</th>
                  <th className={`${th} text-left`}>Descripción</th><th className={`${th} text-right`}>Importe</th><th className={`${th} text-left`}>Contrapartida</th>
                </tr>
              </thead>
              <tbody>
                {journal.map((j, i) => (
                  <tr key={i} className="border-t border-gray-100 text-gray-900">
                    <td className={td}>{j.postingDate.split('-').reverse().join('/')}</td>
                    <td className={`${td} font-mono text-xs`}>{j.documentNo}</td>
                    <td className={`${td} font-mono text-xs`}>{j.accountNo}</td>
                    <td className={td}>{j.description}</td>
                    <td className={`${td} text-right tabular-nums ${j.amount < 0 ? 'text-red-700' : ''}`}>{money(j.amount)}</td>
                    <td className={`${td} font-mono text-xs`}>{j.balAccountNo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  );
}

const r2x = (v: number) => Math.round(v * 100) / 100;

function FilePick({ label, accept, icon, file, onChange }: { label: string; accept: string; icon: ReactNode; file: File | null; onChange: (f: File | null) => void }) {
  return (
    <label className="text-xs text-gray-500 flex flex-col gap-1 cursor-pointer">
      {label}
      <span className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 bg-gray-50 hover:bg-gray-100 min-w-[260px]">
        {icon} {file ? file.name : 'Elegir fichero…'}
      </span>
      <input type="file" accept={accept} className="hidden" onChange={e => onChange(e.target.files?.[0] || null)} />
    </label>
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

const th = 'px-3 py-2 whitespace-nowrap';
const td = 'px-3 py-1.5 whitespace-nowrap';

function SalesTable({ title, docNo, lines, customer }: { title: string; docNo: string; lines: SalesLine[]; customer: string }) {
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-sm font-bold text-gray-900">{title}</h2>
        <span className="text-xs text-gray-500">{docNo || 'sin nº de documento'} · cliente {customer} · {lines.length} líneas</span>
      </div>
      <div className="overflow-x-auto max-h-[60vh]">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500 sticky top-0">
            <tr>
              <th className={`${th} text-right`}>Line No.</th><th className={`${th} text-left`}>No.</th><th className={`${th} text-left`}>Description</th>
              <th className={`${th} text-left`}>Description 2</th><th className={`${th} text-right`}>Quantity</th><th className={`${th} text-right`}>Unit Price</th>
              <th className={`${th} text-right`}>Unit Cost (LCY)</th><th className={`${th} text-right`}>Amount</th><th className={`${th} text-left`}>Return Reason</th>
              <th className={`${th} text-left`}>Project No.</th><th className={`${th} text-left`}>Project Task No.</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.lineNo} className={`border-t border-gray-100 ${l.quantity < 0 ? 'text-red-700' : 'text-gray-900'}`}>
                <td className={`${td} text-right tabular-nums text-gray-500`}>{l.lineNo}</td>
                <td className={`${td} font-mono text-xs`}>{l.no}</td>
                <td className={`${td} text-gray-600`}>{l.description || '—'}</td>
                <td className={td}>{l.description2}</td>
                <td className={`${td} text-right tabular-nums`}>{qf.format(l.quantity)}</td>
                <td className={`${td} text-right tabular-nums`}>{pf.format(l.unitPrice)}</td>
                <td className={`${td} text-right tabular-nums text-gray-600`}>{l.unitCost == null ? '—' : pf.format(l.unitCost)}</td>
                <td className={`${td} text-right tabular-nums font-semibold`}>{money(l.amount)}</td>
                <td className={td}>{l.returnReason}</td>
                <td className={`${td} font-mono text-xs`}>{l.project}</td>
                <td className={`${td} font-mono text-xs`}>{l.task}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-50 font-bold text-gray-900 sticky bottom-0">
            <tr className="border-t-2 border-gray-300">
              <td className={td} colSpan={4}>Total</td>
              <td className={`${td} text-right tabular-nums`}>{qf.format(lines.reduce((s, l) => s + l.quantity, 0))}</td>
              <td colSpan={2} />
              <td className={`${td} text-right tabular-nums`}>{money(lines.reduce((s, l) => s + l.amount, 0))}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function PurchaseTable({ docNo, lines, vendor }: { docNo: string; lines: PurchaseLine[]; vendor: string }) {
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-sm font-bold text-gray-900">Purchase Invoice</h2>
        <span className="text-xs text-gray-500">{docNo || 'sin nº de documento'} · proveedor {vendor} · {lines.length} líneas</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className={`${th} text-right`}>Line No.</th><th className={`${th} text-left`}>No.</th><th className={`${th} text-left`}>Description</th>
              <th className={`${th} text-left`}>Description 2</th><th className={`${th} text-right`}>Quantity</th><th className={`${th} text-right`}>Direct Unit Cost</th>
              <th className={`${th} text-right`}>Line Amount</th><th className={`${th} text-left`}>Project No.</th><th className={`${th} text-left`}>Project Task No.</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.lineNo} className="border-t border-gray-100 text-gray-900">
                <td className={`${td} text-right tabular-nums text-gray-500`}>{l.lineNo}</td>
                <td className={`${td} font-mono text-xs`}>{l.no}</td>
                <td className={td}>{l.description}</td>
                <td className={td}>{l.description2}</td>
                <td className={`${td} text-right tabular-nums`}>{l.quantity}</td>
                <td className={`${td} text-right tabular-nums`}>{money(l.directUnitCost)}</td>
                <td className={`${td} text-right tabular-nums font-semibold`}>{money(l.lineAmount)}</td>
                <td className={`${td} font-mono text-xs`}>{l.project}</td>
                <td className={`${td} font-mono text-xs`}>{l.task}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-50 font-bold text-gray-900">
            <tr className="border-t-2 border-gray-300">
              <td className={td} colSpan={6}>Total</td>
              <td className={`${td} text-right tabular-nums`}>{money(lines.reduce((s, l) => s + l.lineAmount, 0))}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
