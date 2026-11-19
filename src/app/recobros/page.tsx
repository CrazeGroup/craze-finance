'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { tabCompany, useCompany } from '@/contexts/CompanyContext';
import { useComments, CommentBadge, CommentsDialog } from '@/components/InvoiceComments';
import { syncFromBc } from '@/lib/syncClient';
import { RefreshCcw, Send, CheckCircle, ChevronDown, ChevronRight, Filter, Briefcase, MessageSquare, PhoneCall } from 'lucide-react';
import ReminderDialog from '@/components/ReminderDialog';
import MailConnectNotice from '@/components/MailConnectNotice';
import { useT } from '@/contexts/LanguageContext';

// Empresa activa (cookie que escribe CompanyContext)

export default function RecobrosPage() {
  const [rawInvoices, setRawInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Comentarios por factura, los mismos que en Cashflow ("invoice:<id>")
  const { selectedCompany } = useCompany();
  const { t, lang, locale } = useT();
  const { commentsFor, add: addComment, remove: removeComment } = useComments(selectedCompany);
  const [commentTarget, setCommentTarget] = useState<{ key: string; label: string } | null>(null);

  // Recordatorio al cliente (diálogo común con Cashflow)
  const [reminder, setReminder] = useState<{ customer: any; invoices: any[] } | null>(null);

  // Pestañas: clientes (gestión) / resumen de acciones sobre las vencidas; se recuerda en el navegador
  const [tab, setTab] = useState<'customers' | 'summary'>('customers');
  useEffect(() => { try { if (localStorage.getItem('recobros:tab') === 'summary') setTab('summary'); } catch { /* sin almacenamiento */ } }, []);
  const changeTab = (v: 'customers' | 'summary') => { setTab(v); try { localStorage.setItem('recobros:tab', v); } catch { /* sin almacenamiento */ } };

  // UI State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPaymentMethods, setSelectedPaymentMethods] = useState<string[]>([]);
  const [customerSortBy, setCustomerSortBy] = useState<'amtOpen' | 'amtOverdue' | 'amtConfirmed'>('amtOverdue');
  const [invoiceSortBy, setInvoiceSortBy] = useState<'daysOverdue' | 'amount' | 'reminders'>('daysOverdue');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [selectedInvoices, setSelectedInvoices] = useState<Record<number, boolean>>({});
  const [smartFilters, setSmartFilters] = useState<Record<number, 'zero' | 'seven_days' | null>>({});

  const fetchInvoices = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/invoices', { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data)) {
        setRawInvoices(data);
      }
    } catch (error) {
      console.error('Failed to fetch invoices', error);
    } finally {
      setLoading(false);
    }
  };

  const [syncing, setSyncing] = useState(false);
  const handleSync = async () => {
    setSyncing(true);
    try {
      // Paso a paso por empresa (una sola llamada con todo pasa del límite de 60 s de Vercel)
      const errors = await syncFromBc(tabCompany());
      if (errors.length) console.error('Sync errors', errors);
      await fetchInvoices();
    } catch (error) {
      console.error('Failed to sync', error);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchInvoices();
  }, []);

  const toggleExpand = (customerId: number) => {
    setExpanded(prev => ({ ...prev, [customerId]: !prev[customerId] }));
  };

  const toggleInvoiceSelect = (invoiceId: number) => {
    setSelectedInvoices(prev => ({ ...prev, [invoiceId]: !prev[invoiceId] }));
  };

  const toggleSelectCustomerInvoices = (customerInvoices: any[], forceSelect?: boolean) => {
    const overdueInvoices = customerInvoices.filter(inv => inv.isOverdue && !inv.confirmedPaymentDate);
    if (overdueInvoices.length === 0) return;

    const newSelected = { ...selectedInvoices };
    
    if (forceSelect === false) {
      overdueInvoices.forEach(inv => delete newSelected[inv.id]);
    } else {
      const allSelected = overdueInvoices.every(inv => selectedInvoices[inv.id]);
      overdueInvoices.forEach(inv => {
        if (allSelected) {
          delete newSelected[inv.id];
        } else {
          newSelected[inv.id] = true;
        }
      });
    }
    setSelectedInvoices(newSelected);
  };

  const applySmartSelection = (customerId: number, invoices: any[], type: 'zero' | 'seven_days') => {
    const isCurrentlyActive = smartFilters[customerId] === type;
    const newSelected = { ...selectedInvoices };
    const today = new Date();
    
    invoices.forEach(inv => {
      if (!inv.isOverdue || inv.confirmedPaymentDate) return;
      
      let matches = false;
      if (type === 'zero' && inv.reminderCount === 0) {
        matches = true;
      } else if (type === 'seven_days') {
        if (!inv.lastReminderSentAt) {
          matches = true;
        } else {
          const diff = Math.ceil(Math.abs(today.getTime() - new Date(inv.lastReminderSentAt).getTime()) / (1000 * 60 * 60 * 24));
          if (diff > 7) matches = true;
        }
      }

      if (matches) {
        newSelected[inv.id] = !isCurrentlyActive;
      }
    });
    
    setSelectedInvoices(newSelected);
    setSmartFilters(prev => ({
      ...prev,
      [customerId]: isCurrentlyActive ? null : type
    }));
  };

  const availablePaymentMethods = useMemo(() => {
    const methods = new Set<string>();
    rawInvoices.forEach(inv => {
      if (inv.paymentMethod) methods.add(inv.paymentMethod);
    });
    return Array.from(methods).sort();
  }, [rawInvoices]);

  const groupedData = useMemo(() => {
    const map = new Map<string, any>();
    const query = searchQuery.toLowerCase().trim();
    const methodsFilter = new Set(selectedPaymentMethods);

    const matchingInvoiceIds = new Set<number>();
    const matchingCustomerIds = new Set<string>();

    if (query) {
      rawInvoices.forEach(inv => {
        const cId = inv.customer?.bcId || String(inv.customerId);
        const cName = (inv.customer?.name || '').toLowerCase();
        
        if (cId.toLowerCase().includes(query) || cName.includes(query)) {
          matchingCustomerIds.add(cId);
        }
        if (inv.bcId.toLowerCase().includes(query)) {
          matchingInvoiceIds.add(inv.id);
        }
      });
    }

    rawInvoices.forEach(inv => {
      const cId = inv.customer?.bcId || String(inv.customerId);
      
      if (query) {
        const isCustomerMatch = matchingCustomerIds.has(cId);
        const isInvoiceMatch = matchingInvoiceIds.has(inv.id);
        if (!isCustomerMatch && !isInvoiceMatch) return;
      }

      if (methodsFilter.size > 0 && !methodsFilter.has(inv.paymentMethod)) return;

      if (!map.has(cId)) {
        map.set(cId, {
          customer: inv.customer,
          invoices: [],
          totalCount: 0,
          amtOpen: 0,
          amtOverdue: 0,
          amtConfirmed: 0,
          sumDaysOverdue: 0,
          overdueCount: 0
        });
      }
      const group = map.get(cId);
      group.invoices.push(inv);
      group.totalCount += 1;
      group.amtOpen += (inv.amount || 0);
      if (inv.isOverdue) {
        group.amtOverdue += (inv.amount || 0);
        group.sumDaysOverdue += (inv.daysOverdue || 0);
        group.overdueCount += 1;
      }
      if (inv.confirmedPaymentDate) {
        group.amtConfirmed += (inv.amount || 0);
      }
    });

    const arr = Array.from(map.values()).map(g => ({
      ...g,
      avgDaysOverdue: g.overdueCount > 0 ? Math.round(g.sumDaysOverdue / g.overdueCount) : 0
    }));

    arr.sort((a, b) => {
      if (customerSortBy === 'amtOpen') return b.amtOpen - a.amtOpen;
      if (customerSortBy === 'amtOverdue') return b.amtOverdue - a.amtOverdue;
      if (customerSortBy === 'amtConfirmed') return b.amtConfirmed - a.amtConfirmed;
      return 0;
    });

    arr.forEach(g => {
      g.invoices.sort((a: any, b: any) => {
        if (invoiceSortBy === 'daysOverdue') return b.daysOverdue - a.daysOverdue;
        if (invoiceSortBy === 'amount') return b.amount - a.amount;
        if (invoiceSortBy === 'reminders') return a.reminderCount - b.reminderCount;
        return 0;
      });
    });

    return arr;
  }, [rawInvoices, customerSortBy, invoiceSortBy, searchQuery, selectedPaymentMethods]);

  const openEmailModal = (group: any) => {
    const selectedList = group.invoices.filter((inv: any) => selectedInvoices[inv.id]);
    if (selectedList.length === 0) {
      alert(t('Select at least one invoice for this customer.'));
      return;
    }
    setReminder({ customer: group.customer, invoices: selectedList });
  };

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-32">
      <MailConnectNotice />
      <header className="flex flex-wrap justify-between items-end mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-black text-black tracking-tight">
            {t('Collections Management')}
          </h1>
          <p className="text-gray-700 font-semibold font-medium mt-2">{t('Grouped by customer with advanced selection.')}</p>
        </div>
        <div className="flex gap-4">
          <button 
            onClick={fetchInvoices}
            className="flex items-center gap-2 bg-white/10 hover:bg-gray-200 text-gray-900 px-4 py-2 rounded-lg transition-all backdrop-blur-sm border border-gray-200"
            disabled={loading || syncing}
          >
            <RefreshCcw size={18} className={loading && !syncing ? 'animate-spin' : ''} />
            {t('Refresh Local')}
          </button>
          <button 
            onClick={handleSync}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-gray-900 px-4 py-2 rounded-lg transition-all shadow-lg shadow-gray-500/20"
            disabled={loading || syncing}
          >
            <RefreshCcw size={18} className={syncing ? 'animate-spin' : ''} />
            {syncing ? t('Syncing... (wait 1-2 min)') : t('Sync BC')}
          </button>
        </div>
      </header>

      <div className="mb-6 inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm bg-white">
        {([['customers', t('Customers')], ['summary', t('Summary')]] as const).map(([v, label]) => (
          <button key={v} onClick={() => changeTab(v)}
            className={`px-4 py-1.5 font-semibold ${tab === v ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>{label}</button>
        ))}
      </div>

      {tab === 'summary' ? (
        <CollectionsSummary invoices={rawInvoices} loading={loading} commentsFor={commentsFor}
          onComment={(key, label) => setCommentTarget({ key, label })} />
      ) : (<>
      {/* Sorting & Search Controls */}
      <div className="mb-6 flex flex-col md:flex-row gap-6 bg-gray-50 p-4 rounded-xl border border-gray-200 backdrop-blur-sm">
        <div className="flex-1">
          <input 
            type="text" 
            placeholder={t('Search by customer or invoice no....')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white border border-gray-300 text-sm text-gray-900 rounded-lg px-4 py-2 outline-none focus:border-indigo-500 transition-colors placeholder-gray-500"
          />
        </div>
        
        <div className="flex flex-wrap gap-6 items-center">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-800 font-medium font-medium">{t('Sort Customers by:')}</span>
            <select 
              className="bg-white border border-gray-300 text-sm text-gray-900 rounded-lg px-3 py-1.5 outline-none"
              value={customerSortBy}
              onChange={(e) => setCustomerSortBy(e.target.value as any)}
            >
              <option value="amtOverdue">{t('Highest Overdue Amount')}</option>
              <option value="amtOpen">{t('Highest Total Open Amount')}</option>
              <option value="amtConfirmed">{t('Highest Confirmed Amount')}</option>
            </select>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-800 font-medium font-medium">{t('Sort Invoices by:')}</span>
            <select 
              className="bg-white border border-gray-300 text-sm text-gray-900 rounded-lg px-3 py-1.5 outline-none"
              value={invoiceSortBy}
              onChange={(e) => setInvoiceSortBy(e.target.value as any)}
            >
              <option value="daysOverdue">{t('Most days overdue')}</option>
              <option value="amount">{t('Highest amount')}</option>
              <option value="reminders">{t('Fewest reminders')}</option>
            </select>
          </div>
        </div>
      </div>
      
      {/* Payment Method Filters */}
      {availablePaymentMethods.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-4 items-center bg-gray-50 p-4 rounded-xl border border-gray-200 backdrop-blur-sm">
          <span className="text-sm text-gray-800 font-medium font-medium">{t('Filter by Payment Method:')}</span>
          <div className="flex flex-wrap gap-2">
            {availablePaymentMethods.map(pm => (
              <button
                key={pm}
                onClick={() => {
                  if (selectedPaymentMethods.includes(pm)) {
                    setSelectedPaymentMethods(prev => prev.filter(p => p !== pm));
                  } else {
                    setSelectedPaymentMethods(prev => [...prev, pm]);
                  }
                }}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  selectedPaymentMethods.includes(pm)
                    ? 'bg-indigo-500/20 text-indigo-700 font-bold border-indigo-500/50 shadow-[0_0_10px_rgba(99,102,241,0.2)]'
                    : 'bg-gray-50 text-gray-900 font-bold border-gray-200 hover:bg-gray-200 hover:text-gray-800 font-medium'
                }`}
              >
                {pm}
              </button>
            ))}
            {selectedPaymentMethods.length > 0 && (
              <button 
                onClick={() => setSelectedPaymentMethods([])}
                className="px-2 py-1 text-xs text-gray-700 font-semibold font-bold hover:text-red-300 transition-colors underline decoration-red-400/30 underline-offset-2 ml-2"
              >
                {t('Clear Filter')}
              </button>
            )}
          </div>
        </div>
      )}
      

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-orange-400"></div>
        </div>
      ) : groupedData.length === 0 ? (
        <div className="text-center py-20 bg-gray-50 rounded-2xl border border-gray-200 backdrop-blur-sm shadow-lg">
          <CheckCircle className="mx-auto text-gray-900 font-bold mb-4" size={48} />
          <p className="text-xl text-gray-800 font-medium">{t('There are no open invoices.')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedData.map((group) => {
            const isExpanded = expanded[group.customer.id];
            const hasSelection = group.invoices.some((inv: any) => selectedInvoices[inv.id]);
            const selectedCount = group.invoices.filter((inv: any) => selectedInvoices[inv.id]).length;

            return (
              <div key={group.customer.bcId} className="rounded-xl border border-gray-200 bg-white/10 backdrop-blur-md shadow-xl overflow-hidden transition-all duration-300">
                {/* Customer Summary Row */}
                <div 
                  className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between p-4 cursor-pointer hover:bg-gray-200 transition-colors gap-4"
                  onClick={() => toggleExpand(group.customer.id)}
                >
                  <div className="flex items-center gap-4 flex-1 min-w-[250px]">
                    <div className="text-slate-500">
                      {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                    </div>
                    <div>
                      <h3 className="font-bold text-lg text-gray-900">
                        <span className="text-gray-700 font-semibold font-normal mr-2">#{group.customer.bcId}</span>
                        {group.customer.name}
                      </h3>
                      <p className="text-xs text-gray-700 font-semibold">{group.customer.email || t('No email configured')}</p>
                      {(() => { const n = group.invoices.filter((i: any) => commentsFor(`invoice:${i.id}`).length).length; return n ? <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700"><MessageSquare size={11} /> {t('{n} invoice(s) with comments', { n })}</p> : null; })()}
                    </div>
                  </div>
                  
                  <div className="flex flex-wrap gap-6 text-sm flex-1 min-w-[350px]">
                    <div className="flex flex-col">
                      <span className="text-indigo-700 font-bold text-xs">{t('Total Open')}</span>
                      <span className={`font-medium ${group.amtOpen > 0 ? 'text-gray-700 font-semibold font-bold' : group.amtOpen < 0 ? 'text-gray-900 font-bold' : 'text-gray-900'}`}>€{group.amtOpen.toLocaleString(locale)}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-indigo-700 font-bold text-xs">{t('Total Overdue')}</span>
                      <span className={`font-medium ${group.amtOverdue > 0 ? 'text-gray-700 font-semibold font-bold' : group.amtOverdue < 0 ? 'text-gray-900 font-bold' : 'text-gray-900'}`}>€{group.amtOverdue.toLocaleString(locale)}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-indigo-700 font-bold text-xs">{t('Total Confirmed')}</span>
                      <span className={`font-medium ${group.amtConfirmed > 0 ? 'text-gray-700 font-semibold font-bold' : group.amtConfirmed < 0 ? 'text-gray-900 font-bold' : 'text-gray-900'}`}>€{group.amtConfirmed.toLocaleString(locale)}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-indigo-700 font-bold text-xs">{t('Invoices')}</span>
                      <span className="font-medium text-gray-900">{t('{total} ({overdue} overdue)', { total: group.totalCount, overdue: group.overdueCount })}</span>
                    </div>
                    {/* Salesperson info */}
                    <div className="flex flex-col border-l border-gray-200 pl-4">
                      <span className="text-emerald-700 font-bold text-xs flex items-center gap-1">
                        <Briefcase size={12} /> {t('Salesperson')}
                      </span>
                      <span className="font-medium text-gray-900">
                        {group.customer.salespersonName || t('Unassigned')}
                      </span>
                      {group.customer.salespersonReminderCount > 0 && (
                        <span className="text-[10px] text-gray-900 font-bold/80">
                          {t('{n} notices (Last: {date})', { n: group.customer.salespersonReminderCount, date: new Date(group.customer.salespersonLastReminderDate).toLocaleDateString(locale) })}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row items-center gap-3" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => openEmailModal(group)}
                      className={`flex items-center justify-center w-full sm:w-auto gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                        !hasSelection
                          ? 'bg-gray-100 text-gray-900 font-bold hover:bg-gray-200'
                          : 'bg-black hover:bg-gray-800 text-white shadow-md'
                      }`}
                    >
                      <Send size={16} />
                      {t('Send reminder ({n})', { n: selectedCount })}
                    </button>
                  </div>
                </div>

                {/* Expanded Invoice List */}
                {isExpanded && (
                  <div className="bg-white/40 p-4 border-t border-gray-200">
                    <div className="flex gap-2 mb-4">
                      <button 
                        onClick={() => toggleSelectCustomerInvoices(group.invoices)}
                        className={`text-xs px-3 py-1.5 rounded border border-indigo-500/30 transition-colors ${
                          group.invoices.filter((inv: any) => inv.isOverdue && !inv.confirmedPaymentDate).length > 0 &&
                          group.invoices.filter((inv: any) => inv.isOverdue && !inv.confirmedPaymentDate).every((inv: any) => selectedInvoices[inv.id])
                            ? 'bg-indigo-500/40 text-indigo-100'
                            : 'bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-700 font-bold'
                        }`}
                      >
                        {t('All Overdue')}
                      </button>
                      <button 
                        onClick={() => toggleSelectCustomerInvoices(group.invoices, false)}
                        className="text-xs bg-white/10 hover:bg-gray-200 text-gray-800 font-medium px-3 py-1.5 rounded border border-gray-100"
                      >
                        {t('Deselect')}
                      </button>
                      <button 
                        onClick={() => applySmartSelection(group.customer.id, group.invoices, 'zero')}
                        className={`text-xs px-3 py-1.5 rounded flex items-center gap-1 border border-indigo-500/30 transition-colors ${smartFilters[group.customer.id] === 'zero' ? 'bg-indigo-500/40 text-indigo-100' : 'bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-700 font-bold'}`}
                      >
                        <Filter size={12}/> {t('0 Reminders')}
                      </button>
                      <button 
                        onClick={() => applySmartSelection(group.customer.id, group.invoices, 'seven_days')}
                        className={`text-xs px-3 py-1.5 rounded flex items-center gap-1 border border-orange-500/30 transition-colors ${smartFilters[group.customer.id] === 'seven_days' ? 'bg-orange-500/40 text-orange-100' : 'bg-orange-500/10 hover:bg-orange-500/20 text-orange-300'}`}
                      >
                        <Filter size={12}/> {t('Last > 7 days')}
                      </button>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm text-gray-800 font-medium">
                        <thead className="text-gray-900 font-bold border-b border-gray-200">
                          <tr>
                            <th className="pb-2 w-8"></th>
                            <th className="pb-2 font-medium">{t('Document')}</th>
                            <th className="pb-2 font-medium">{t('Type')}</th>
                            <th className="pb-2 font-medium">{t('Payment Method')}</th>
                            <th className="pb-2 font-medium">{t('Currency')}</th>
                            <th className="pb-2 font-medium">{t('Original Amt.')}</th>
                            <th className="pb-2 font-medium">{t('Remaining Amt.')}</th>
                            <th className="pb-2 font-medium">{t('Due Date')}</th>
                            <th className="pb-2 font-medium">{t('Status')}</th>
                            <th className="pb-2 font-medium">{t('Reminders')}</th>
                            <th className="pb-2 font-medium">{t('Reminder Date')}</th>
                            <th className="pb-2 font-medium">{t('Confirmed Payment Date')}</th>
                            <th className="pb-2 font-medium">{t('Comments')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {group.invoices.map((inv: any) => (
                            <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                              <td className="py-2">
                                <input 
                                  type="checkbox" 
                                  className="rounded border-gray-600 bg-gray-900 text-indigo-500 focus:ring-indigo-500 disabled:opacity-50"
                                  checked={!!selectedInvoices[inv.id]}
                                  onChange={() => toggleInvoiceSelect(inv.id)}
                                  disabled={!inv.isOverdue || !!inv.confirmedPaymentDate} 
                                />
                              </td>
                              <td className="py-2 font-bold text-slate-900">{inv.bcId}</td>
                              <td className="py-2">
                                <span className={inv.type === 'Credit Memo' || inv.type === 'credit memo' ? 'text-gray-900 font-bold font-medium' : 'text-gray-600'}>{inv.type}</span>
                              </td>
                              <td className="py-2 text-indigo-200">{inv.paymentMethod || '-'}</td>
                              <td className="py-2 text-gray-600">{inv.currencyCode || '-'}</td>
                              <td className="py-2 text-gray-900 font-bold">€{(inv.originalAmount || 0).toLocaleString(locale)}</td>
                              <td className="py-2 font-semibold">
                                {inv.originalAmount && inv.originalAmount !== inv.amount ? (
                                  <div className="flex items-center gap-2">
                                    <span className="text-amber-400">€{inv.amount.toLocaleString(locale)}</span>
                                    <span className="text-[10px] uppercase tracking-wider bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/30">{t('Partial')}</span>
                                  </div>
                                ) : (
                                  <span className={inv.amount > 0 ? "text-gray-700 font-semibold font-bold" : inv.amount < 0 ? "text-gray-900 font-bold" : "text-gray-900"}>€{inv.amount.toLocaleString(locale)}</span>
                                )}
                              </td>
                              <td className="py-2 text-gray-700 font-semibold">{new Date(inv.dueDate).toLocaleDateString(locale)}</td>
                              <td className="py-2">
                                {inv.isOverdue ? (
                                  <span className="text-gray-700 font-semibold font-bold font-medium">{t('{n} days', { n: inv.daysOverdue })}</span>
                                ) : (
                                  <span className="text-gray-900 font-bold">{t('Up to date')}</span>
                                )}
                              </td>
                              <td className="py-2">
                                {inv.reminderCount ? <span className="font-semibold text-amber-700">{lang === 'es' ? `${inv.reminderCount}º` : `#${inv.reminderCount}`}</span> : '0'}
                                {inv.lastCallDate && (
                                  <span className="inline-flex items-center gap-0.5 ml-1.5 text-violet-700 font-semibold text-xs" title={t('Called {n}× · last call {date} (marked in Cashflow)', { n: inv.callCount || 1, date: new Date(inv.lastCallDate).toLocaleDateString(locale) })}>
                                    <PhoneCall size={11} />{(inv.callCount || 1) > 1 ? inv.callCount : ''}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 text-gray-700 font-semibold">
                                {inv.lastReminderSentAt ? new Date(inv.lastReminderSentAt).toLocaleDateString(locale) : '-'}
                              </td>
                              <td className="py-2 font-medium text-gray-900 font-bold">
                                {inv.confirmedPaymentDate ? new Date(inv.confirmedPaymentDate).toLocaleDateString(locale) : '-'}
                              </td>
                              <td className="py-2">
                                <div className="flex items-center gap-1.5">
                                  <button onClick={() => setCommentTarget({ key: `invoice:${inv.id}`, label: inv.bcId })}
                                    className={`p-1 rounded hover:bg-sky-400/20 ${commentsFor(`invoice:${inv.id}`).length ? 'text-sky-700' : 'text-gray-400 hover:text-black'}`} title={t('Invoice comments (the same as in Cashflow)')}>
                                    <MessageSquare size={14} />
                                  </button>
                                  <CommentBadge items={commentsFor(`invoice:${inv.id}`)} onClick={() => setCommentTarget({ key: `invoice:${inv.id}`, label: inv.bcId })} />
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      </>)}

      {commentTarget && (
        <CommentsDialog label={commentTarget.label} items={commentsFor(commentTarget.key)} onClose={() => setCommentTarget(null)}
          onAdd={text => addComment(commentTarget.key, text, commentTarget.label)} onDelete={removeComment} />
      )}

      {/* Recordatorio al cliente: 1º normal, 2º comercial en copia, 3º aviso aseguradora */}
      {reminder && (
        <ReminderDialog customer={reminder.customer} invoices={reminder.invoices} onClose={() => setReminder(null)}
          onSent={async () => {
            const newSelected = { ...selectedInvoices };
            reminder.invoices.forEach((i: any) => delete newSelected[i.id]);
            setSelectedInvoices(newSelected);
            setReminder(null);
            await fetchInvoices();
          }} />
      )}


    </div>
  );
}

// ---- Summary: facturas vencidas de todos los clientes y lo que se ha hecho con cada una ----
// Vencidas sin Confirmed Payment Date y sin Amazon (cliente con "Amazon" en el nombre o forma de pago AMAZON).
// Acciones: reclamaciones (nº y última fecha, las mismas que en Cashflow), llamadas (marca "Llamado" de Cashflow) y
// comentarios de la factura o de su línea de Cashflow. Por cliente, desplegable a sus facturas.
type ActionFilter = 'all' | 'none' | 'reminded' | 'called' | 'commented';
function CollectionsSummary({ invoices, loading, commentsFor, onComment }: {
  invoices: any[]; loading: boolean; commentsFor: (key: string) => any[]; onComment: (key: string, label: string) => void;
}) {
  const { t, locale } = useT();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActionFilter>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen(p => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const isAmazon = (inv: any) => /amazon/i.test(inv.customer?.name || '') || /amazon/i.test(inv.paymentMethod || '');
  const base = invoices.filter(inv => inv.isOverdue && !inv.confirmedPaymentDate && !isAmazon(inv));
  const info = (inv: any) => {
    const comments = commentsFor(`invoice:${inv.id}`);
    const lastComment = comments.reduce((m: string, c: any) => (c.createdAt > m ? c.createdAt : m), '');
    const dates = [inv.lastReminderSentAt, inv.lastCallDate, lastComment].filter(Boolean).map((d: string) => String(d));
    return {
      reminders: inv.reminderCount || 0, lastReminder: inv.lastReminderSentAt as string | null,
      calls: inv.lastCallDate ? inv.callCount || 1 : 0, lastCall: inv.lastCallDate as string | null,
      comments, lastAction: dates.sort().at(-1) || null,
    };
  };
  const rows = base.map(inv => ({ inv, ...info(inv) }));
  const matches = (r: typeof rows[number]) => filter === 'all' ? true
    : filter === 'none' ? !r.reminders && !r.calls && !r.comments.length
    : filter === 'reminded' ? r.reminders > 0 : filter === 'called' ? r.calls > 0 : r.comments.length > 0;
  const q = search.trim().toLowerCase();
  const shown = rows.filter(r => matches(r) && (!q || [r.inv.customer?.name, r.inv.customer?.bcId, r.inv.bcId].some(x => String(x || '').toLowerCase().includes(q))));

  // KPIs sobre todas las vencidas (sin filtro)
  const amt = (list: typeof rows) => list.reduce((s, r) => s + (r.inv.amount || 0), 0);
  const acted = rows.filter(r => r.reminders || r.calls || r.comments.length);
  const none = rows.filter(r => !r.reminders && !r.calls && !r.comments.length);

  // Por cliente
  const groups = new Map<string, { key: string; name: string; no: string; rows: typeof rows }>();
  for (const r of shown) {
    const k = r.inv.customer?.bcId || String(r.inv.customerId);
    if (!groups.has(k)) groups.set(k, { key: k, name: r.inv.customer?.name || k, no: r.inv.customer?.bcId || '', rows: [] });
    groups.get(k)!.rows.push(r);
  }
  const groupList = Array.from(groups.values()).map(g => {
    const max = (f: (r: any) => string | null) => g.rows.map(f).filter(Boolean).sort().at(-1) || null;
    return {
      ...g, amount: amt(g.rows), maxDays: Math.max(...g.rows.map(r => r.inv.daysOverdue || 0)),
      reminded: g.rows.filter(r => r.reminders).length, lastReminder: max(r => r.lastReminder),
      called: g.rows.filter(r => r.calls).length, lastCall: max(r => r.lastCall),
      commented: g.rows.filter(r => r.comments.length).length, lastAction: max(r => r.lastAction),
    };
  }).sort((a, b) => b.amount - a.amount);

  const money = (v: number) => `€${(v || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date = (d: string | null) => (d ? new Date(d).toLocaleDateString(locale) : '—');
  const th = 'px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap';
  const td = 'px-3 py-2 whitespace-nowrap';
  const kpi = (label: string, n: number, v: number, tone = 'text-gray-900') => (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${tone}`}>{money(v)}</p>
      <p className="text-xs text-gray-500">{t('{n} invoices', { n })}</p>
    </div>
  );
  const filters: [ActionFilter, string][] = [['all', t('All')], ['none', t('No action yet')], ['reminded', t('Reminded')], ['called', t('With calls')], ['commented', t('With comments')]];

  if (loading && !invoices.length) return <p className="text-sm text-gray-500">{t('Loading…')}</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpi(t('Overdue (no Amazon, no confirmed date)'), rows.length, amt(rows))}
        {kpi(t('With some action'), acted.length, amt(acted), 'text-emerald-700')}
        {kpi(t('No action yet'), none.length, amt(none), 'text-red-700')}
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-sm text-gray-700 space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{t('Actions')}</p>
          <p className="flex items-center gap-2"><Send size={13} /> {t('{n} invoices reminded', { n: rows.filter(r => r.reminders).length })}</p>
          <p className="flex items-center gap-2"><PhoneCall size={13} /> {t('{n} invoices called', { n: rows.filter(r => r.calls).length })}</p>
          <p className="flex items-center gap-2"><MessageSquare size={13} /> {t('{n} invoices with comments', { n: rows.filter(r => r.comments.length).length })}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-3 flex flex-wrap items-center gap-3">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Search by customer or invoice no....')}
          className="flex-1 min-w-[220px] border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs font-semibold">
          {filters.map(([v, label]) => (
            <button key={v} onClick={() => setFilter(v)} className={`px-2.5 py-1 ${filter === v ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>{label}</button>
          ))}
        </div>
        <p className="ml-auto text-xs text-gray-500">{t('{n} customers · {m} invoices', { n: groupList.length, m: shown.length })}</p>
      </div>

      <div className="table-scroll bg-white rounded-xl border border-gray-200 [--table-offset:120px]">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className={`${th} text-left`}>{t('Customer / invoice')}</th>
              <th className={`${th} text-right`}>{t('Overdue amount')}</th>
              <th className={`${th} text-right`}>{t('Days overdue')}</th>
              <th className={`${th} text-left`}>{t('Reminders')}</th>
              <th className={`${th} text-left`}>{t('Calls')}</th>
              <th className={`${th} text-left`}>{t('Comments')}</th>
              <th className={`${th} text-left`}>{t('Last action')}</th>
            </tr>
          </thead>
          <tbody>
            {groupList.length === 0 && <tr><td colSpan={7} className="px-3 py-10 text-center text-gray-500">{t('No overdue invoices match the filters.')}</td></tr>}
            {groupList.map(g => (
              <React.Fragment key={g.key}>
                <tr onClick={() => toggle(g.key)} className="border-b border-gray-100 cursor-pointer hover:bg-gray-50 font-semibold">
                  <td className={td}><span className="inline-flex items-center gap-1">{open.has(g.key) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="text-gray-500">{g.no}</span> {g.name} <span className="text-xs font-normal text-gray-500">· {t('{n} invoices', { n: g.rows.length })}</span></span></td>
                  <td className={`${td} text-right tabular-nums`}>{money(g.amount)}</td>
                  <td className={`${td} text-right tabular-nums`}>{t('up to {n} days', { n: g.maxDays })}</td>
                  <td className={td}>{g.reminded ? <span className="text-amber-700">{t('{n} of {m} invoices', { n: g.reminded, m: g.rows.length })} · {date(g.lastReminder)}</span> : <span className="text-gray-400">—</span>}</td>
                  <td className={td}>{g.called ? <span className="text-violet-700">{t('{n} of {m} invoices', { n: g.called, m: g.rows.length })} · {date(g.lastCall)}</span> : <span className="text-gray-400">—</span>}</td>
                  <td className={td}>{g.commented ? <span className="text-sky-700">{t('{n} of {m} invoices', { n: g.commented, m: g.rows.length })}</span> : <span className="text-gray-400">—</span>}</td>
                  <td className={td}>{g.lastAction ? date(g.lastAction) : <span className="text-red-700 text-xs font-bold uppercase">{t('No action yet')}</span>}</td>
                </tr>
                {open.has(g.key) && [...g.rows].sort((a, b) => (b.inv.daysOverdue || 0) - (a.inv.daysOverdue || 0)).map(r => (
                  <tr key={r.inv.id} className="border-b border-gray-100 bg-gray-50/60 text-[13px]">
                    <td className={`${td} pl-10`}><span className="font-semibold">{r.inv.bcId}</span> <span className="text-gray-500">· {t('due {date}', { date: date(r.inv.dueDate) })}</span>{r.inv.paymentMethod ? <span className="text-gray-400"> · {r.inv.paymentMethod}</span> : null}</td>
                    <td className={`${td} text-right tabular-nums`}>{money(r.inv.amount)}{r.inv.currencyCode && r.inv.currencyCode !== 'EUR' ? <span className="text-gray-400"> {r.inv.currencyCode}</span> : null}</td>
                    <td className={`${td} text-right tabular-nums`}>{t('{n} days', { n: r.inv.daysOverdue })}</td>
                    <td className={td}>{r.reminders ? <span className="text-amber-700 font-semibold">{t('{n}× · {date}', { n: r.reminders, date: date(r.lastReminder) })}</span> : <span className="text-gray-400">—</span>}</td>
                    <td className={td}>{r.calls ? <span className="text-violet-700 font-semibold inline-flex items-center gap-1"><PhoneCall size={11} /> {t('{n}× · {date}', { n: r.calls, date: date(r.lastCall) })}</span> : <span className="text-gray-400">—</span>}</td>
                    <td className={`${td} max-w-xs`}>
                      {r.comments.length
                        ? <CommentBadge items={r.comments} onClick={() => onComment(`invoice:${r.inv.id}`, r.inv.bcId)} />
                        : <button onClick={() => onComment(`invoice:${r.inv.id}`, r.inv.bcId)} className="text-gray-400 hover:text-black" title={t('Add a comment')}><MessageSquare size={14} /></button>}
                    </td>
                    <td className={td}>{r.lastAction ? date(r.lastAction) : <span className="text-red-700 text-xs font-bold uppercase">{t('No action yet')}</span>}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">{t('Overdue invoices of every customer except Amazon, without a Confirmed Payment Date. Reminders and calls are the same as in Cashflow; comments include those of the invoice and of its Cashflow line.')}</p>
    </div>
  );
}
