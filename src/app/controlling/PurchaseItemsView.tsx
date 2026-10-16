'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';

// Controlling · Compras por artículo (facturas y abonos de compra registrados): artículo → proveedores → documentos.
type GlAcc = { no: string; name: string; amount: number };
type Doc = {
  kind: 'Factura' | 'Abono'; documentNo: string; lineNo: number; documentDate: string; postingDate: string; vatDate: string;
  vendorDocNo: string; currency: string; quantity: number; directUnitCost: number; amount: number;
  vatProdPostingGroup: string; deferralCode: string; genProdPostingGroup: string; glAccounts: GlAcc[];
};
type Vendor = {
  vendorNo: string; name: string; country: string; paymentMethod: string; paymentTerms: string; genBusPostingGroup: string;
  currentPurchAccount: string; currentCrMemoAccount: string; net: number; quantity: number; invoices: number; creditMemos: number; docs: Doc[];
};
type Item = { itemNo: string; description: string; genProdPostingGroup: string; setup: { bus: string; purch: string; crMemo: string }[]; net: number; quantity: number; vendors: Vendor[] };
type Data = { items: Item[]; excludedZero: number; excludedEqual: number; warnings: string[]; counts: { invoiceLines: number; creditMemoLines: number; glEntries: number } };

const iso = (d: Date) => d.toISOString().substring(0, 10);
const PAGE = 100;
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 font-mono whitespace-nowrap';
const td = 'py-1.5 px-2 whitespace-nowrap';

// Cuentas de la configuración actual: una sola o "cuenta (grupo negocio)" si varían por grupo
function setupAccounts(setup: Item['setup'], k: 'purch' | 'crMemo') {
  const distinct = Array.from(new Set(setup.map(s => s[k]).filter(Boolean)));
  if (distinct.length <= 1) return distinct[0] || '–';
  return setup.filter(s => s[k]).map(s => `${s[k]} (${s.bus || 'sin grupo'})`).join(' · ');
}

export default function PurchaseItemsView({ fmt, company }: { fmt: Fmt; company: string }) {
  const { num, date } = fmt;
  const [from, setFrom] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(() => iso(new Date()));
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    if (!from || !to || from > to) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetch(`/api/controlling/purchase-items?from=${from}&to=${to}${reload.force ? '&force=1' : ''}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (cancelled) return;
        setState(res.ok && !data.error ? { data, loading: false, error: null } : { data: null, loading: false, error: data.error || `HTTP ${res.status}` });
      })
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [from, to, reload, company]);

  const items = useMemo(() => {
    const all = state.data?.items || [];
    const s = search.trim().toLowerCase();
    if (!s) return all;
    return all.filter(i => i.itemNo.toLowerCase().includes(s) || i.description.toLowerCase().includes(s)
      || i.vendors.some(v => v.vendorNo.toLowerCase().includes(s) || v.name.toLowerCase().includes(s)));
  }, [state.data, search]);

  // Excel: hoja de artículos y hoja con una fila por línea de factura/abono (artículos filtrados por el buscador)
  const exportExcel = () => {
    const itemRows = items.map(i => ({
      'No.': i.itemNo, 'Description': i.description, 'Gen. Prod. Posting Group': i.genProdPostingGroup,
      'Purch. Account': setupAccounts(i.setup, 'purch'), 'Purch. Credit Memo Account': setupAccounts(i.setup, 'crMemo'),
      'Proveedores': i.vendors.length, 'Cantidad': i.quantity, 'Neto': i.net,
    }));
    const lineRows = items.flatMap(i => i.vendors.flatMap(v => v.docs.map(doc => ({
      'Item No.': i.itemNo, 'Item Description': i.description, 'Gen. Prod. Posting Group': i.genProdPostingGroup,
      'Vendor No.': v.vendorNo, 'Vendor Name': v.name, 'Country/Region Code': v.country, 'Payment Method Code': v.paymentMethod,
      'Payment Terms Code': v.paymentTerms, 'Gen. Bus. Posting Group': v.genBusPostingGroup,
      'Cuenta actual': doc.kind === 'Abono' ? v.currentCrMemoAccount : v.currentPurchAccount,
      'Tipo': doc.kind, 'Document No.': doc.documentNo, 'Document Date': doc.documentDate, 'Posting Date': doc.postingDate,
      'VAT Date': doc.vatDate, 'Vendor Invoice No.': doc.vendorDocNo, 'Quantity': doc.quantity,
      'Direct Unit Cost Excl. VAT': doc.directUnitCost, 'Importe': doc.amount, 'Currency Code': doc.currency,
      'VAT Prod. Posting Group': doc.vatProdPostingGroup, 'Deferral Code': doc.deferralCode,
      'Cuenta G/L registrada': doc.glAccounts.map(a => a.no).join(', '), 'Nombre cuenta G/L': doc.glAccounts.map(a => a.name).join(', '),
    }))));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemRows), 'Artículos');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lineRows), 'Facturas y abonos');
    XLSX.writeFile(wb, `Compras_por_articulo_${company}_${from}_${to}.xlsx`.replace(/\s+/g, '_'));
  };

  const money = (v: number, cur = '') => `${num(v, 2)}${cur ? ` ${cur}` : ''}`;
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const d = state.data;

  return (
    <Section title="Compras por artículo" source="Facturas (122/123) y abonos (124/125) de compra registrados · configuración contable actual (252) · cuenta histórica de G/L Entries (17)">
      <div className="flex flex-wrap items-end gap-4">
        {([['Desde', from, setFrom], ['Hasta', to, setTo]] as const).map(([label, value, set]) => (
          <label key={label} className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {label}
            <input type="date" value={value} onChange={e => { set(e.target.value); setShown(PAGE); }}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal" />
          </label>
        ))}
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 flex-1 min-w-[220px]">
          Buscar
          <span className="mt-1 flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-1.5 bg-white">
            <Search size={14} className="text-gray-400" />
            <input value={search} onChange={e => { setSearch(e.target.value); setShown(PAGE); }} placeholder="Artículo, descripción o proveedor"
              className="w-full text-sm text-gray-900 outline-none normal-case tracking-normal font-normal" />
          </span>
        </label>
        <button onClick={exportExcel} disabled={state.loading || !items.length}
          className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
          <FileDown size={16} /> Exportar Excel
        </button>
        <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={state.loading} title="Volver a leer de BC"
          className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
          <RefreshCw size={16} className={state.loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {from > to ? <ErrorBox message="La fecha Desde es posterior a Hasta." />
        : state.error ? <ErrorBox message={state.error} />
        : state.loading || !d ? <Loading text="Leyendo facturas y abonos de compra de Business Central…" />
        : (
          <>
            {d.warnings.map(w => <p key={w} className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{w}</p>)}
            <Grid cols={4}>
              <Kpi label="Artículos" value={num(d.items.length)} sub={`${num(d.items.reduce((s, i) => s + i.vendors.length, 0))} pares artículo/proveedor`} />
              <Kpi label="Líneas" value={num(d.counts.invoiceLines + d.counts.creditMemoLines)} sub={`${num(d.counts.invoiceLines)} de factura · ${num(d.counts.creditMemoLines)} de abono`} />
              <Kpi label="Excluidos" value={num(d.excludedZero + d.excludedEqual)} sub={`Artículo/proveedor con tantos abonos como facturas (${num(d.excludedEqual)}) o neto 0 (${num(d.excludedZero)})`} />
              <Kpi highlight tone="main" label="Neto (divisa del documento)" value={num(d.items.reduce((s, i) => s + i.net, 0))} sub="Suma de importes sin IVA" />
            </Grid>

            <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left">
                    <th className={th} /><th className={th}>Nº</th><th className={th}>Descripción</th><th className={th}>Gen. Prod. Posting Group</th>
                    <th className={th}>Purch. Account</th><th className={th}>Purch. Credit Memo Account</th>
                    <th className={`${th} text-right`}>Proveedores</th><th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Neto</th>
                  </tr>
                </thead>
                <tbody>
                  {items.slice(0, shown).map(i => {
                    const ik = i.itemNo;
                    return (
                      <Fragment key={ik}>
                        <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(ik)}>
                          <td className={td}>{open[ik] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                          <td className={`${td} font-mono font-semibold text-gray-900`}>{i.itemNo}</td>
                          <td className="py-1.5 px-2 min-w-[220px]">{i.description}</td>
                          <td className={`${td} font-mono`}>{i.genProdPostingGroup || '–'}</td>
                          <td className="py-1.5 px-2 font-mono text-xs">{setupAccounts(i.setup, 'purch')}</td>
                          <td className="py-1.5 px-2 font-mono text-xs">{setupAccounts(i.setup, 'crMemo')}</td>
                          <td className={`${td} text-right font-mono`}>{i.vendors.length}</td>
                          <td className={`${td} text-right font-mono`}>{num(i.quantity)}</td>
                          <td className={`${td} text-right font-mono font-semibold`}>{money(i.net)}</td>
                        </tr>
                        {open[ik] && (
                          <tr className="bg-gray-50/70">
                            <td />
                            <td colSpan={8} className="py-2 pr-2">
                              <table className="w-full text-[12px] bg-white rounded-lg border border-gray-200">
                                <thead>
                                  <tr className="border-b border-gray-200 text-left">
                                    <th className={th} /><th className={th}>Vendor No.</th><th className={th}>Vendor Name</th><th className={th}>Country/Region</th>
                                    <th className={th}>Payment Method</th><th className={th}>Payment Terms</th><th className={th}>Gen. Bus. Posting Group</th>
                                    <th className={th}>Cuenta actual (fact. / abono)</th><th className={`${th} text-right`}>Fact. / Abonos</th>
                                    <th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Neto</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {i.vendors.map(v => {
                                    const vk = `${ik}|${v.vendorNo}`;
                                    return (
                                      <Fragment key={vk}>
                                        <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(vk)}>
                                          <td className={td}>{open[vk] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                                          <td className={`${td} font-mono`}>{v.vendorNo}</td>
                                          <td className="py-1.5 px-2 min-w-[180px] font-medium text-gray-900">{v.name || '–'}</td>
                                          <td className={td}>{v.country || '–'}</td>
                                          <td className={td}>{v.paymentMethod || '–'}</td>
                                          <td className={td}>{v.paymentTerms || '–'}</td>
                                          <td className={`${td} font-mono`}>{v.genBusPostingGroup || '–'}</td>
                                          <td className={`${td} font-mono`}>{v.currentPurchAccount || '–'} / {v.currentCrMemoAccount || '–'}</td>
                                          <td className={`${td} text-right font-mono`}>{v.invoices} / {v.creditMemos}</td>
                                          <td className={`${td} text-right font-mono`}>{num(v.quantity)}</td>
                                          <td className={`${td} text-right font-mono font-semibold`}>{money(v.net)}</td>
                                        </tr>
                                        {open[vk] && (
                                          <tr>
                                            <td />
                                            <td colSpan={10} className="py-2 pr-2">
                                              <div className="overflow-x-auto">
                                                <table className="w-full text-[12px] border border-gray-200 rounded-lg">
                                                  <thead className="bg-gray-50">
                                                    <tr className="text-left">
                                                      <th className={th}>Tipo</th><th className={th}>Document No.</th><th className={th}>Document Date</th><th className={th}>Posting Date</th>
                                                      <th className={th}>VAT Date</th><th className={th}>Vendor Invoice No.</th><th className={`${th} text-right`}>Cantidad</th>
                                                      <th className={`${th} text-right`}>Direct Unit Cost Excl. VAT</th><th className={`${th} text-right`}>Importe</th>
                                                      <th className={th}>VAT Prod. Posting Group</th><th className={th}>Deferral Code</th><th className={th}>Cuenta G/L registrada</th>
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {v.docs.map(doc => {
                                                      const current = doc.kind === 'Abono' ? v.currentCrMemoAccount : v.currentPurchAccount;
                                                      return (
                                                        <tr key={`${doc.documentNo}|${doc.lineNo}`} className="border-t border-gray-100">
                                                          <td className={`${td} ${doc.kind === 'Abono' ? 'text-[#C0392B]' : ''}`}>{doc.kind}</td>
                                                          <td className={`${td} font-mono`}>{doc.documentNo}</td>
                                                          <td className={`${td} font-mono`}>{date(doc.documentDate)}</td>
                                                          <td className={`${td} font-mono`}>{date(doc.postingDate)}</td>
                                                          <td className={`${td} font-mono`}>{date(doc.vatDate)}</td>
                                                          <td className={td}>{doc.vendorDocNo || '–'}</td>
                                                          <td className={`${td} text-right font-mono`}>{num(doc.quantity)}</td>
                                                          <td className={`${td} text-right font-mono`}>{money(doc.directUnitCost, doc.currency)}</td>
                                                          <td className={`${td} text-right font-mono`}>{money(doc.amount, doc.currency)}</td>
                                                          <td className={`${td} font-mono`}>{doc.vatProdPostingGroup || '–'}</td>
                                                          <td className={`${td} font-mono`}>{doc.deferralCode || '–'}</td>
                                                          <td className="py-1.5 px-2 font-mono text-[11px]">
                                                            {doc.glAccounts.length ? doc.glAccounts.map(a => (
                                                              <span key={a.no} title={`${a.name} · ${num(a.amount, 2)} EUR`}
                                                                className={`block ${current && a.no !== current ? 'text-[#C8186C] font-semibold' : ''}`}>
                                                                {a.no} {a.name}
                                                              </span>
                                                            )) : <span className="text-gray-400">sin movimiento</span>}
                                                          </td>
                                                        </tr>
                                                      );
                                                    })}
                                                  </tbody>
                                                </table>
                                              </div>
                                            </td>
                                          </tr>
                                        )}
                                      </Fragment>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {!items.length && <p className="text-sm text-gray-500 p-4">Sin documentos en el periodo.</p>}
            </div>
            {items.length > shown && (
              <button onClick={() => setShown(s => s + PAGE)} className="text-sm font-semibold text-gray-700 hover:text-gray-900 underline">
                Mostrar más ({num(items.length - shown)} artículos más)
              </button>
            )}
            <p className="text-xs text-gray-500">La cuenta G/L en color es distinta de la que daría hoy la configuración contable del artículo y el proveedor.</p>
          </>
        )}
    </Section>
  );
}
