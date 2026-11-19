'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { Fmt } from '../reporting/i18n';
import { ErrorBox, Grid, Kpi, Loading, Section } from '../reporting/ui';
import CompanySelect, { useReportCompany } from './CompanySelect';
import { fetchPurchaseItems } from './purchaseData';
import DocPdfLink from '@/components/DocPdfLink';
import { useT } from '@/contexts/LanguageContext';

// Controlling · Compras por artículo (facturas y abonos de compra registrados): artículo → proveedores → documentos.
type GlAcc = { no: string; name: string; amount: number };
type Doc = {
  kind: 'Factura' | 'Abono'; documentNo: string; lineNo: number; documentDate: string; postingDate: string; vatDate: string;
  vendorDocNo: string; currency: string; quantity: number; directUnitCost: number; amount: number;
  vatProdPostingGroup: string; deferralCode: string; genProdPostingGroup: string; glAccounts: GlAcc[];
};
type Vendor = {
  vendorNo: string; company?: string; name: string; customerGroupCode?: string; customerGroupName?: string; country: string; paymentMethod: string; paymentTerms: string; genBusPostingGroup: string;
  currentPurchAccount: string; currentCrMemoAccount: string; net: number; quantity: number; invoices: number; creditMemos: number; docs: Doc[];
};
type Item = { itemNo: string; description: string; genProdPostingGroup: string; setup: { bus: string; purch: string; crMemo: string }[]; net: number; quantity: number; vendors: Vendor[] };
type Data = { items: Item[]; excludedZero: number; excludedEqual: number; cancelledPairs?: number; warnings: string[]; counts: { invoiceLines: number; creditMemoLines: number; glEntries: number } };

const iso = (d: Date) => d.toISOString().substring(0, 10);
const PAGE = 100;
const th = 'py-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 font-mono whitespace-nowrap';
const td = 'py-1.5 px-2 whitespace-nowrap';

// Cuentas de la configuración actual: una sola o "cuenta (grupo negocio)" si varían por grupo
function setupAccounts(setup: Item['setup'], k: 'purch' | 'crMemo', noGroup = 'no group') {
  const distinct = Array.from(new Set(setup.map(s => s[k]).filter(Boolean)));
  if (distinct.length <= 1) return distinct[0] || '–';
  return setup.filter(s => s[k]).map(s => `${s[k]} (${s.bus || noGroup})`).join(' · ');
}

export default function PurchaseItemsView({ fmt, company: globalCompany }: { fmt: Fmt; company: string }) {
  const { t, tx } = useT();
  const [company, setCompany] = useReportCompany(globalCompany);
  const kindLabel = (k: Doc['kind']) => (k === 'Abono' ? t('Credit memo') : t('Invoice'));
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
    fetchPurchaseItems(company, from, to, reload.force)
      .then(data => !cancelled && setState({ data, loading: false, error: null }))
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [from, to, reload, company]);

  const items = useMemo(() => {
    const all = state.data?.items || [];
    const s = search.trim().toLowerCase();
    if (!s) return all;
    return all.filter(i => i.itemNo.toLowerCase().includes(s) || i.description.toLowerCase().includes(s)
      || i.vendors.some(v => [v.vendorNo, v.name, v.customerGroupCode, v.customerGroupName].some(x => x?.toLowerCase().includes(s))));
  }, [state.data, search]);

  // Excel: hoja de artículos y hoja con una fila por línea de factura/abono (artículos filtrados por el buscador)
  const exportExcel = () => {
    const itemRows = items.map(i => ({
      'No.': i.itemNo, 'Description': i.description, 'Gen. Prod. Posting Group': i.genProdPostingGroup,
      'Purch. Account': setupAccounts(i.setup, 'purch', t('no group')), 'Purch. Credit Memo Account': setupAccounts(i.setup, 'crMemo', t('no group')),
      [t('Vendors')]: i.vendors.length, [t('Quantity')]: i.quantity, [t('Net')]: i.net,
    }));
    const lineRows = items.flatMap(i => i.vendors.flatMap(v => v.docs.map(doc => ({
      'Item No.': i.itemNo, 'Item Description': i.description, 'Gen. Prod. Posting Group': i.genProdPostingGroup,
      'Vendor No.': v.vendorNo, 'Vendor Name': v.name, 'Customer Group Code': v.customerGroupCode || '', 'Customer Group': v.customerGroupName || '', 'Country/Region Code': v.country, 'Payment Method Code': v.paymentMethod,
      'Payment Terms Code': v.paymentTerms, 'Gen. Bus. Posting Group': v.genBusPostingGroup,
      [t('Current account')]: doc.kind === 'Abono' ? v.currentCrMemoAccount : v.currentPurchAccount,
      [t('Type')]: kindLabel(doc.kind), 'Document No.': doc.documentNo, 'Document Date': doc.documentDate, 'Posting Date': doc.postingDate,
      'VAT Date': doc.vatDate, 'Vendor Invoice No.': doc.vendorDocNo, 'Quantity': doc.quantity,
      'Direct Unit Cost Excl. VAT': doc.directUnitCost, [t('Amount')]: doc.amount, 'Currency Code': doc.currency,
      'VAT Prod. Posting Group': doc.vatProdPostingGroup, 'Deferral Code': doc.deferralCode,
      [t('Posted G/L account')]: doc.glAccounts.map(a => a.no).join(', '), [t('G/L account name')]: doc.glAccounts.map(a => a.name).join(', '),
    }))));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemRows), t('Items'));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lineRows), t('Invoices and credit memos'));
    XLSX.writeFile(wb, `${t('Purchases by item')}_${company}_${from}_${to}.xlsx`.replace(/\s+/g, '_'));
  };

  const money = (v: number, cur = '') => `${num(v, 2)}${cur ? ` ${cur}` : ''}`;
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const d = state.data;

  return (
    <Section title={t('Purchases by item')} source={t('Posted purchase invoices (122/123) and credit memos (124/125) · current posting setup (252) · historical account from G/L Entries (17)')}>
      <div className="flex flex-wrap items-end gap-4">
        <CompanySelect value={company} onChange={setCompany} />
        {([[t('From'), from, setFrom], [t('Until'), to, setTo]] as const).map(([label, value, set]) => (
          <label key={label} className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {label}
            <input type="date" value={value} onChange={e => { set(e.target.value); setShown(PAGE); }}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-900 bg-white normal-case tracking-normal" />
          </label>
        ))}
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 flex-1 min-w-[220px]">
          {t('Search')}
          <span className="mt-1 flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-1.5 bg-white">
            <Search size={14} className="text-gray-400" />
            <input value={search} onChange={e => { setSearch(e.target.value); setShown(PAGE); }} placeholder={t('Item, description or vendor')}
              className="w-full text-sm text-gray-900 outline-none normal-case tracking-normal font-normal" />
          </span>
        </label>
        <button onClick={exportExcel} disabled={state.loading || !items.length}
          className="flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-black disabled:opacity-40">
          <FileDown size={16} /> {t('Export Excel')}
        </button>
        <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={state.loading} title={t('Reload from BC')}
          className="p-2 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-gray-900 disabled:opacity-40">
          <RefreshCw size={16} className={state.loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {from > to ? <ErrorBox message={t('The From date is after the To date.')} />
        : state.error ? <ErrorBox message={tx(state.error)} />
        : state.loading || !d ? <Loading text={t('Reading purchase invoices and credit memos from Business Central…')} />
        : (
          <>
            {d.warnings.map(w => <p key={w} className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{tx(w)}</p>)}
            <Grid cols={4}>
              <Kpi label={t('Items')} value={num(d.items.length)} sub={t('{n} item/vendor pairs', { n: num(d.items.reduce((s, i) => s + i.vendors.length, 0)) })} />
              <Kpi label={t('Lines')} value={num(d.counts.invoiceLines + d.counts.creditMemoLines)} sub={t('{a} invoice · {b} credit memo', { a: num(d.counts.invoiceLines), b: num(d.counts.creditMemoLines) })} />
              <Kpi label={t('Excluded')} value={num(d.excludedZero + d.excludedEqual)} sub={`${t('Item/vendor with as many credit memos as invoices ({a}) or net 0 ({b})', { a: num(d.excludedEqual), b: num(d.excludedZero) })}${d.cancelledPairs ? ` · ${t('{n} invoices cancelled by their credit memo hidden', { n: num(d.cancelledPairs) })}` : ''}`} />
              <Kpi highlight tone="main" label={t('Net (document currency)')} value={num(d.items.reduce((s, i) => s + i.net, 0))} sub={t('Sum of amounts excl. VAT')} />
            </Grid>

            <div className="rpt-card bg-white rounded-xl border border-gray-200 table-scroll">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left">
                    <th className={th} /><th className={th}>{t('No.')}</th><th className={th}>{t('Description')}</th><th className={th}>Gen. Prod. Posting Group</th>
                    <th className={th}>Purch. Account</th><th className={th}>Purch. Credit Memo Account</th>
                    <th className={`${th} text-right`}>{t('Vendors')}</th><th className={`${th} text-right`}>{t('Quantity')}</th><th className={`${th} text-right`}>{t('Net')}</th>
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
                          <td className="py-1.5 px-2 font-mono text-xs">{setupAccounts(i.setup, 'purch', t('no group'))}</td>
                          <td className="py-1.5 px-2 font-mono text-xs">{setupAccounts(i.setup, 'crMemo', t('no group'))}</td>
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
                                    <th className={th} /><th className={th}>Vendor No.</th><th className={th}>Vendor Name</th><th className={th}>Customer Group</th><th className={th}>Country/Region</th>
                                    <th className={th}>Payment Method</th><th className={th}>Payment Terms</th><th className={th}>Gen. Bus. Posting Group</th>
                                    <th className={th}>{t('Current account (inv. / cr. memo)')}</th><th className={`${th} text-right`}>{t('Inv. / Cr. memos')}</th>
                                    <th className={`${th} text-right`}>{t('Quantity')}</th><th className={`${th} text-right`}>{t('Net')}</th>
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
                                          <td className={td}>{v.customerGroupCode ? <><span className="font-mono">{v.customerGroupCode}</span> <span className="text-gray-500">{v.customerGroupName}</span></> : '–'}</td>
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
                                            <td colSpan={11} className="py-2 pr-2">
                                              <div className="overflow-x-auto">
                                                <table className="w-full text-[12px] border border-gray-200 rounded-lg">
                                                  <thead className="bg-gray-50">
                                                    <tr className="text-left">
                                                      <th className={th}>{t('Type')}</th><th className={th}>Document No.</th><th className={th}>Document Date</th><th className={th}>Posting Date</th>
                                                      <th className={th}>VAT Date</th><th className={th}>Vendor Invoice No.</th><th className={`${th} text-right`}>{t('Quantity')}</th>
                                                      <th className={`${th} text-right`}>Direct Unit Cost Excl. VAT</th><th className={`${th} text-right`}>{t('Amount')}</th>
                                                      <th className={th}>VAT Prod. Posting Group</th><th className={th}>Deferral Code</th><th className={th}>{t('Posted G/L account')}</th>
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {v.docs.map(doc => {
                                                      const current = doc.kind === 'Abono' ? v.currentCrMemoAccount : v.currentPurchAccount;
                                                      return (
                                                        <tr key={`${doc.documentNo}|${doc.lineNo}`} className="border-t border-gray-100">
                                                          <td className={`${td} ${doc.kind === 'Abono' ? 'text-[#C0392B]' : ''}`}>{kindLabel(doc.kind)}</td>
                                                          <td className={`${td} font-mono`}>{doc.documentNo}<DocPdfLink company={v.company || company} documentNo={doc.documentNo} kind={doc.kind === 'Abono' ? 'purchCrMemo' : 'purchInv'} /></td>
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
                                                            )) : <span className="text-gray-400">{t('no entry')}</span>}
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
              {!items.length && <p className="text-sm text-gray-500 p-4">{t('No documents in the period.')}</p>}
            </div>
            {items.length > shown && (
              <button onClick={() => setShown(s => s + PAGE)} className="text-sm font-semibold text-gray-700 hover:text-gray-900 underline">
                {t('Show more ({n} more items)', { n: num(items.length - shown) })}
              </button>
            )}
            <p className="text-xs text-gray-500">{t('The highlighted G/L account differs from the one the current posting setup of the item and vendor would give today.')}</p>
          </>
        )}
    </Section>
  );
}
