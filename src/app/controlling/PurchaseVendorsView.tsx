'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';
import CompanySelect, { useReportCompany } from './CompanySelect';
import { fetchPurchaseItems } from './purchaseData';
import DocPdfLink from './DocPdfLink';

// Controlling · Compras por proveedor: los mismos datos que Compras por artículo (facturas y abonos de compra
// registrados, /api/controlling/purchase-items) vistos al revés: proveedor → artículo → facturas, para validar que cada
// proveedor factura con los artículos correctos.
type GlAcc = { no: string; name: string; amount: number };
type Doc = {
  kind: 'Factura' | 'Abono'; documentNo: string; lineNo: number; documentDate: string; postingDate: string; vatDate: string;
  vendorDocNo: string; currency: string; quantity: number; directUnitCost: number; amount: number;
  vatProdPostingGroup: string; deferralCode: string; genProdPostingGroup: string; glAccounts: GlAcc[];
};
type SrcVendor = {
  vendorNo: string; company?: string; name: string; customerGroupCode?: string; customerGroupName?: string; country: string; paymentMethod: string; paymentTerms: string; genBusPostingGroup: string;
  currentPurchAccount: string; currentCrMemoAccount: string; net: number; quantity: number; invoices: number; creditMemos: number; docs: Doc[];
};
type SrcItem = { itemNo: string; description: string; genProdPostingGroup: string; net: number; quantity: number; vendors: SrcVendor[] };
type Data = { items: SrcItem[]; cancelledPairs?: number; warnings: string[] };

type VItem = { company?: string; itemNo: string; description: string; genProdPostingGroup: string; net: number; quantity: number; docs: Doc[]; current: string; currentCr: string };
type Vendor = Omit<SrcVendor, 'docs' | 'net' | 'quantity' | 'invoices' | 'creditMemos'> & { net: number; quantity: number; docs: number; items: VItem[] };

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const GROUPINGS = [
  { id: 'none', label: 'Sin agrupar' },
  { id: 'month', label: 'Mes' },
  { id: 'account', label: 'Cuenta G/L registrada' },
  { id: 'kind', label: 'Factura / abono' },
] as const;
type Grouping = typeof GROUPINGS[number]['id'];
const iso = (d: Date) => d.toISOString().substring(0, 10);
const PAGE = 100;
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 font-mono whitespace-nowrap';
const td = 'py-1.5 px-2 whitespace-nowrap';

export default function PurchaseVendorsView({ fmt, company: globalCompany }: { fmt: Fmt; company: string }) {
  const [company, setCompany] = useReportCompany(globalCompany);
  const { num, date } = fmt;
  const [from, setFrom] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(() => iso(new Date()));
  const [reload, setReload] = useState({ n: 0, force: false });
  const [state, setState] = useState<{ data: Data | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [search, setSearch] = useState('');
  const [grouping, setGrouping] = useState<Grouping>('none');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    if (!from || !to || from > to) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetchPurchaseItems(company, from, to, reload.force)
      .then(data => !cancelled && setState({ data, loading: false, error: null }))
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [from, to, reload, company]);

  // Proveedor → artículo → documentos
  const vendors = useMemo(() => {
    const map = new Map<string, Vendor>();
    for (const it of state.data?.items || []) {
      for (const v of it.vendors) {
        const vend = map.get(v.vendorNo) || {
          vendorNo: v.vendorNo, name: v.name, customerGroupCode: v.customerGroupCode, customerGroupName: v.customerGroupName, country: v.country, paymentMethod: v.paymentMethod, paymentTerms: v.paymentTerms,
          genBusPostingGroup: v.genBusPostingGroup, currentPurchAccount: v.currentPurchAccount, currentCrMemoAccount: v.currentCrMemoAccount,
          net: 0, quantity: 0, docs: 0, items: [],
        };
        vend.items.push({ company: v.company, itemNo: it.itemNo, description: it.description, genProdPostingGroup: it.genProdPostingGroup, net: v.net, quantity: v.quantity, docs: v.docs, current: v.currentPurchAccount, currentCr: v.currentCrMemoAccount });
        vend.net += v.net; vend.quantity += v.quantity; vend.docs += new Set(v.docs.map(d => d.documentNo)).size;
        map.set(v.vendorNo, vend);
      }
    }
    for (const v of map.values()) v.items.sort((a, b) => b.net - a.net);
    return Array.from(map.values()).sort((a, b) => b.net - a.net);
  }, [state.data]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return vendors;
    return vendors.filter(v => [v.vendorNo, v.name, v.customerGroupCode, v.customerGroupName].some(x => x?.toLowerCase().includes(s))
      || v.items.some(i => i.itemNo.toLowerCase().includes(s) || i.description.toLowerCase().includes(s)));
  }, [vendors, search]);

  const exportExcel = () => {
    const rows = filtered.flatMap(v => v.items.flatMap(i => i.docs.map(doc => ({
      'Vendor No.': v.vendorNo, 'Vendor Name': v.name, 'Customer Group Code': v.customerGroupCode || '', 'Customer Group': v.customerGroupName || '', 'Country/Region Code': v.country, 'Item No.': i.itemNo, 'Item Description': i.description,
      'Gen. Prod. Posting Group': i.genProdPostingGroup, 'Tipo': doc.kind, 'Document No.': doc.documentNo, 'Document Date': doc.documentDate,
      'Posting Date': doc.postingDate, 'Vendor Invoice No.': doc.vendorDocNo, 'Quantity': doc.quantity, 'Direct Unit Cost Excl. VAT': doc.directUnitCost,
      'Importe': doc.amount, 'Currency Code': doc.currency, 'Cuenta G/L registrada': doc.glAccounts.map(a => a.no).join(', '),
    }))));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Compras por proveedor');
    XLSX.writeFile(wb, `Compras_por_proveedor_${company}_${from}_${to}.xlsx`.replace(/\s+/g, '_'));
  };

  const money = (v: number, cur = '') => `${num(v, 2)}${cur ? ` ${cur}` : ''}`;
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const groupKey = (doc: Doc) => grouping === 'month' ? doc.postingDate.substring(0, 7)
    : grouping === 'account' ? (doc.glAccounts.map(a => `${a.no} ${a.name}`).join(', ') || 'sin movimiento')
    : grouping === 'kind' ? doc.kind : '';
  const groupLabel = (k: string) => (grouping === 'month' ? `${MONTHS[Number(k.substring(5, 7)) - 1]} ${k.substring(0, 4)}` : k);

  const DocRows = ({ docs, current, currentCr, docCompany }: { docs: Doc[]; current: string; currentCr: string; docCompany?: string }) => (
    <>
      {[...docs].sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.documentNo.localeCompare(b.documentNo)).map(doc => {
        const cur = doc.kind === 'Abono' ? currentCr : current;
        return (
          <tr key={`${doc.documentNo}|${doc.lineNo}`} className="border-t border-gray-100">
            <td className={`${td} ${doc.kind === 'Abono' ? 'text-[#C0392B]' : ''}`}>{doc.kind}</td>
            <td className={`${td} font-mono`}>{doc.documentNo}<DocPdfLink company={docCompany || company} documentNo={doc.documentNo} kind={doc.kind === 'Abono' ? 'purchCrMemo' : 'purchInv'} /></td>
            <td className={`${td} font-mono`}>{date(doc.postingDate)}</td>
            <td className={td}>{doc.vendorDocNo || '–'}</td>
            <td className={`${td} text-right font-mono`}>{num(doc.quantity)}</td>
            <td className={`${td} text-right font-mono`}>{money(doc.directUnitCost, doc.currency)}</td>
            <td className={`${td} text-right font-mono`}>{money(doc.amount, doc.currency)}</td>
            <td className="py-1.5 px-2 font-mono text-[11px]">
              {doc.glAccounts.length ? doc.glAccounts.map(a => (
                <span key={a.no} title={`${a.name} · ${num(a.amount, 2)} EUR`} className={`block ${cur && a.no !== cur ? 'text-[#C8186C] font-semibold' : ''}`}>{a.no} {a.name}</span>
              )) : <span className="text-gray-400">sin movimiento</span>}
            </td>
          </tr>
        );
      })}
    </>
  );

  const DocTable = ({ item, k }: { item: VItem; k: string }) => {
    const head = (
      <tr className="text-left">
        <th className={th}>Tipo</th><th className={th}>Document No.</th><th className={th}>Posting Date</th><th className={th}>Vendor Invoice No.</th>
        <th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Coste unit.</th><th className={`${th} text-right`}>Importe</th><th className={th}>Cuenta G/L registrada</th>
      </tr>
    );
    if (grouping === 'none') {
      return <table className="w-full text-[12px] border border-gray-200 rounded-lg"><thead className="bg-gray-50">{head}</thead><tbody><DocRows docs={item.docs} current={item.current} currentCr={item.currentCr} docCompany={item.company} /></tbody></table>;
    }
    const groups = new Map<string, Doc[]>();
    for (const d of item.docs) groups.set(groupKey(d), [...(groups.get(groupKey(d)) || []), d]);
    return (
      <div className="space-y-1">
        {Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([g, docs]) => {
          const gk = `${k}|g:${g}`;
          return (
            <div key={g} className="border border-gray-200 rounded-lg">
              <button onClick={() => toggle(gk)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm bg-gray-50 hover:bg-gray-100">
                {open[gk] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="text-gray-800">{groupLabel(g)}</span>
                <span className="ml-auto text-xs text-gray-500">{new Set(docs.map(d => d.documentNo)).size} doc. · {num(docs.reduce((s, d) => s + d.quantity, 0))} uds.</span>
                <span className="w-36 text-right font-semibold font-mono">{money(docs.reduce((s, d) => s + d.amount, 0))}</span>
              </button>
              {open[gk] && <table className="w-full text-[12px]"><thead>{head}</thead><tbody><DocRows docs={docs} current={item.current} currentCr={item.currentCr} docCompany={item.company} /></tbody></table>}
            </div>
          );
        })}
      </div>
    );
  };

  const d = state.data;
  return (
    <Section title="Compras por proveedor" source="Facturas y abonos de compra registrados (como Compras por artículo) · proveedor → artículo → facturas">
      <div className="flex flex-wrap items-end gap-4">
        <CompanySelect value={company} onChange={setCompany} />
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
            <input value={search} onChange={e => { setSearch(e.target.value); setShown(PAGE); }} placeholder="Proveedor o artículo"
              className="w-full text-sm text-gray-900 outline-none normal-case tracking-normal font-normal" />
          </span>
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Agrupar facturas por
          <select value={grouping} onChange={e => setGrouping(e.target.value as Grouping)}
            className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal">
            {GROUPINGS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </label>
        <button onClick={exportExcel} disabled={state.loading || !filtered.length}
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
            <Grid cols={3}>
              <Kpi label="Proveedores" value={num(vendors.length)} sub={`${num(vendors.reduce((s, v) => s + v.items.length, 0))} pares proveedor/artículo`} />
              <Kpi label="Proveedores con más de un artículo" value={num(vendors.filter(v => v.items.length > 1).length)} sub="Para revisar si todos los artículos son los esperados" />
              <Kpi highlight tone="main" label="Neto (divisa del documento)" value={num(vendors.reduce((s, v) => s + v.net, 0))} sub={d.cancelledPairs ? `${num(d.cancelledPairs)} facturas anuladas por su abono no se muestran` : 'Suma de importes sin IVA'} />
            </Grid>
            <div className="rpt-card bg-white rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left">
                    <th className={th} /><th className={th}>Vendor No.</th><th className={th}>Vendor Name</th><th className={th}>Customer Group</th><th className={th}>Country</th>
                    <th className={th}>Gen. Bus. Posting Group</th><th className={th}>Cuenta actual (fact. / abono)</th>
                    <th className={`${th} text-right`}>Artículos</th><th className={`${th} text-right`}>Documentos</th><th className={`${th} text-right`}>Neto</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, shown).map(v => (
                    <Fragment key={v.vendorNo}>
                      <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(v.vendorNo)}>
                        <td className={td}>{open[v.vendorNo] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td className={`${td} font-mono font-semibold text-gray-900`}>{v.vendorNo}</td>
                        <td className="py-1.5 px-2 min-w-[220px] font-medium text-gray-900">{v.name || '–'}</td>
                        <td className={td}>{v.customerGroupCode ? <><span className="font-mono">{v.customerGroupCode}</span> <span className="text-gray-500">{v.customerGroupName}</span></> : '–'}</td>
                        <td className={td}>{v.country || '–'}</td>
                        <td className={`${td} font-mono`}>{v.genBusPostingGroup || '–'}</td>
                        <td className={`${td} font-mono`}>{v.currentPurchAccount || '–'} / {v.currentCrMemoAccount || '–'}</td>
                        <td className={`${td} text-right font-mono`}>{v.items.length}</td>
                        <td className={`${td} text-right font-mono`}>{v.docs}</td>
                        <td className={`${td} text-right font-mono font-semibold`}>{money(v.net)}</td>
                      </tr>
                      {open[v.vendorNo] && (
                        <tr className="bg-gray-50/70">
                          <td />
                          <td colSpan={9} className="py-2 pr-2">
                            <table className="w-full text-[12px] bg-white rounded-lg border border-gray-200">
                              <thead>
                                <tr className="border-b border-gray-200 text-left">
                                  <th className={th} /><th className={th}>Item No.</th><th className={th}>Descripción</th><th className={th}>Gen. Prod. Posting Group</th>
                                  <th className={`${th} text-right`}>Documentos</th><th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Neto</th>
                                </tr>
                              </thead>
                              <tbody>
                                {v.items.map(i => {
                                  const k = `${v.vendorNo}|${i.itemNo}`;
                                  return (
                                    <Fragment key={k}>
                                      <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(k)}>
                                        <td className={td}>{open[k] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                                        <td className={`${td} font-mono font-semibold`}>{i.itemNo}</td>
                                        <td className="py-1.5 px-2 min-w-[200px]">{i.description}</td>
                                        <td className={`${td} font-mono`}>{i.genProdPostingGroup || '–'}</td>
                                        <td className={`${td} text-right font-mono`}>{new Set(i.docs.map(x => x.documentNo)).size}</td>
                                        <td className={`${td} text-right font-mono`}>{num(i.quantity)}</td>
                                        <td className={`${td} text-right font-mono font-semibold`}>{money(i.net)}</td>
                                      </tr>
                                      {open[k] && <tr><td /><td colSpan={6} className="py-2 pr-2"><div className="overflow-x-auto"><DocTable item={i} k={k} /></div></td></tr>}
                                    </Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {!filtered.length && <p className="text-sm text-gray-500 p-4">Sin documentos en el periodo.</p>}
            </div>
            {filtered.length > shown && (
              <button onClick={() => setShown(s => s + PAGE)} className="text-sm font-semibold text-gray-700 hover:text-gray-900 underline">
                Mostrar más ({num(filtered.length - shown)} proveedores más)
              </button>
            )}
            <p className="text-xs text-gray-500">Mismos documentos que Compras por artículo (artículos que no son de inventario; pares artículo/proveedor que se anulan del todo no salen). La cuenta G/L en color es distinta de la que daría hoy la configuración contable.</p>
          </>
        )}
    </Section>
  );
}
