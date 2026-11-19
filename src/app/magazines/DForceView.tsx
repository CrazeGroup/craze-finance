'use client';

import { useMemo, useState, type ReactNode } from 'react';
import * as XLSX from 'xlsx';
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, FileText, RefreshCw, Send } from 'lucide-react';
import { ACC_PROVISION, buildProvisions, journalLines, PROVISION_RATE } from '@/lib/dforceProvisions';
import { useT } from '@/contexts/LanguageContext';

type SalesLine = {
  documentType: 'Invoice' | 'Credit Memo'; lineNo: number; no: string; description: string; description2: string;
  quantity: number; unitPrice: number; unitCost: number | null; amount: number; returnReason: string; project: string; task: string;
  task2: string; appendix: string;
};
type PurchaseLine = {
  lineNo: number; no: string; description: string; description2: string; quantity: number; directUnitCost: number;
  project: string; task: string; lineAmount: number;
};
type Result = {
  creditNo: string; period: string; invoice: SalesLine[]; credit: SalesLine[]; purchase: PurchaseLine[]; warnings: string[];
  totals: { invoice: number; returns: number; creditMemo: number; purchase: number; net: number; pdfNet: number | null };
  customerNo: string; vendorNo: string; location: string; files: { pdf: string; excel: string };
};

type Kind = 'invoice' | 'credit' | 'purchase' | 'journal';
type SendState = { saving?: boolean; no?: string; lines?: number; warnings?: string[]; error?: string | null };

const KIND_LABEL: Record<Kind, string> = { invoice: 'Sales Invoice', credit: 'Sales Credit Memo', purchase: 'Purchase Invoice', journal: 'Provisions (D-FORCE journal)' };
// Formatos de número en el idioma de la app (locale de useT)
const fmts = (locale: string) => {
  const nf = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pf = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 5 });
  const qf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return { pf, qf, money: (v: number | null | undefined) => (v == null ? '' : nf.format(v)) };
};

const SALES_HEAD = ['Document Type', 'Document No.', 'Line No.', 'Sell-to Customer No.', 'Type', 'No.', 'Location Code', 'Description', 'Description 2', 'Quantity', 'Unit Price', 'Unit Cost (LCY)', 'Amount', 'VAT Prod. Posting Group', 'Return Reason Code', 'Project No.', 'Project Task No.', 'Project Task No.2'];
const PURCHASE_HEAD = ['Document Type', 'Document No.', 'Line No.', 'Buy-from Vendor No.', 'Type', 'No.', 'Location Code', 'Description', 'Description 2', 'Quantity', 'Direct Unit Cost', 'Project No.', 'VAT Prod. Posting Group', 'Line Amount', 'Project Task No.'];

// MAGAZINES › D-FORCE: Gutschrift mensual de D-FORCE-ONE → documentos de BC y provisiones de devoluciones
export default function DForceView() {
  const { t, tx, locale } = useT();
  const { money } = fmts(locale);
  const [pdf, setPdf] = useState<File | null>(null);
  const [excel, setExcel] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Result | null>(null);
  // Envío a BC de cada documento (nº que da BC, avisos o error)
  const [sent, setSent] = useState<Partial<Record<Kind, SendState>>>({});
  const docNo = { invoice: sent.invoice?.no || '', credit: sent.credit?.no || '', purchase: sent.purchase?.no || '' };
  // Coste unitario por artículo para las provisiones (de BC, editable) y fecha de registro de documentos y diario
  // (fin del periodo de la Gutschrift)
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
      if (!res.ok) throw new Error(json.error || t('Error processing ({status})', { status: res.status }));
      setData(json);
      setSent({});
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

  // Crea en BC (sin registrar) un documento, o envía las provisiones al lote D-FORCE, con el PDF y el Excel adjuntos.
  // Si ya existe con ese nº de Gutschrift, pregunta antes de crearlo de nuevo.
  const send = async (kind: Kind) => {
    if (!data || !pdf || !excel) return;
    if (!postingDate) { setSent(s => ({ ...s, [kind]: { error: t('Enter the posting date.') } })); return; }
    const lines = kind === 'invoice' ? data.invoice : kind === 'credit' ? data.credit : kind === 'purchase' ? data.purchase : journal;
    if (kind === 'journal' && missingCost.length && !confirm(t('No unit cost (inventory provision at 0): {items}. Send the journal anyway?', { items: missingCost.join(', ') }))) return;
    setSent(s => ({ ...s, [kind]: { ...s[kind], saving: true, error: null } }));
    const post = async (force: boolean) => {
      const form = new FormData();
      form.append('data', JSON.stringify({ kind, ref: data.creditNo, date: postingDate, lines, force }));
      form.append('pdf', pdf);
      form.append('excel', excel);
      const res = await fetch('/api/dforce/create', { method: 'POST', body: form });
      return { res, json: await res.json().catch(() => ({ error: `Error ${res.status}` })) };
    };
    try {
      let { res, json } = await post(false);
      if (res.status === 409) {
        if (!confirm(t('{error}. Create {doc} again?', { error: tx(json.error), doc: t(KIND_LABEL[kind]) }))) { setSent(s => ({ ...s, [kind]: { error: json.error } })); return; }
        ({ res, json } = await post(true));
      }
      if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
      setSent(s => ({ ...s, [kind]: { no: json.no, lines: json.lines, warnings: json.warnings || [] } }));
    } catch (e: any) {
      setSent(s => ({ ...s, [kind]: { error: e.message } }));
    }
  };
  const kinds = (['invoice', 'credit', 'purchase', 'journal'] as Kind[]).filter(k =>
    k === 'journal' ? journal.length > 0 : (k === 'invoice' ? data?.invoice : k === 'credit' ? data?.credit : data?.purchase)?.length);
  const sendAll = async () => { for (const k of kinds.filter(k => !sent[k]?.no)) await send(k); };
  const sending = Object.values(sent).some(x => x?.saving);
  const missingCost = provisions.filter(r => (r.delivered && r.soldQty) || r.returnedQty).filter(r => !r.unitCost).map(r => r.item);
  const action = (kind: Kind) => <BcSend state={sent[kind]} onSend={() => send(kind)} disabled={sending || !postingDate} />;

  // Excel con el formato de los paquetes de configuración "D-FORCE" (Sales Line 37 y Purchase Line 39)
  const exportExcel = () => {
    if (!data) return;
    const salesRow = (l: SalesLine) => [
      l.documentType, l.documentType === 'Invoice' ? docNo.invoice : docNo.credit, l.lineNo, data.customerNo, 'Item', l.no, data.location,
      l.description, l.description2, l.quantity, l.unitPrice, l.unitCost ?? '', l.amount, '7% GOODS', l.returnReason, l.project, l.task, l.task2,
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
    XLSX.utils.book_append_sheet(wb, sheet('Gen. Journal Line', '81', jHead, jRows), t('Provisions 3071 00'));
    XLSX.writeFile(wb, `D-FORCE_${data.creditNo || 'Gutschrift'}.xlsx`);
  };

  const net = data?.totals;
  const balanced = net && net.pdfNet != null && Math.abs(net.net - net.pdfNet) < 0.05;

  return (
    <div className="space-y-6">
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto">
            <p className="font-bold text-gray-900 leading-tight">D-FORCE</p>
            <p className="text-xs text-gray-500">{t('D-FORCE-ONE Gutschrift (PDF + Excel) → unposted Sales Invoice, Sales Credit Memo and Purchase Invoice in BC (with the PDF and the Excel attached) and provisions to the D-FORCE journal')}</p>
          </div>
          <button onClick={sendAll} disabled={!data || sending || !postingDate || kinds.every(k => sent[k]?.no)}
            title={postingDate ? t('Creates in BC, unposted, the documents not sent yet and the provisions') : t('Enter the posting date')}
            className="flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
            <Send size={16} className={sending ? 'animate-pulse' : ''} /> {sending ? t('Sending to BC…') : t('Send all to BC')}
          </button>
          <button onClick={exportExcel} disabled={!data}
            className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
            <Download size={16} /> {t('Export Excel (Output Format)')}
          </button>
        </div>

        <section className="bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap items-end gap-4">
          <FilePick label={t('Gutschrift PDF')} accept=".pdf" icon={<FileText size={16} />} file={pdf} onChange={setPdf} />
          <FilePick label="Excel (Curasoft DatenExport)" accept=".xlsx,.xls" icon={<FileSpreadsheet size={16} />} file={excel} onChange={setExcel} />
          <button onClick={process} disabled={!pdf || !excel || loading}
            className="flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> {loading ? t('Processing…') : t('Process')}
          </button>
          <label className="text-xs text-gray-500 flex flex-col gap-1 ml-auto" title={t('Posting and document date of the invoices, the credit memo and the journal')}>
            {t('Document posting date')}
            <input type="date" value={postingDate} onChange={e => setPostingDate(e.target.value)}
              className={`border rounded-lg px-2 py-1.5 text-sm font-semibold text-gray-900 ${data && !postingDate ? 'border-amber-400 bg-amber-50' : 'border-gray-300'}`} />
          </label>
        </section>

        {error && <p className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-center gap-2"><AlertCircle size={16} /> {tx(error)}</p>}

        {data && (
          <>
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <Kpi label="Sales Invoice" value={money(data.totals.invoice)} sub={t('{n} lines', { n: data.invoice.length })} />
              <Kpi label="Sales Credit Memo" value={money(data.totals.creditMemo)} sub={t('{n} lines · {nonrec} NON-REC (BC generates their counterparts)', { n: data.credit.length, nonrec: data.credit.filter(l => l.returnReason).length })} />
              <Kpi label="Purchase Invoice" value={money(data.totals.purchase)} sub={t('{n} lines · vendor {vendor}', { n: data.purchase.length, vendor: data.vendorNo })} />
              <Kpi label={t('Net (invoice − returns − purchase)')} value={money(data.totals.net)} sub={data.totals.pdfNet != null ? `Gutschrift: ${money(data.totals.pdfNet)}` : t('No Summe Netto in the PDF')} />
              <div className={`rounded-xl border p-4 flex items-center gap-2 text-sm ${balanced && !data.warnings.length ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-900'}`}>
                {balanced && !data.warnings.length ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                <div>
                  <p className="font-semibold">Gutschrift {data.creditNo}</p>
                  <p className="text-xs">{data.period} · {balanced ? t('matches the PDF') : t('check the warnings')}</p>
                </div>
              </div>
            </section>
            {data.warnings.length > 0 && (
              <ul className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 list-disc list-inside space-y-0.5">
                {data.warnings.map((w, i) => <li key={i}>{tx(w)}</li>)}
              </ul>
            )}

            <SalesTable title="Sales Invoice" docNo={docNo.invoice} lines={data.invoice} customer={data.customerNo} action={action('invoice')} />
            <SalesTable title="Sales Credit Memo" docNo={docNo.credit} lines={data.credit} customer={data.customerNo} action={action('credit')} />
            <PurchaseTable docNo={docNo.purchase} lines={data.purchase} vendor={data.vendorNo} action={action('purchase')} />
            <ProvisionsSection rows={provisions} journal={journal} costOverride={costOverride} setCostOverride={setCostOverride}
              postingDate={postingDate} creditNo={data.creditNo} missingCost={missingCost} action={action('journal')} />
          </>
        )}
    </div>
  );
}

function ProvisionsSection({ rows, journal, costOverride, setCostOverride, postingDate, creditNo, missingCost, action }: {
  rows: ReturnType<typeof buildProvisions>; journal: ReturnType<typeof journalLines>;
  costOverride: Record<string, string>; setCostOverride: (f: (o: Record<string, string>) => Record<string, string>) => void;
  postingDate: string; creditNo: string; missingCost: string[]; action: ReactNode;
}) {
  const { t, locale } = useT();
  const { qf, money } = fmts(locale);
  const sum = (f: (r: typeof rows[number]) => number) => rows.reduce((s, r) => s + f(r), 0);

  // Excel solo de provisiones: asientos (nº de asiento PROV./INV.PROV.<revista><MM>/<AA>) y resumen por número
  const exportProvisions = () => {
    const toDate = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return y ? new Date(Date.UTC(y, m - 1, dd)) : d; };
    const jHead = ['Posting Date', 'Document No.', 'Account Type', 'Account No.', 'Description', 'Amount', 'Bal. Account Type', 'Bal. Account No.'];
    const ws1 = XLSX.utils.aoa_to_sheet([jHead, ...journal.map(j => [toDate(j.postingDate), j.documentNo, 'G/L Account', j.accountNo, j.description, j.amount, 'G/L Account', j.balAccountNo])], { cellDates: true });
    const sHead = [t('Sales entry no.'), t('Inventory entry no.'), t('Item'), t('Units sold'), t('Sold'), t('Prov. lower sales ({pct}%)', { pct: PROVISION_RATE * 100 }), t('Cost per unit'),
      t('Prov. higher inventory ({pct}%)', { pct: PROVISION_RATE * 100 }), t('Units returned'), t('Returned amount'), t('Sales release'), t('Inventory release')];
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
    XLSX.utils.book_append_sheet(wb, ws1, t('Entries 3071 00'));
    XLSX.utils.book_append_sheet(wb, ws2, t('Summary by issue'));
    XLSX.writeFile(wb, `D-FORCE_${t('Provisions')}_${creditNo || 'Gutschrift'}_${postingDate}.xlsx`);
  };
  // Movimiento de la 3071 00 = contrapartida de todas las líneas de diario
  const provisionNet = -journal.reduce((s, j) => s + j.amount, 0);
  const pct = `${PROVISION_RATE * 100}%`;
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="mr-auto">
          <h2 className="text-sm font-bold text-gray-900">{t('Return provisions ({account})', { account: ACC_PROVISION })}</h2>
          <p className="text-xs text-gray-500">
            {t('Invoice: lower-sales provision = {pct} of the amount sold (4300 00) and higher-inventory provision = {pct} of the units × unit cost (5881 00), only for the issues delivered in the month. Credit memo: the returns release both provisions at 100 %.', { pct })}
          </p>
        </div>
        <button onClick={exportProvisions} disabled={!journal.length}
          className="flex items-center gap-2 border border-gray-300 bg-white text-gray-700 text-sm font-semibold px-3 py-1.5 rounded-lg hover:text-gray-900 disabled:opacity-40">
          <Download size={14} /> {t('Export provisions')}
        </button>
        {action}
      </div>
      {missingCost.length > 0 && (
        <p className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900">
          {t('No unit cost (the inventory provision is 0 until you enter it): {items}.', { items: missingCost.join(', ') })}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className={`${th} text-left`}>{t('Entry no.')}</th><th className={`${th} text-left`}>{t('Item')}</th>
              <th className={`${th} text-right`}>{t('Units sold')}</th><th className={`${th} text-right`}>{t('Sold')}</th>
              <th className={`${th} text-right`}>{t('Prov. lower sales')}</th><th className={`${th} text-right`}>{t('Cost per unit')}</th>
              <th className={`${th} text-right`}>{t('Prov. higher inventory')}</th>
              <th className={`${th} text-right`}>{t('Units returned')}</th><th className={`${th} text-right`}>{t('Returned amount')}</th>
              <th className={`${th} text-right`}>{t('Release sales')}</th><th className={`${th} text-right`}>{t('Release inventory')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.item} className="border-t border-gray-100 text-gray-900">
                <td className={`${td} font-mono text-xs`}><span className="font-semibold">PROV.{r.code}</span><br /><span className="text-gray-500">INV.PROV.{r.code}</span></td>
                <td className={`${td} font-mono text-xs`}>{r.item}</td>
                <td className={`${td} text-right tabular-nums`}>{r.soldQty ? qf.format(r.soldQty) : ''}</td>
                <td className={`${td} text-right tabular-nums`}>{r.soldAmount ? money(r.soldAmount) : ''}</td>
                <td className={`${td} text-right tabular-nums font-semibold`} title={!r.delivered && r.soldQty ? t('Delivery differences only: no provision') : ''}>
                  {r.salesProvision ? money(r.salesProvision) : r.soldQty ? <span className="text-gray-400 text-xs">{t('no prov.')}</span> : ''}
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
              <td className={`${td} text-right tabular-nums`}>{money(sum(r => r.soldAmount))}</td>
              <td className={`${td} text-right tabular-nums`}>{money(sum(r => r.salesProvision))}</td>
              <td />
              <td className={`${td} text-right tabular-nums`}>{money(sum(r => r.inventoryProvision))}</td>
              <td />
              <td className={`${td} text-right tabular-nums`}>{money(sum(r => r.returnedAmount))}</td>
              <td className={`${td} text-right tabular-nums`}>{money(sum(r => r.salesRelease))}</td>
              <td className={`${td} text-right tabular-nums`}>{money(sum(r => r.inventoryRelease))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="px-4 py-3 border-t border-gray-200 space-y-2">
        <p className="text-xs text-gray-600">
          {t('Sales (4300 00): provision {sp} · release {sr} — Inventory (5881 00): provision {ip} · release {ir} — net movement on {account}:', { sp: money(sum(r => r.salesProvision)), sr: money(sum(r => r.salesRelease)), ip: money(-sum(r => r.inventoryProvision)), ir: money(-sum(r => r.inventoryRelease)), account: ACC_PROVISION })} <b>{money(provisionNet)}</b>
        </p>
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-gray-900">{t('Suggested entries ({n} journal lines, balancing account {account})', { n: journal.length, account: ACC_PROVISION })}</summary>
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className={`${th} text-left`}>{t('Date')}</th><th className={`${th} text-left`}>{t('Document no.')}</th><th className={`${th} text-left`}>{t('Account')}</th>
                  <th className={`${th} text-left`}>{t('Description')}</th><th className={`${th} text-right`}>{t('Amount')}</th><th className={`${th} text-left`}>{t('Balancing account')}</th>
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

// Botón "Crear en BC" de un bloque con el resultado: nº creado (sin registrar), avisos o error
function BcSend({ state, onSend, disabled }: { state?: SendState; onSend: () => void; disabled: boolean }) {
  const { t, tx } = useT();
  return (
    <>
      {state?.no ? (
        <span className="flex items-center gap-1.5 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg px-2 py-1">
          <CheckCircle2 size={14} /> {t('{no} created in BC unposted ({n} lines): review and post it', { no: state.no, n: state.lines })}
        </span>
      ) : (
        <button onClick={onSend} disabled={disabled || state?.saving}
          className="flex items-center gap-1.5 bg-indigo-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
          <Send size={13} className={state?.saving ? 'animate-pulse' : ''} /> {state?.saving ? t('Creating in BC…') : t('Create in BC')}
        </button>
      )}
      {state?.error && <p className="w-full text-xs text-red-700 flex items-center gap-1.5 mt-1"><AlertCircle size={13} /> {tx(state.error)}</p>}
      {!!state?.warnings?.length && (
        <ul className="w-full mt-1 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-xs text-amber-900 list-disc list-inside space-y-0.5">
          {state.warnings.map((w, i) => <li key={i}>{tx(w)}</li>)}
        </ul>
      )}
    </>
  );
}

function FilePick({ label, accept, icon, file, onChange }: { label: string; accept: string; icon: ReactNode; file: File | null; onChange: (f: File | null) => void }) {
  const { t } = useT();
  return (
    <label className="text-xs text-gray-500 flex flex-col gap-1 cursor-pointer">
      {label}
      <span className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 bg-gray-50 hover:bg-gray-100 min-w-[260px]">
        {icon} {file ? file.name : t('Choose file…')}
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

function SalesTable({ title, docNo, lines, customer, action }: { title: string; docNo: string; lines: SalesLine[]; customer: string; action: ReactNode }) {
  const { t, locale } = useT();
  const { pf, qf, money } = fmts(locale);
  const showTask2 = lines.some(l => l.documentType === 'Credit Memo');
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-bold text-gray-900">{title}</h2>
        <span className="text-xs text-gray-500 mr-auto">{docNo || t('not created in BC')} · {t('customer {no}', { no: customer })} · {t('{n} lines', { n: lines.length })}</span>
        {action}
      </div>
      <div className="overflow-x-auto max-h-[60vh]">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500 sticky top-0">
            <tr>
              <th className={`${th} text-right`}>Line No.</th><th className={`${th} text-left`}>No.</th><th className={`${th} text-left`}>Description</th>
              <th className={`${th} text-left`}>Description 2</th><th className={`${th} text-right`}>Quantity</th><th className={`${th} text-right`}>Unit Price</th>
              <th className={`${th} text-right`}>Unit Cost (LCY)</th><th className={`${th} text-right`}>Amount</th><th className={`${th} text-left`}>Return Reason</th>
              <th className={`${th} text-left`}>Project No.</th><th className={`${th} text-left`}>Project Task No.</th>
              {showTask2 && <th className={`${th} text-left`}>Project Task No.2</th>}
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
                {showTask2 && <td className={`${td} font-mono text-xs`}>{l.task2}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-50 font-bold text-gray-900 sticky bottom-0">
            <tr className="border-t-2 border-gray-300">
              <td className={td} colSpan={4}>Total</td>
              <td className={`${td} text-right tabular-nums`}>{qf.format(lines.reduce((s, l) => s + l.quantity, 0))}</td>
              <td colSpan={2} />
              <td className={`${td} text-right tabular-nums`}>{money(lines.reduce((s, l) => s + l.amount, 0))}</td>
              <td colSpan={showTask2 ? 4 : 3} />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function PurchaseTable({ docNo, lines, vendor, action }: { docNo: string; lines: PurchaseLine[]; vendor: string; action: ReactNode }) {
  const { t, locale } = useT();
  const { money } = fmts(locale);
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-bold text-gray-900">Purchase Invoice</h2>
        <span className="text-xs text-gray-500 mr-auto">{docNo || t('not created in BC')} · {t('vendor {no}', { no: vendor })} · {t('{n} lines', { n: lines.length })}</span>
        {action}
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
