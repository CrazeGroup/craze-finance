'use client';
import React, { useState, useEffect, useRef } from 'react';
import { Plus, Edit2, Trash2, RefreshCw, AlertCircle, Save, X, ChevronRight, ChevronDown, Download, Upload, Archive, Send, Calendar, Search, MailCheck, AlertTriangle, MessageSquare, PhoneCall } from 'lucide-react';
import ReminderDialog from '@/components/ReminderDialog';
import MailConnectNotice from '@/components/MailConnectNotice';
import { lineKey, matchComments } from '@/components/InvoiceComments';
import * as XLSX from 'xlsx';
import { useCompany } from '@/contexts/CompanyContext';
import { syncFromBc } from '@/lib/syncClient';
import { useT } from '@/contexts/LanguageContext';

// Periodicidad de los pagos recurrentes (RecurringPayment.frequency)
const FREQUENCIES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannual', label: 'Semiannual' },
  { value: 'annual', label: 'Annual' },
];

export default function CashflowPage() {
  const { selectedCompany } = useCompany();
  const { t, tx, locale } = useT();
  const availableCurrencies = selectedCompany === 'Craze UK' ? ['EUR', 'USD', 'GBP'] : ['EUR', 'USD', 'CHF'];

  const [entries, setEntries] = useState<any[]>([]);
  const [initialBalance, setInitialBalance] = useState<number>(0);
  const [initialBalanceDate, setInitialBalanceDate] = useState<string>('29/07/2026');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [currentCurrency, setCurrentCurrency] = useState('EUR');
  
  const [formData, setFormData] = useState({ id: '', type: '', date: '', description: '', amount: '', invoiceIds: [] as number[] });
  const [isEditing, setIsEditing] = useState(false);
  const [isEditingBalance, setIsEditingBalance] = useState(false);
  const [newBalance, setNewBalance] = useState('');
  const [filterType, setFilterType] = useState<'ALL' | 'AUTO' | 'MANUAL'>('ALL');
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  // Vista: líneas (tabla normal) o resumen por semanas / meses con el saldo de cada periodo (localStorage)
  const [periodView, setPeriodView] = useState<'none' | 'week' | 'month'>('none');
  const [openPeriods, setOpenPeriods] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { const v = localStorage.getItem('cashflow:periodView'); if (v === 'week' || v === 'month') setPeriodView(v); } catch { /* sin storage */ }
  }, []);
  const changePeriodView = (v: 'none' | 'week' | 'month') => {
    setPeriodView(v);
    setOpenPeriods({});
    try { localStorage.setItem('cashflow:periodView', v); } catch { /* sin storage */ }
  };
  const [excludeClaimed, setExcludeClaimed] = useState(false);
  // Menú del botón de reclamar en facturas ya reclamadas: otra reclamación o quitarla
  const [claimMenu, setClaimMenu] = useState<{ x: number; y: number; invoiceIds: number[]; next: number } | null>(null);
  const [callMenu, setCallMenu] = useState<{ x: number; y: number; invoiceIds: number[] } | null>(null);
  // Comentarios por factura ("invoice:<id>") o por línea (entry.id)
  const [comments, setComments] = useState<any[]>([]);
  const [commentTarget, setCommentTarget] = useState<{ key: string; label: string } | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [untilDate, setUntilDate] = useState('');
  const [selectedEntries, setSelectedEntries] = useState<any[]>([]);
  const [draggedItem, setDraggedItem] = useState<any>(null);
  const [consolidatedCurrency, setConsolidatedCurrency] = useState('EUR');
  // Mínimo del saldo consolidado (por empresa, en la divisa en que se fijó)
  const [minBalance, setMinBalance] = useState<{ amount: number; currency: string } | null>(null);
  const [editingMin, setEditingMin] = useState(false);
  const [minDraft, setMinDraft] = useState('');

  // Divisa predeterminada de la empresa: CHF en Group AG, EUR en el resto
  const homeCurrency = selectedCompany === 'CRAZE Group AG' ? 'CHF' : 'EUR';
  useEffect(() => {
    setCurrentCurrency(homeCurrency);
    setConsolidatedCurrency(homeCurrency);
    setEditingMin(false);
    fetch('/api/cashflow/min-balance', { cache: 'no-store' }).then(r => r.json()).then(setMinBalance).catch(() => setMinBalance(null));
  }, [selectedCompany]); // eslint-disable-line react-hooks/exhaustive-deps
  
  const getCurrencySymbol = (curr: string) => {
    switch (curr) {
      case 'USD': return '$';
      case 'GBP': return '£';
      case 'CHF': return 'CHF';
      case 'EUR': default: return '€';
    }
  };

  const [allBalances, setAllBalances] = useState<Record<string, number>>({});
  const [totalEurSum, setTotalEurSum] = useState<number | null>(null);
  const [exchangeRates, setExchangeRates] = useState<Record<string, number>>({ EUR: 1 });
  // Movimientos de las otras cuentas, para el saldo consolidado proyectado (aviso de mínimo)
  const [otherEntries, setOtherEntries] = useState<Record<string, any[]>>({});

  
  // Email states
  const [selectedInvoices, setSelectedInvoices] = useState<Record<number, boolean>>({});
  // Recordatorio al cliente: el mismo diálogo que en Recobros (1º normal, 2º comercial en copia, 3º aviso aseguradora)
  const [reminder, setReminder] = useState<{ customer: any; invoices: any[] } | null>(null);

  // Recurring Payments
  const [recurringModalOpen, setRecurringModalOpen] = useState(false);
  const [recurringPayments, setRecurringPayments] = useState<any[]>([]);
  const [editingRecurring, setEditingRecurring] = useState<any>(null);
  const [recurringForm, setRecurringForm] = useState({ amount: '', dayOfMonth: '1', activeFromDate: '', frequency: 'monthly', description: '' });
  const isManualRecurring = (rec: any) => String(rec?.bcCode || '').startsWith('APP-');
  const newRecurringForm = () => ({ amount: '', dayOfMonth: '1', activeFromDate: new Date().toISOString().split('T')[0], frequency: 'monthly', description: '' });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchCashflow = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/cashflow?currency=${currentCurrency}${showArchived ? '&archived=true' : ''}`);
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries || []);
        setInitialBalance(data.initialBalance || 0);
        if (data.initialBalanceDate) {
          setInitialBalanceDate(new Date(data.initialBalanceDate).toLocaleDateString('es-ES'));
        }
      }
      
      // Fetch all balances and exchange rates
      const [balRes, rateRes] = await Promise.all([
        fetch('/api/cashflow/balances'),
        fetch('https://api.exchangerate-api.com/v4/latest/EUR')
      ]);
      
      if (balRes.ok) {
        const balances = await balRes.json();
        setAllBalances(balances);

        const others = Object.keys(balances).filter(c => c !== currentCurrency);
        const otherData = await Promise.all(others.map(c =>
          fetch(`/api/cashflow?currency=${c}${showArchived ? '&archived=true' : ''}`).then(r => r.ok ? r.json() : null).catch(() => null)));
        setOtherEntries(Object.fromEntries(others.map((c, i) => [c, otherData[i]?.entries || []])));
        
        if (rateRes.ok) {
          const ratesData = await rateRes.json();
          const rates = { ...ratesData.rates, EUR: 1 };
          setExchangeRates(rates);
          
          let totalEur = balances['EUR'] || 0;
          if (balances['USD'] && rates['USD']) totalEur += balances['USD'] / rates['USD'];
          if (balances['CHF'] && rates['CHF']) totalEur += balances['CHF'] / rates['CHF'];
          if (balances['GBP'] && rates['GBP']) totalEur += balances['GBP'] / rates['GBP'];
          
          setTotalEurSum(totalEur);
        }
      }
    } catch (error) {
      console.error('Failed to fetch cashflow:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCashflow();
  }, [showArchived, currentCurrency, selectedCompany]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch('/api/cashflow/comments', { cache: 'no-store' }).then(r => r.json()).then(d => setComments(Array.isArray(d) ? d : [])).catch(() => setComments([]));
  }, [selectedCompany]);

  const commentsFor = (key: string) => matchComments(comments, key);

  // Comentarios de línea guardados con la clave antigua (id de la línea = cliente + fecha): pasan a las facturas de la
  // línea ("invoices:<ids>") para verse también en Recobros y no perderse si la línea cambia de fecha
  useEffect(() => {
    const old = comments.filter(c => c.targetKey.startsWith('auto-transfer-'));
    if (!old.length || !entries.length) return;
    for (const c of old) {
      let entry = entries.find((e: any) => e.id === c.targetKey && e.invoices?.length);
      if (!entry) {
        const sameCustomer = entries.filter((e: any) => e.invoices?.length && c.targetKey.startsWith(`auto-transfer-${e.customerName || e.description}-`));
        if (sameCustomer.length === 1) entry = sameCustomer[0];
      }
      if (!entry) continue;
      const key = lineKey(entry);
      fetch('/api/cashflow/comments', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id, targetKey: key }) })
        .then(r => { if (r.ok) setComments(prev => prev.map(x => x.id === c.id ? { ...x, targetKey: key } : x)); }).catch(() => {});
    }
  }, [comments.length, entries]); // eslint-disable-line react-hooks/exhaustive-deps
  const addComment = async () => {
    if (!commentTarget || !commentDraft.trim()) return;
    try {
      const res = await fetch('/api/cashflow/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKey: commentTarget.key, text: commentDraft, label: commentTarget.label })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setComments(prev => [...prev, data]);
      setCommentDraft('');
    } catch (err: any) {
      alert(t('Could not save the comment: {error}', { error: tx(String(err.message || err)) }));
    }
  };
  const deleteComment = async (id: number) => {
    if (!confirm(t('Delete this comment?'))) return;
    const res = await fetch(`/api/cashflow/comments?id=${id}`, { method: 'DELETE' });
    if (res.ok) setComments(prev => prev.filter(c => c.id !== id));
    else alert(t('Could not delete the comment'));
  };
  const openComments = (e: React.MouseEvent, key: string, label: string) => {
    e.stopPropagation();
    setCommentDraft('');
    setCommentTarget({ key, label });
  };

  const saveMinBalance = async () => {
    const amount = minDraft.trim() === '' ? null : parseFloat(minDraft.replace(/\./g, '').replace(',', '.'));
    if (amount !== null && !isFinite(amount)) { alert(t('Invalid amount')); return; }
    const res = await fetch('/api/cashflow/min-balance', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, currency: consolidatedCurrency }),
    });
    const d = await res.json();
    if (!res.ok) { alert(d.error ? tx(d.error) : t('Could not save the minimum')); return; }
    setMinBalance(d);
    setEditingMin(false);
  };

  const handleSync = async () => {
    try {
      setSyncing(true);
      // Trigger a BC sync to get the latest invoices
      await syncFromBc(selectedCompany);
      // Then refetch the cashflow
      await fetchCashflow();
    } catch (error) {
      console.error('Failed to sync:', error);
    } finally {
      setSyncing(false);
    }
  };

  const openAddModal = () => {
    setFormData({ id: '', type: 'manual', date: new Date().toISOString().split('T')[0], description: '', amount: '', invoiceIds: [] });
    setIsEditing(false);
    setIsModalOpen(true);
  };

  const openEditModal = (entry: any) => {
    if (entry.isManual) {
      setFormData({
        id: entry.dbId,
        type: 'manual',
        date: new Date(entry.date).toISOString().split('T')[0],
        description: entry.description,
        amount: entry.amount.toString(),
        invoiceIds: []
      });
    } else {
      // Auto entry: only date is editable
      setFormData({
        id: '',
        type: 'invoice-date',
        date: new Date(entry.date).toISOString().split('T')[0],
        description: entry.description,
        amount: entry.amount.toString(),
        invoiceIds: entry.invoices ? entry.invoices.map((i: any) => i.id) : (entry.id ? [entry.id] : [])
      });
    }
    setIsEditing(true);
    setIsModalOpen(true);
  };

  const toggleGroup = (id: string) => {
    setExpandedGroups(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const saveInitialBalance = async () => {
    try {
      await fetch('/api/cashflow', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'config', amount: newBalance, currency: currentCurrency })
      });
      setIsEditingBalance(false);
      fetchCashflow();
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('Are you sure you want to delete this manual line?'))) return;
    try {
      await fetch(`/api/cashflow?id=${id}`, { method: 'DELETE' });
      setSelectedEntries(prev => prev.filter(e => e.dbId !== parseInt(id)));
      fetchCashflow();
    } catch (error) {
      console.error('Failed to delete:', error);
    }
  };

  const handleBulkDelete = async () => {
    const manualIds = selectedEntries.filter(e => e.isManual).map(e => e.dbId);
    if (manualIds.length === 0) {
      if (confirm(t('You have not selected any manual line. Do you want to delete ALL manual lines?'))) {
        try {
          await fetch(`/api/cashflow?clearAll=true`, { method: 'DELETE' });
          setSelectedEntries(prev => prev.filter(e => !e.isManual));
          fetchCashflow();
        } catch(e) {
          console.error(e);
        }
      }
      return;
    }
    
    if (!confirm(t('Delete the {n} selected manual lines?', { n: manualIds.length }))) return;
    try {
      await fetch(`/api/cashflow?ids=${manualIds.join(',')}`, {
        method: 'DELETE'
      });
      setSelectedEntries(prev => prev.filter(e => !manualIds.includes(e.dbId)));
      fetchCashflow();
    } catch(e) {
      console.error(e);
    }
  };

  const handleBulkArchive = async () => {
    if (selectedEntries.length === 0) return;
    const isArchiving = !selectedEntries[0].isArchived; 
    if (!confirm(isArchiving ? t('Archive the {n} selected lines?', { n: selectedEntries.length }) : t('Restore the {n} selected lines?', { n: selectedEntries.length }))) return;
    
    const manualIds = selectedEntries.filter(e => e.isManual).map(e => e.dbId);
    const invoiceIds = selectedEntries.filter(e => !e.isManual).flatMap(e => e.invoices ? e.invoices.map((i:any)=>i.id) : [e.id]);
    
    try {
      await fetch(`/api/cashflow`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'archive_multiple',
          isArchived: isArchiving,
          manualIds,
          invoiceIds
        })
      });
      setSelectedEntries([]);
      fetchCashflow();
    } catch(e) {
      console.error(e);
    }
  };

  const handleArchive = async (entry: any) => {
    if (!confirm(entry.isArchived ? t('Restore this line to the active Cashflow?') : t('Are you sure you want to archive this line and remove it from the Cashflow?'))) return;
    try {
      await fetch(`/api/cashflow`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'archive',
          type: entry.isManual ? 'manual' : 'auto',
          isArchived: !entry.isArchived,
          id: entry.isManual ? entry.dbId : undefined,
          invoiceIds: entry.isManual ? undefined : (entry.invoices ? entry.invoices.map((i:any)=>i.id) : [entry.id])
        })
      });
      fetchCashflow();
    } catch(e) {
      console.error(e);
    }
  };

  const handleDragStart = (e: React.DragEvent, entry: any) => {
    setDraggedItem(entry);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', entry.id);
  };

  const handleDrop = async (e: React.DragEvent, targetEntry: any) => {
    e.preventDefault();
    if (!draggedItem || draggedItem.id === targetEntry.id) return;
    
    const confirmMsg = t('Move "{from}" to the date of "{to}" ({date})?', { from: tx(draggedItem.description), to: tx(targetEntry.description), date: new Date(targetEntry.date).toLocaleDateString(locale) });
    if (!confirm(confirmMsg)) return;

    try {
      const payload = {
        type: draggedItem.isManual ? 'manual' : 'invoice-date',
        id: draggedItem.isManual ? draggedItem.dbId : undefined,
        invoiceIds: draggedItem.isManual ? undefined : (draggedItem.invoices ? draggedItem.invoices.map((i:any)=>i.id) : [draggedItem.id]),
        date: new Date(targetEntry.date).toISOString().split('T')[0],
        amount: draggedItem.amount,
        description: draggedItem.description
      };
      
      await fetch('/api/cashflow', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      fetchCashflow();
    } catch(error) {
      console.error('Error in drag and drop:', error);
    } finally {
      setDraggedItem(null);
    }
  };

  const toggleInvoiceSelect = (invoiceId: number) => {
    setSelectedInvoices(prev => ({ ...prev, [invoiceId]: !prev[invoiceId] }));
  };

  // Facturas marcadas del cliente; sin ninguna marcada, todas las de la línea
  const pickInvoices = (entry: any) => {
    const sel = entry.invoices?.filter((inv: any) => selectedInvoices[inv.id]) || [];
    return sel.length ? sel : (entry.invoices || []);
  };

  const openEmailModal = (entry: any) => {
    if (!entry.customer) return;
    const selectedList = pickInvoices(entry);
    if (selectedList.length === 0) return;
    setReminder({ customer: entry.customer, invoices: selectedList });
  };

  // Exporta lo que se ve en pantalla (divisa, filtro y archivadas): saldo inicial + una fila por línea; en la segunda
  // pestaña, lo mismo con el detalle de facturas de los cobros agrupados (vencimiento, reclamaciones y comentarios)
  const handleExportCashflow = () => {
    const visible = visibleEntries;
    const [d, m, y] = initialBalanceDate.split('/').map(Number);
    const initialDate = y && m && d ? new Date(Date.UTC(y, m - 1, d)) : initialBalanceDate;
    // Formato de fechas e importes por columna
    const sheet = (rows: any[][], dateCols: number[], numCols: number[], cols: number[]) => {
      const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      for (let r = 1; r <= range.e.r; r++) {
        for (const c of dateCols) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          if (cell && cell.t === 'd') cell.z = 'dd/mm/yyyy';
        }
        for (const c of numCols) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          if (cell && cell.t === 'n') cell.z = '#,##0.00';
        }
      }
      ws['!cols'] = cols.map(wch => ({ wch }));
      return ws;
    };

    const ws = sheet([
      [t('Date'), t('Description'), t('Amount'), t('Balance')],
      [initialDate, t('Opening Balance'), null, initialBalance],
      ...visible.map(e => [new Date(e.date), e.description, e.amount, e.balance]),
    ], [0], [2, 3], [12, 50, 16, 16]);

    const commentText = (key: string) => commentsFor(key)
      .map((c: any) => `${c.text} (${[c.author, new Date(c.createdAt).toLocaleDateString(locale)].filter(Boolean).join(', ')})`).join(' | ');
    const claimText = (inv: any) => { const n = claimCountOf(inv); return n > 1 ? t('Claim no. {n}', { n }) : n ? t('Claimed') : ''; };
    const detail: any[][] = [
      [t('Date'), t('Description'), t('Invoice'), t('Status'), t('Due Date'), t('Amount'), t('Balance'), t('Claim'), t('Last claim'), t('Comments')],
      [initialDate, t('Opening Balance'), '', '', null, null, initialBalance, '', null, ''],
    ];
    const levels: number[] = [0, 0];
    for (const e of visible) {
      const invoices: any[] = e.invoices || [];
      const claimed = invoices.filter((i: any) => i.lastReminderDate);
      detail.push([
        new Date(e.date), e.description, invoices.length ? t('{n} invoices', { n: invoices.length }) : '', '', null, e.amount, e.balance,
        claimed.length ? t('{claimed}/{total} claimed', { claimed: claimed.length, total: invoices.length }) : '', null, commentText(lineKey(e)),
      ]);
      levels.push(0);
      for (const inv of invoices) {
        detail.push([
          new Date(inv.cashflowDate || inv.confirmedPaymentDate || inv.dueDate), e.description, inv.bcId, inv.status,
          inv.dueDate ? new Date(inv.dueDate) : null, inv.amount, null, claimText(inv),
          inv.lastReminderDate ? new Date(inv.lastReminderDate) : null, commentText(`invoice:${inv.id}`),
        ]);
        levels.push(1);
      }
    }
    const wsDetail = sheet(detail, [0, 4, 8], [5, 6], [12, 40, 22, 10, 12, 16, 16, 18, 16, 60]);
    // Las facturas quedan agrupadas (esquema de Excel) bajo su cobro
    wsDetail['!rows'] = levels.map(level => (level ? { level } : {}));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Cashflow ${currentCurrency}`);
    XLSX.utils.book_append_sheet(wb, wsDetail, t('Invoice detail'));
    const today = new Date().toISOString().substring(0, 10);
    XLSX.writeFile(wb, `Cashflow_${selectedCompany}_${currentCurrency}_${today}.xlsx`.replace(/\s+/g, '_'));
  };

  const handleExportTemplate = () => {
    const ws = XLSX.utils.json_to_sheet([
      { fecha: '2026-08-01', supplier: t('Example Rent Payment'), amount: -1500.50 }
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, 'Cashflow_Template.xlsx');
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = event.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json<any>(sheet);

        const newEntries = json.map(row => {
          // Si Excel convierte la fecha a número de serie (ej. 45000), habría que parsearla, pero asumiendo YYYY-MM-DD:
          let dateStr = row.fecha;
          if (typeof dateStr === 'number') {
             // Excel date to JS date
             dateStr = new Date(Math.round((dateStr - 25569)*86400*1000)).toISOString().split('T')[0];
          }
          return {
            date: dateStr,
            description: row.supplier,
            amount: parseFloat(row.amount)
          };
        }).filter(r => r.date && r.description && !isNaN(r.amount));

        if (newEntries.length === 0) {
          alert(t('The file does not have the correct format or is empty. Make sure it has the columns: fecha, supplier, amount.'));
          return;
        }

        const entriesWithCurrency = newEntries.map(e => ({ ...e, currency: currentCurrency }));

        setSyncing(true);
        await fetch('/api/cashflow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entriesWithCurrency)
        });
        
        alert(t('{n} records have been imported into the {currency} account!', { n: newEntries.length, currency: currentCurrency }));
        fetchCashflow();
      } catch (err) {
        console.error('Failed to import Excel:', err);
        alert(t('Error importing the file.'));
      } finally {
        setSyncing(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Parse formula for amount (e.g., 100+50)
    let parsedAmount = formData.amount;
    try {
      if (/^[0-9+\-*/().\s]+$/.test(parsedAmount)) {
        parsedAmount = Function(`'use strict'; return (${parsedAmount})`)().toString();
      }
    } catch(err) {
      console.warn("Invalid math expression", err);
    }

    try {
      const payload = { ...formData, amount: parsedAmount, currency: currentCurrency };
      if (isEditing) {
        await fetch('/api/cashflow', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        await fetch('/api/cashflow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
      setIsModalOpen(false);
      fetchCashflow();
    } catch (error) {
      console.error('Failed to save:', error);
    }
  };

  const openRecurringModal = async () => {
    setRecurringModalOpen(true);
    fetchRecurringPayments();
  };

  const fetchRecurringPayments = async () => {
    try {
      const res = await fetch('/api/cashflow/recurring');
      if (res.ok) setRecurringPayments(await res.json());
    } catch (error) { console.error(error); }
  };

  const handleSaveRecurring = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const isNew = !editingRecurring.id;
      const payload = {
        id: editingRecurring.id,
        description: recurringForm.description,
        isActive: true,
        amount: recurringForm.amount,
        dayOfMonth: recurringForm.dayOfMonth,
        activeFromDate: recurringForm.activeFromDate,
        frequency: recurringForm.frequency,
        currencyCode: currentCurrency
      };
      const res = await fetch('/api/cashflow/recurring', {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) { const err = (await res.json().catch(() => ({}))).error; alert(err ? tx(err) : t('Could not save')); return; }
      setEditingRecurring(null);
      fetchRecurringPayments();
      fetchCashflow();
    } catch (err) { console.error(err); }
  };

  const handleRemoveRecurring = async (rec: any) => {
    try {
      // Los manuales se borran; los de BC se quedan en la lista como no añadidos
      if (isManualRecurring(rec)) {
        if (!confirm(t('Delete the recurring payment "{name}"?', { name: rec.description }))) return;
        await fetch(`/api/cashflow/recurring?id=${rec.id}`, { method: 'DELETE' });
      } else await fetch('/api/cashflow/recurring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rec.id, isActive: false })
      });
      fetchRecurringPayments();
      fetchCashflow();
    } catch (err) { console.error(err); }
  };

  // Facturas reclamadas al cliente: lastReminderDate (recordatorio enviado desde Cashflow o Recobros, o marca manual)
  const claimedInvoices = (entry: any) => (entry.invoices || []).filter((i: any) => i.lastReminderDate);
  const daysSince = (date: string) => Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
  const claimLabel = (date: string) => {
    const d = daysSince(date);
    return `${new Date(date).toLocaleDateString(locale)} · ${d === 0 ? t('today') : d === 1 ? t('1 day ago') : t('{n} days ago', { n: d })}`;
  };

  // Nº de reclamaciones (las reclamadas antes de existir el contador cuentan como 1)
  const claimCountOf = (inv: any) => inv.lastReminderDate ? Math.max(inv.claimCount || 0, 1) : 0;

  // Sin reclamar: se marca directamente; ya reclamada: menú con la siguiente reclamación o quitarla
  const onClaimClick = (e: React.MouseEvent, invoices: any[]) => {
    e.stopPropagation();
    const ids = invoices.map((i: any) => i.id);
    const maxCount = Math.max(0, ...invoices.map(claimCountOf));
    if (maxCount === 0) { toggleClaim(ids, true); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setClaimMenu({ x: Math.max(8, rect.right - 224), y: rect.bottom + 4, invoiceIds: ids, next: maxCount + 1 });
  };

  const toggleClaim = async (invoiceIds: number[], claimed: boolean) => {
    setClaimMenu(null);
    try {
      const res = await fetch('/api/invoices/claim', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceIds, claimed })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // Se actualiza en local para no recargar todo el cashflow
      const updated = new Map<number, any>((data.invoices || []).map((i: any) => [i.id, i]));
      setEntries(prev => prev.map(e => e.invoices?.some((i: any) => updated.has(i.id))
        ? { ...e, invoices: e.invoices.map((i: any) => updated.has(i.id) ? { ...i, ...updated.get(i.id) } : i) }
        : e));
    } catch (err: any) {
      alert(t('Could not save the mark: {error}', { error: tx(String(err.message || err)) }));
    }
  };

  // Marca "Llamado": cliente llamado por teléfono para reclamar (Invoice.lastCallDate / callCount, se ve también en Recobros)
  const calledInvoices = (entry: any) => (entry.invoices || []).filter((i: any) => i.lastCallDate);
  const onCallClick = (e: React.MouseEvent, invoices: any[]) => {
    e.stopPropagation();
    const ids = invoices.map((i: any) => i.id);
    if (!invoices.some((i: any) => i.lastCallDate)) { toggleCall(ids, true); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCallMenu({ x: Math.max(8, rect.right - 224), y: rect.bottom + 4, invoiceIds: ids });
  };
  const toggleCall = async (invoiceIds: number[], called: boolean) => {
    setCallMenu(null);
    try {
      const res = await fetch('/api/invoices/call', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceIds, called })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const updated = new Map<number, any>((data.invoices || []).map((i: any) => [i.id, i]));
      setEntries(prev => prev.map(e => e.invoices?.some((i: any) => updated.has(i.id))
        ? { ...e, invoices: e.invoices.map((i: any) => updated.has(i.id) ? { ...i, ...updated.get(i.id) } : i) }
        : e));
    } catch (err: any) {
      alert(t('Could not save the call: {error}', { error: tx(String(err.message || err)) }));
    }
  };
  const callText = (count: number) => count > 1 ? t('Called {n}×', { n: count }) : t('Called');

  // Con "Excluir reclamadas" el importe de las facturas reclamadas no cuenta en el saldo acumulado
  let runningBalance = initialBalance;
  const balancedEntries = entries.map(e => {
    const excluded = excludeClaimed ? claimedInvoices(e).reduce((acc: number, i: any) => acc + i.amount, 0) : 0;
    runningBalance += e.amount - excluded;
    return { ...e, excludedAmount: excluded, balance: runningBalance };
  });

  // Mínimo de saldo: importes pasados a la divisa del mínimo con los tipos del día (base EUR)
  const toMinCurrency = (value: number, from: string) =>
    minBalance ? (value / (exchangeRates[from] || 1)) * (exchangeRates[minBalance.currency] || 1) : value;
  // Saldo de otra cuenta a una fecha: saldo actual + sus movimientos hasta ese día
  const otherBalanceAt = (curr: string, date: string) => {
    const t = new Date(date).getTime();
    return (otherEntries[curr] || []).reduce((acc: number, e: any) => {
      if (new Date(e.date).getTime() > t) return acc;
      const excluded = excludeClaimed ? claimedInvoices(e).reduce((a: number, i: any) => a + i.amount, 0) : 0;
      return acc + e.amount - excluded;
    }, allBalances[curr] || 0);
  };
  // Saldo consolidado (todas las cuentas) en la divisa del mínimo tras cada movimiento de esta cuenta
  const consolidatedAt = (entry: any) => toMinCurrency(entry.balance, currentCurrency) +
    Object.keys(allBalances).filter(c => c !== currentCurrency).reduce((acc, c) => acc + toMinCurrency(otherBalanceAt(c, entry.date), c), 0);
  const consolidatedByEntry = new Map<any, number>(minBalance ? balancedEntries.map(e => [e, consolidatedAt(e)]) : []);
  const belowMin = (entry: any) => !!minBalance && (consolidatedByEntry.get(entry) ?? Infinity) < minBalance.amount;
  const consolidatedInMin = totalEurSum !== null && minBalance ? totalEurSum * (exchangeRates[minBalance.currency] || 1) : null;
  const consolidatedBelowMin = consolidatedInMin !== null && minBalance !== null && consolidatedInMin < minBalance.amount;
  const firstBelowMin = minBalance ? balancedEntries.find(e => belowMin(e)) : undefined;
  const belowMinCount = minBalance ? balancedEntries.filter(e => belowMin(e)).length : 0;
  const fmtMoney = (v: number, curr: string) => `${getCurrencySymbol(curr)}${v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Líneas visibles: filtro de tipo + buscador de texto (descripción, cliente y nº de las facturas agrupadas)
  const searchTerm = search.trim().toLowerCase();
  const visibleEntries = balancedEntries.filter(e =>
    (filterType === 'ALL' || (filterType === 'AUTO' && !e.isManual) || (filterType === 'MANUAL' && e.isManual)) &&
    (!untilDate || new Date(e.date).toISOString().substring(0, 10) <= untilDate) &&
    (!searchTerm || [e.description, e.customer?.name, ...(e.invoices || []).map((i: any) => i.bcId)]
      .some(t => t && String(t).toLowerCase().includes(searchTerm)))
  );

  // Resumen por periodo (semana lunes-domingo o mes) de las líneas visibles: entradas, salidas, neto,
  // saldo más bajo y saldo al cierre (el de la última línea del periodo)
  const periodOf = (date: string) => {
    const d = new Date(date);
    if (periodView === 'month') {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return { key, label: d.toLocaleDateString(locale, { month: 'long', year: 'numeric' }) };
    }
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    // Nº de semana ISO (el jueves de la semana decide el año)
    const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
    const week = Math.ceil(((thursday.getTime() - new Date(thursday.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7);
    const fmt = (x: Date) => x.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
    return {
      key: `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`,
      label: t('Week {n} · {from} – {to}', { n: week, from: fmt(monday), to: `${fmt(sunday)}/${sunday.getFullYear()}` }),
    };
  };
  const periods: { key: string; label: string; entries: any[]; inflow: number; outflow: number; lowest: number; closing: number; belowMin: number }[] = [];
  if (periodView !== 'none') {
    for (const e of visibleEntries) {
      const { key, label } = periodOf(e.date);
      let p = periods[periods.length - 1];
      if (!p || p.key !== key) { p = { key, label, entries: [], inflow: 0, outflow: 0, lowest: Infinity, closing: 0, belowMin: 0 }; periods.push(p); }
      const amount = e.amount - (e.excludedAmount || 0);
      if (amount >= 0) p.inflow += amount; else p.outflow += amount;
      p.entries.push(e);
      p.lowest = Math.min(p.lowest, e.balance);
      p.closing = e.balance;
      if (belowMin(e)) p.belowMin++;
    }
  }
  const money = (v: number) => `${getCurrencySymbol(currentCurrency)}${v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const balanceClass = (v: number) => v <= -1000000 ? 'text-purple-600 font-black' : v < 0 ? 'text-red-600 font-bold' : 'text-emerald-600 font-bold';

  // Total reclamado de las líneas visibles (lo que sale del saldo con "Excluir reclamadas")
  const claimedTotal = visibleEntries.reduce((acc, e) => acc + claimedInvoices(e).reduce((a: number, i: any) => a + i.amount, 0), 0);

  // Subtotal de lo marcado: líneas seleccionadas + facturas sueltas marcadas dentro de grupos no seleccionados
  const selectedIds = new Set(selectedEntries.map(e => e.id));
  const looseInvoices = entries
    .filter(e => e.isGroup && !selectedIds.has(e.id))
    .flatMap(e => (e.invoices || []).filter((i: any) => selectedInvoices[i.id]));
  const selectionCount = selectedEntries.length + looseInvoices.length;
  const selectionTotal = selectedEntries.reduce((acc, e) => acc + (e.amount || 0), 0) + looseInvoices.reduce((acc: number, i: any) => acc + (i.amount || 0), 0);

  return (
    <div className="flex-1 px-6 py-8 w-full">
        <MailConnectNotice />
        <div className="flex flex-wrap justify-between items-end gap-4 mb-8 sticky top-0 z-10 bg-gray-50/95 backdrop-blur-md pb-4 pt-6 -mt-6 border-b border-gray-200">
          <div>
            <h1 className="text-4xl font-black text-black mb-2">
              {t('Cash Forecast (Cashflow)')}
            </h1>
            <div className="flex flex-wrap items-center gap-4">
              <p className="text-gray-900 font-bold text-sm whitespace-nowrap">{t('Cash flow based on collections and manual entries.')}</p>
              <div className="flex bg-white rounded-lg p-1 border border-gray-200 items-center whitespace-nowrap">
                <button onClick={() => setFilterType('ALL')} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filterType === 'ALL' ? 'bg-gray-200 text-gray-900' : 'text-gray-900 font-bold hover:text-gray-900 hover:bg-gray-50'}`}>{t('All lines')}</button>
                <button onClick={() => setFilterType('AUTO')} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filterType === 'AUTO' ? 'bg-teal-500/30 text-teal-700 font-bold' : 'text-gray-900 font-bold hover:text-gray-900 hover:bg-gray-50'}`}>{t('Automatic lines')}</button>
                <button onClick={() => setFilterType('MANUAL')} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filterType === 'MANUAL' ? 'bg-blue-500/30 text-blue-700 font-bold' : 'text-gray-900 font-bold hover:text-gray-900 hover:bg-gray-50'}`}>{t('Manual lines')}</button>
                <div className="w-px h-4 bg-white/10 mx-2"></div>
                <button onClick={() => setShowArchived(!showArchived)} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${showArchived ? 'bg-purple-500/30 text-purple-700 font-bold border border-purple-500/50' : 'text-gray-900 font-bold hover:text-purple-700 font-bold hover:bg-purple-500/10'}`}>
                  {showArchived ? t('Hide Archived') : t('Show Archived')}
                </button>
              </div>
              <div className="flex bg-white rounded-lg p-1 border border-gray-200 items-center whitespace-nowrap" title={t('Group the cashflow by week or month to see the balance of each period')}>
                {([['none', t('By line')], ['week', t('By week')], ['month', t('By month')]] as const).map(([v, label]) => (
                  <button key={v} onClick={() => changePeriodView(v)} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${periodView === v ? 'bg-indigo-500/20 text-indigo-800 font-bold' : 'text-gray-900 font-bold hover:bg-gray-50'}`}>{label}</button>
                ))}
              </div>
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t('Search (e.g. Amazon)...')}
                  className="w-56 bg-white border border-gray-200 rounded-lg pl-8 pr-7 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
                />
                {search && (
                  <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-900" title={t('Clear search')}>
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className={`flex items-center gap-2 bg-white border rounded-lg px-3 py-1 text-sm whitespace-nowrap ${untilDate ? 'border-teal-500 ring-1 ring-teal-500' : 'border-gray-200'}`} title={t('Show only lines up to this date (inclusive)')}>
                <Calendar size={14} className="text-gray-400" />
                <span className="text-gray-700 font-semibold">{t('Until')}</span>
                <input type="date" value={untilDate} onChange={e => setUntilDate(e.target.value)} className="bg-transparent text-gray-900 focus:outline-none" />
                {untilDate && (
                  <button onClick={() => setUntilDate('')} className="text-gray-400 hover:text-gray-900" title={t('Remove date filter')}>
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input 
              type="file" 
              accept=".xlsx, .xls, .csv" 
              className="hidden" 
              ref={fileInputRef}
              onChange={handleImport}
            />
            <button 
              onClick={handleBulkDelete}
              className="flex items-center gap-2 whitespace-nowrap px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-gray-700 font-bold rounded-lg border border-red-500/20 transition-colors text-sm"
              title={selectedEntries.filter(e => e.isManual).length > 0 ? t('Delete Selected Manual Lines') : t('Delete All (Manual)')}
            >
              <Trash2 size={16} /> {selectedEntries.filter(e => e.isManual).length > 0 ? t('Delete ({n})', { n: selectedEntries.filter(e => e.isManual).length }) : t('Delete All')}
            </button>
            {selectedEntries.length > 0 && (
              <button 
                onClick={handleBulkArchive}
                className="flex items-center gap-2 whitespace-nowrap px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 text-purple-700 font-bold rounded-lg border border-purple-500/20 transition-colors text-sm"
                title={t('Archive Selected')}
              >
                <Archive size={16} /> {t('Archive ({n})', { n: selectedEntries.length })}
              </button>
            )}
            <button 
              onClick={handleExportCashflow}
              disabled={loading}
              className="flex items-center gap-2 whitespace-nowrap px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-gray-900 font-bold rounded-lg border border-emerald-500/20 transition-colors text-sm"
              title={t('Export the on-screen cashflow to Excel')}
            >
              <Download size={16} /> {t('Export Excel')}
            </button>
            <button 
              onClick={handleExportTemplate}
              className="flex items-center gap-2 whitespace-nowrap px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-gray-900 font-bold rounded-lg border border-emerald-500/20 transition-colors text-sm"
              title={t('Download Excel Template')}
            >
              <Download size={16} /> {t('Template')}
            </button>
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={syncing}
              className="flex items-center gap-2 whitespace-nowrap px-4 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-black rounded-lg border border-blue-500/20 transition-colors text-sm"
              title={t('Import Excel')}
            >
              <Upload size={16} className={syncing ? "animate-pulse" : ""} /> {t('Import Excel')}
            </button>
            
            <button 
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-2 whitespace-nowrap px-4 py-2 bg-gray-50 hover:bg-gray-200 text-gray-900 rounded-lg border border-gray-200 transition-colors text-sm"
            >
              <RefreshCw size={16} className={syncing ? "animate-spin text-black" : "text-gray-900 font-bold"} />
              {syncing ? t('Syncing...') : t('Refresh Local')}
            </button>
            <button 
              onClick={openAddModal}
              className="flex items-center gap-2 whitespace-nowrap px-4 py-2 bg-black hover:bg-gray-800 text-white rounded-lg shadow-lg font-medium transition-all text-sm"
            >
              <Plus size={16} /> {t('Add Line')}
            </button>
            <button 
              onClick={openRecurringModal}
              className="flex items-center gap-2 whitespace-nowrap px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg shadow-lg font-medium transition-all text-sm"
            >
              <Calendar size={16} /> {t('Configure Recurring')}
            </button>
          </div>
        </div>

        {/* Currency Tabs & Total */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div className="flex gap-2">
            {availableCurrencies.map(curr => (
              <button
                key={curr}
                onClick={() => setCurrentCurrency(curr)}
                className={`px-6 py-2 rounded-lg font-bold transition-all border ${
                  currentCurrency === curr 
                    ? 'bg-black text-white border-black shadow-lg' 
                    : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {t('Account {currency}', { currency: curr })}
                {allBalances[curr] !== undefined && (
                  <span className={`ml-2 px-2 py-0.5 rounded text-xs font-black ${currentCurrency === curr ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-700'}`}>
                    {getCurrencySymbol(curr)}{allBalances[curr].toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                )}
              </button>
            ))}
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col items-end gap-1">
            <button onClick={() => setExcludeClaimed(!excludeClaimed)} className={`flex items-center gap-2 whitespace-nowrap px-4 py-2 rounded-lg border text-sm font-bold transition-all ${excludeClaimed ? 'bg-amber-500/20 text-amber-800 border-amber-500/50' : 'bg-white text-gray-900 border-gray-200 hover:bg-amber-500/10 hover:text-amber-800'}`} title={t('Include or exclude from the balance the receipts already claimed from the customer')}>
              <MailCheck size={16} /> {excludeClaimed ? t('Claimed excluded from balance') : t('Exclude claimed from balance')}
            </button>
            <span className={`text-xs font-bold whitespace-nowrap ${excludeClaimed ? 'text-amber-700' : 'text-gray-500'}`}>
              {excludeClaimed ? t('Total outside the balance:') + ' −' : t('Total claimed:') + ' '}{getCurrencySymbol(currentCurrency)}{claimedTotal.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          {totalEurSum !== null && (
            <div className="bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-lg flex items-center gap-3">
              <span className="text-emerald-800 font-bold text-sm uppercase tracking-wider whitespace-nowrap">{t('Consolidated Balance')}</span>
              <select 
                value={consolidatedCurrency} 
                onChange={(e) => setConsolidatedCurrency(e.target.value)}
                className="bg-emerald-500/20 text-emerald-900 border-none rounded p-1 text-xs font-bold outline-none cursor-pointer"
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="CHF">CHF</option>
                <option value="GBP">GBP</option>
              </select>
              <span className="text-emerald-700 font-black text-lg">
                {getCurrencySymbol(consolidatedCurrency)}
                {(totalEurSum * (exchangeRates[consolidatedCurrency] || 1)).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
          <div className={`px-4 py-2 rounded-lg border flex items-center gap-3 ${consolidatedBelowMin ? 'bg-red-500/10 border-red-500/40' : 'bg-white border-gray-200'}`}>
            <span className={`font-bold text-sm uppercase tracking-wider whitespace-nowrap ${consolidatedBelowMin ? 'text-red-800' : 'text-gray-700'}`}>{t('Min. Consolidated Balance')}</span>
            {editingMin ? (
              <>
                <input autoFocus value={minDraft} onChange={e => setMinDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveMinBalance(); if (e.key === 'Escape') setEditingMin(false); }}
                  placeholder={t('Amount in {currency} (empty = no minimum)', { currency: consolidatedCurrency })} className="w-56 border border-gray-300 rounded px-2 py-1 text-sm" />
                <button onClick={saveMinBalance} className="p-1.5 text-emerald-700 hover:bg-emerald-500/10 rounded" title={t('Save')}><Save size={16} /></button>
                <button onClick={() => setEditingMin(false)} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded" title={t('Cancel')}><X size={16} /></button>
              </>
            ) : (
              <>
                <span className={`font-black text-lg ${consolidatedBelowMin ? 'text-red-700' : 'text-gray-900'}`}>
                  {minBalance ? fmtMoney(minBalance.amount, minBalance.currency) : '—'}
                </span>
                <button onClick={() => { setMinDraft(minBalance ? String(minBalance.amount).replace('.', ',') : ''); setEditingMin(true); }}
                  className="p-1.5 text-gray-500 hover:text-black hover:bg-gray-100 rounded" title={t('Set the minimum (in {currency}, the currency of the consolidated balance)', { currency: consolidatedCurrency })}>
                  <Edit2 size={14} />
                </button>
              </>
            )}
          </div>
          </div>
        </div>

        {minBalance && (consolidatedBelowMin || firstBelowMin) && (
          <div className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              {consolidatedBelowMin && consolidatedInMin !== null && (
                <p className="font-bold">{t('The consolidated balance ({balance}) is below the minimum of {min}.', { balance: fmtMoney(consolidatedInMin, minBalance.currency), min: fmtMoney(minBalance.amount, minBalance.currency) })}</p>
              )}
              {firstBelowMin && (
                <p>
                  {t('Counting all accounts, the consolidated balance drops below the minimum on')} <b>{new Date(firstBelowMin.date).toLocaleDateString(locale)}</b> ({t('{balance}; account {currency}: {accountBalance}', { balance: fmtMoney(consolidatedByEntry.get(firstBelowMin)!, minBalance.currency), currency: currentCurrency, accountBalance: fmtMoney(firstBelowMin.balance, currentCurrency) })}) · {t('{n} transaction(s) below it, marked in the table.', { n: belowMinCount })}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-gray-200 bg-gray-50 backdrop-blur-md shadow-2xl overflow-hidden">
          {loading ? (
            <div className="flex justify-center items-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-teal-400"></div>
            </div>
          ) : periodView !== 'none' ? (
            <div className="table-scroll">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-gray-200 text-sm font-medium text-gray-700 font-semibold bg-gray-50">
                    <th className="p-4">{periodView === 'week' ? t('Week') : t('Month')}</th>
                    <th className="p-4 text-right">{t('Lines')}</th>
                    <th className="p-4 text-right">{t('Inflows')}</th>
                    <th className="p-4 text-right">{t('Outflows')}</th>
                    <th className="p-4 text-right">{t('Net')}</th>
                    <th className="p-4 text-right">{t('Lowest balance')}</th>
                    <th className="p-4 text-right">{t('Closing balance')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  <tr className="bg-gray-50/50 font-medium">
                    <td className="p-4 text-gray-700 font-semibold" colSpan={6}>{t('Opening Balance ({date})', { date: initialBalanceDate })}</td>
                    <td className={`p-4 text-right ${balanceClass(initialBalance)}`}>{money(initialBalance)}</td>
                  </tr>
                  {periods.length === 0 ? (
                    <tr><td colSpan={7} className="p-8 text-center text-gray-700 font-semibold">{t('No lines match these filters')}</td></tr>
                  ) : periods.map(p => (
                    <React.Fragment key={p.key}>
                      <tr className="bg-white hover:bg-gray-50 cursor-pointer" onClick={() => setOpenPeriods(o => ({ ...o, [p.key]: !o[p.key] }))}>
                        <td className="p-4 font-bold text-gray-900">
                          <span className="inline-flex items-center gap-2">
                            {openPeriods[p.key] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span className={periodView === 'month' ? 'capitalize' : ''}>{p.label}</span>
                            {p.belowMin > 0 && (
                              <span className="inline-flex items-center gap-1 bg-red-500/15 text-red-700 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-red-500/30" title={t('{n} transaction(s) below the minimum consolidated balance', { n: p.belowMin })}>
                                <AlertTriangle size={11} /> {t('Below minimum')}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="p-4 text-right text-gray-700 font-semibold">{p.entries.length}</td>
                        <td className="p-4 text-right text-emerald-600 font-bold">{p.inflow ? `+${money(p.inflow)}` : '-'}</td>
                        <td className="p-4 text-right text-red-600 font-bold">{p.outflow ? money(p.outflow) : '-'}</td>
                        <td className={`p-4 text-right font-bold ${p.inflow + p.outflow >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{p.inflow + p.outflow > 0 ? '+' : ''}{money(p.inflow + p.outflow)}</td>
                        <td className={`p-4 text-right ${balanceClass(p.lowest)}`}>{money(p.lowest)}</td>
                        <td className={`p-4 text-right text-base ${balanceClass(p.closing)}`}>{money(p.closing)}</td>
                      </tr>
                      {openPeriods[p.key] && p.entries.map((e: any) => (
                        <tr key={e.id} className={`text-sm ${belowMin(e) ? 'bg-red-50' : 'bg-gray-50/60'}`}>
                          <td className="py-2 px-4 pl-10 text-gray-700" colSpan={2}>
                            <span className="font-semibold mr-3">{new Date(e.date).toLocaleDateString(locale)}</span>
                            {e.description}{e.isGroup ? <span className="text-xs text-slate-500 ml-1">({t('{n} invoices', { n: e.invoices?.length || 0 })})</span> : null}
                          </td>
                          <td className="py-2 px-4 text-right text-emerald-600 font-semibold">{e.amount - (e.excludedAmount || 0) >= 0 ? `+${money(e.amount - (e.excludedAmount || 0))}` : ''}</td>
                          <td className="py-2 px-4 text-right text-red-600 font-semibold">{e.amount - (e.excludedAmount || 0) < 0 ? money(e.amount - (e.excludedAmount || 0)) : ''}</td>
                          <td />
                          <td />
                          <td className={`py-2 px-4 text-right ${balanceClass(e.balance)}`}>{money(e.balance)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-gray-200 text-sm font-medium text-gray-700 font-semibold bg-gray-50">
                    <th className="p-4 w-10 text-center">
                      <input 
                        type="checkbox" 
                        className="rounded border-gray-300 bg-white text-blue-500 focus:ring-blue-500"
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedEntries(visibleEntries);
                          } else {
                            setSelectedEntries([]);
                          }
                        }}
                        checked={visibleEntries.length > 0 && visibleEntries.every(v => selectedIds.has(v.id))}
                      />
                    </th>
                    <th className="p-4">{t('Date')}</th>
                    <th className="p-4">{t('Supplier or Description')}</th>
                    <th className="p-4 text-right">Amount</th>
                    <th className="p-4 text-right">Balance</th>
                    <th className="p-4 text-center">{t('Actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <tr className="bg-gray-50/50 border-b-2 border-gray-200 font-medium">
                    <td className="p-4 text-center text-slate-500">-</td>
                    <td className="p-4 text-gray-700 font-semibold">-</td>
                    <td className="p-4 font-medium text-gray-700 font-semibold">{t('Opening Balance ({date})', { date: initialBalanceDate })}</td>
                    <td className="p-4 text-right text-gray-700 font-semibold">-</td>
                    <td className={`p-4 text-right group relative flex justify-end items-center gap-2 ${initialBalance <= -1000000 ? 'text-purple-600 font-black text-lg' : initialBalance < 0 ? 'text-red-600 font-bold' : 'text-emerald-600 font-bold'}`}>
                      {isEditingBalance ? (
                        <div className="flex items-center gap-2">
                           <input type="number" step="0.01" value={newBalance} onChange={e => setNewBalance(e.target.value)} className="bg-white border border-gray-200 rounded px-2 py-1 text-sm text-gray-900 w-28 text-right" />
                           <button onClick={saveInitialBalance} className="text-gray-900 font-bold hover:text-emerald-700 font-bold"><Save size={14}/></button>
                           <button onClick={() => setIsEditingBalance(false)} className="text-gray-900 font-bold hover:text-gray-800 font-medium"><X size={14}/></button>
                        </div>
                      ) : (
                        <>
                          {getCurrencySymbol(currentCurrency)}{initialBalance.toLocaleString(locale, { minimumFractionDigits: 2 })}
                          <button onClick={() => { setIsEditingBalance(true); setNewBalance(initialBalance.toString()); }} className="opacity-0 group-hover:opacity-100 p-1 text-black hover:bg-blue-400/20 rounded transition-all"><Edit2 size={12}/></button>
                        </>
                      )}
                    </td>
                    <td className="p-4 text-center text-slate-600">-</td>
                  </tr>

                  {visibleEntries.length === 0 ? (
                     <tr><td colSpan={6} className="p-8 text-center text-gray-700 font-semibold">{searchTerm || untilDate ? t('No lines match these filters') : t('No transactions from 29/07/2026 onwards')}</td></tr>
                  ) : (
                    visibleEntries.map((entry, idx) => (
                      <React.Fragment key={entry.id}>
                        <tr 
                          draggable={true}
                          onDragStart={(e) => handleDragStart(e, entry)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => handleDrop(e, entry)}
                          className={`hover:bg-gray-50 transition-colors group cursor-pointer ${draggedItem?.id === entry.id ? 'opacity-50' : ''}`}
                          onClick={() => entry.isGroup && toggleGroup(entry.id)}
                        >
                          <td className="p-4 text-center cursor-move" title={t('Drag to move')}>
                            <div className="flex items-center justify-center gap-2">
                              <span className="text-gray-400 cursor-move">⋮⋮</span>
                              <input 
                                type="checkbox"
                                className="rounded border-gray-300 bg-white text-blue-500 focus:ring-blue-500"
                                checked={selectedEntries.some(selected => selected.id === entry.id)}
                                onChange={(e) => {
                                  if (e.target.checked) setSelectedEntries([...selectedEntries, entry]);
                                  else setSelectedEntries(selectedEntries.filter(selected => selected.id !== entry.id));
                                }}
                                onClick={e => e.stopPropagation()}
                              />
                            </div>
                          </td>
                          <td className="p-4 font-medium text-gray-600">
                            {new Date(entry.date).toLocaleDateString(locale)}
                          </td>
                          <td className="p-4">
                            <div className="flex items-center gap-2">
                              {entry.isGroup && (
                                <span className="text-gray-700 font-semibold">
                                  {expandedGroups[entry.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                </span>
                              )}
                              {entry.isManual ? (
                                <span className="bg-blue-500/20 text-blue-700 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-blue-500/30">Manual</span>
                              ) : entry.isRecurring ? (
                                <span className="bg-indigo-500/20 text-indigo-700 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-indigo-500/30">{t('Recurring')}</span>
                              ) : (
                                <span className="bg-teal-500/20 text-teal-700 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-gray-200">Auto</span>
                              )}
                              <span className="text-gray-900">{tx(entry.description)}</span>
                              {entry.isGroup && <span className="text-xs text-slate-500">({t('{n} invoices', { n: entry.invoices?.length })})</span>}
                              {claimedInvoices(entry).length > 0 && (() => {
                                const claimed = claimedInvoices(entry);
                                const last = claimed.map((i: any) => i.lastReminderDate).sort().pop();
                                const maxCount = Math.max(...claimed.map(claimCountOf));
                                return (
                                  <span className="flex items-center gap-1 bg-amber-500/15 text-amber-800 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-amber-500/30" title={t('Last reminder: {when}', { when: claimLabel(last) })}>
                                    <MailCheck size={11} /> {t('Claimed')} {claimed.length}/{entry.invoices.length}{maxCount > 1 ? ` · ${t('Claim no. {n}', { n: maxCount })}` : ''} · {claimLabel(last)}
                                  </span>
                                );
                              })()}
                              {calledInvoices(entry).length > 0 && (() => {
                                const called = calledInvoices(entry);
                                const last = called.map((i: any) => i.lastCallDate).sort().pop();
                                const maxCount = Math.max(...called.map((i: any) => i.callCount || 1));
                                return (
                                  <span className="flex items-center gap-1 bg-violet-500/15 text-violet-800 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-violet-500/30" title={t('Last call: {when}', { when: claimLabel(last) })}>
                                    <PhoneCall size={11} /> {callText(maxCount)}{called.length < entry.invoices.length ? ` ${called.length}/${entry.invoices.length}` : ''} · {claimLabel(last)}
                                  </span>
                                );
                              })()}
                              {commentsFor(lineKey(entry)).length > 0 && (
                                <button onClick={(e) => openComments(e, lineKey(entry), entry.description)} className="flex items-center gap-1 max-w-xs bg-sky-500/10 text-sky-800 font-semibold px-1.5 py-0.5 rounded text-[10px] border border-sky-500/30 hover:bg-sky-500/20" title={commentsFor(lineKey(entry)).map(c => c.text).join('\n')}>
                                  <MessageSquare size={11} className="shrink-0" /> <span className="truncate">{commentsFor(lineKey(entry)).at(-1).text}</span>
                                  {commentsFor(lineKey(entry)).length > 1 && <span className="shrink-0">(+{commentsFor(lineKey(entry)).length - 1})</span>}
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="p-4 text-right font-medium">
                            <span className={entry.amount > 0 ? "text-emerald-600 font-bold" : entry.amount < 0 ? "text-red-600 font-bold" : "text-gray-700 font-semibold font-bold"}>
                              {entry.amount > 0 ? '+' : ''}{getCurrencySymbol(currentCurrency)}{entry.amount.toLocaleString(locale, { minimumFractionDigits: 2 })}
                            </span>
                            {entry.excludedAmount !== 0 && (
                              <div className="text-[11px] text-amber-700 font-semibold">−{getCurrencySymbol(currentCurrency)}{entry.excludedAmount.toLocaleString(locale, { minimumFractionDigits: 2 })} {t('claimed, outside the balance')}</div>
                            )}
                          </td>
                          <td className={`p-4 text-right ${belowMin(entry) ? 'bg-red-50' : ''}`}>
                            {belowMin(entry) && (
                              <span className="inline-flex items-center gap-1 mr-2 bg-red-500/15 text-red-700 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-red-500/30" title={t('Consolidated balance {balance}, below the minimum of {min}', { balance: fmtMoney(consolidatedByEntry.get(entry)!, minBalance!.currency), min: fmtMoney(minBalance!.amount, minBalance!.currency) })}>
                                <AlertTriangle size={11} /> {t('Below minimum')}
                              </span>
                            )}
                            <span className={entry.balance <= -1000000 ? 'text-purple-600 font-black text-lg' : entry.balance < 0 ? 'text-red-600 font-bold text-base' : 'text-emerald-600 font-bold text-base'}>
                              {getCurrencySymbol(currentCurrency)}{entry.balance.toLocaleString(locale, { minimumFractionDigits: 2 })}
                            </span>
                          </td>
                          <td className="p-4 text-center">
                            <div className="flex justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={(e) => openComments(e, lineKey(entry), entry.description)} className={`p-1.5 rounded-md transition-colors hover:bg-sky-400/20 ${commentsFor(lineKey(entry)).length ? 'text-sky-700' : 'text-black'}`} title={t('Line comments')}>
                                <MessageSquare size={14} />
                              </button>
                              {!entry.isRecurring && (
                                <>
                                  <button onClick={(e) => { e.stopPropagation(); openEditModal(entry); }} className="p-1.5 text-black hover:bg-blue-400/20 rounded-md transition-colors" title={t('Edit Date/Entry')}>
                                    <Edit2 size={14} />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); handleArchive(entry); }} className="p-1.5 text-black hover:bg-purple-400/20 rounded-md transition-colors" title={entry.isArchived ? t('Restore to cashflow') : t('Archive (hide from cashflow)')}>
                                    {entry.isArchived ? <RefreshCw size={14} /> : <Archive size={14} />}
                                  </button>
                                </>
                              )}
                              {entry.isGroup && entry.invoices?.length > 0 && (() => {
                                const anyClaimed = claimedInvoices(entry).length > 0;
                                return (
                                  <button onClick={(e) => onClaimClick(e, entry.invoices)} className={`p-1.5 rounded-md transition-colors ${anyClaimed ? 'text-amber-700 hover:bg-amber-400/20' : 'text-black hover:bg-amber-400/20'}`} title={anyClaimed ? t('Another claim or remove the claimed mark') : t('Mark all invoices as claimed')}>
                                    <MailCheck size={14} />
                                  </button>
                                );
                              })()}
                              {entry.isGroup && entry.invoices?.length > 0 && (() => {
                                const anyCalled = calledInvoices(entry).length > 0;
                                return (
                                  <button onClick={(e) => onCallClick(e, entry.invoices)} className={`p-1.5 rounded-md transition-colors hover:bg-violet-400/20 ${anyCalled ? 'text-violet-700' : 'text-black'}`} title={anyCalled ? t('Another call or remove the called mark') : t('Mark as called (customer phoned to chase the payment)')}>
                                    <PhoneCall size={14} />
                                  </button>
                                );
                              })()}
                              {entry.isGroup && entry.customer && (
                                <>
                                  <button onClick={(e) => { e.stopPropagation(); openEmailModal(entry); }} className="p-1.5 text-gray-900 font-bold hover:bg-emerald-400/20 rounded-md transition-colors" title={t('Send a reminder to the customer (1st, 2nd with salesperson in CC, 3rd with insurer warning); with no invoices ticked, all those on the line')}>
                                    <Send size={14} />
                                  </button>
                                </>
                              )}
                              {entry.isManual && (
                                <button onClick={(e) => { e.stopPropagation(); handleDelete(entry.dbId); }} className="p-1.5 text-gray-700 font-semibold font-bold hover:bg-red-400/20 rounded-md transition-colors" title={t('Delete')}>
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {/* Sub-rows para grupos expandidos */}
                        {entry.isGroup && expandedGroups[entry.id] && entry.invoices?.map((inv: any) => (
                          <tr key={`sub-${inv.id}`} className="bg-gray-50/50 border-t border-gray-100 group">
                            <td className="p-3 text-center">
                              <input 
                                type="checkbox" 
                                className="rounded border-gray-300 bg-white text-blue-500 focus:ring-blue-500"
                                checked={!!selectedInvoices[inv.id]}
                                onChange={() => toggleInvoiceSelect(inv.id)}
                                onClick={e => e.stopPropagation()}
                              />
                            </td>
                            <td className="p-3 pl-4 text-sm text-gray-700 font-semibold border-l-2 border-l-teal-500/30">
                              {new Date(inv.cashflowDate || inv.confirmedPaymentDate || inv.dueDate).toLocaleDateString(locale)}
                            </td>
                            <td className="p-3 text-sm text-gray-600">
                              {inv.bcId} <span className="text-slate-500 text-xs ml-2">({inv.status})</span>
                              {inv.lastReminderDate && (
                                <span className="inline-flex items-center gap-1 ml-2 bg-amber-500/15 text-amber-800 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-amber-500/30">
                                  <MailCheck size={11} /> {claimCountOf(inv) > 1 ? t('Claim no. {n}', { n: claimCountOf(inv) }) : t('Claimed')} {claimLabel(inv.lastReminderDate)}
                                </span>
                              )}
                              {inv.lastCallDate && (
                                <span className="inline-flex items-center gap-1 ml-2 bg-violet-500/15 text-violet-800 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-violet-500/30">
                                  <PhoneCall size={11} /> {callText(inv.callCount || 1)} {claimLabel(inv.lastCallDate)}
                                </span>
                              )}
                              {commentsFor(`invoice:${inv.id}`).length > 0 && (
                                <button onClick={(e) => openComments(e, `invoice:${inv.id}`, inv.bcId)} className="inline-flex items-center gap-1 ml-2 max-w-xs align-middle bg-sky-500/10 text-sky-800 font-semibold px-1.5 py-0.5 rounded text-[10px] border border-sky-500/30 hover:bg-sky-500/20" title={commentsFor(`invoice:${inv.id}`).map(c => c.text).join('\n')}>
                                  <MessageSquare size={11} className="shrink-0" /> <span className="truncate">{commentsFor(`invoice:${inv.id}`).at(-1).text}</span>
                                  {commentsFor(`invoice:${inv.id}`).length > 1 && <span className="shrink-0">(+{commentsFor(`invoice:${inv.id}`).length - 1})</span>}
                                </button>
                              )}
                            </td>
                            <td className="p-3 text-sm text-right text-gray-600">
                              €{inv.amount.toLocaleString(locale, { minimumFractionDigits: 2 })}
                            </td>
                            <td className="p-3 text-right text-slate-500">-</td>
                            <td className="p-3 text-center">
                              <div className="flex justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={(e) => onClaimClick(e, [inv])} className={`p-1 rounded transition-colors hover:bg-amber-400/20 ${inv.lastReminderDate ? 'text-amber-700' : 'text-black/70 hover:text-black'}`} title={inv.lastReminderDate ? t('Another claim or remove the claimed mark') : t('Mark as claimed')}>
                                  <MailCheck size={12} />
                                </button>
                                <button onClick={(e) => onCallClick(e, [inv])} className={`p-1 rounded transition-colors hover:bg-violet-400/20 ${inv.lastCallDate ? 'text-violet-700' : 'text-black/70 hover:text-black'}`} title={inv.lastCallDate ? t('Another call or remove the called mark') : t('Mark as called')}>
                                  <PhoneCall size={12} />
                                </button>
                                <button onClick={(e) => openComments(e, `invoice:${inv.id}`, inv.bcId)} className={`p-1 rounded transition-colors hover:bg-sky-400/20 ${commentsFor(`invoice:${inv.id}`).length ? 'text-sky-700' : 'text-black/70 hover:text-black'}`} title={t('Invoice comments')}>
                                  <MessageSquare size={12} />
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); openEditModal({ isManual: false, id: inv.id, date: inv.cashflowDate || inv.dueDate, description: inv.bcId, amount: inv.amount }); }} className="p-1 text-black/70 hover:text-black hover:bg-blue-400/20 rounded transition-colors" title={t('Edit individual date')}>
                                  <Edit2 size={12} />
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); handleArchive({ isManual: false, id: inv.id, isArchived: inv.isArchived, invoices: [inv] }); }} className="p-1 text-black/70 hover:text-black hover:bg-purple-400/20 rounded transition-colors" title={inv.isArchived ? t('Restore individually') : t('Archive individually')}>
                                  {inv.isArchived ? <RefreshCw size={12} /> : <Archive size={12} />}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Menú de reclamación (factura o línea ya reclamada) */}
        {claimMenu && (
          <div className="fixed inset-0 z-50" onClick={() => setClaimMenu(null)}>
            <div className="fixed w-56 bg-white border border-gray-200 rounded-lg shadow-xl py-1 text-sm" style={{ left: claimMenu.x, top: claimMenu.y }} onClick={e => e.stopPropagation()}>
              <button onClick={() => toggleClaim(claimMenu.invoiceIds, true)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-gray-900 hover:bg-amber-50">
                <MailCheck size={14} className="text-amber-700" /> {t('Mark claim no. {n}', { n: claimMenu.next })}
              </button>
              <button onClick={() => toggleClaim(claimMenu.invoiceIds, false)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-red-700 hover:bg-red-50">
                <X size={14} /> {t('Remove claim')}
              </button>
            </div>
          </div>
        )}

        {/* Menú de llamada (factura o línea ya llamada) */}
        {callMenu && (
          <div className="fixed inset-0 z-50" onClick={() => setCallMenu(null)}>
            <div className="fixed w-56 bg-white border border-gray-200 rounded-lg shadow-xl py-1 text-sm" style={{ left: callMenu.x, top: callMenu.y }} onClick={e => e.stopPropagation()}>
              <button onClick={() => toggleCall(callMenu.invoiceIds, true)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-gray-900 hover:bg-violet-50">
                <PhoneCall size={14} className="text-violet-700" /> {t('Log another call (today)')}
              </button>
              <button onClick={() => toggleCall(callMenu.invoiceIds, false)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-red-700 hover:bg-red-50">
                <X size={14} /> {t('Remove called mark')}
              </button>
            </div>
          </div>
        )}

        {/* Modal de comentarios */}
        {commentTarget && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center p-4" onClick={() => setCommentTarget(null)}>
            <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-center p-5 border-b border-gray-200 bg-gray-50">
                <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2 min-w-0">
                  <MessageSquare size={18} className="shrink-0" /> <span className="truncate">{t('Comments')} · {commentTarget.label}</span>
                </h3>
                <button onClick={() => setCommentTarget(null)} className="text-gray-900 hover:text-gray-600"><X size={20} /></button>
              </div>
              <div className="p-5 space-y-3 max-h-80 overflow-y-auto">
                {commentsFor(commentTarget.key).length === 0 ? (
                  <p className="text-sm text-gray-500">{t('No comments yet.')}</p>
                ) : commentsFor(commentTarget.key).map(c => (
                  <div key={c.id} className="group/comment bg-gray-50 border border-gray-200 rounded-lg p-3">
                    <div className="flex justify-between items-start gap-2">
                      <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{c.text}</p>
                      <button onClick={() => deleteComment(c.id)} className="opacity-0 group-hover/comment:opacity-100 p-1 text-gray-500 hover:text-red-600 rounded transition-opacity" title={t('Delete comment')}><Trash2 size={12} /></button>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1">{c.author ? `${c.author} · ` : ''}{new Date(c.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}</div>
                  </div>
                ))}
              </div>
              <div className="p-5 border-t border-gray-200 space-y-3">
                <textarea
                  autoFocus
                  rows={3}
                  value={commentDraft}
                  onChange={e => setCommentDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment(); }}
                  placeholder={t('Write a comment…')}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
                />
                <div className="flex justify-end">
                  <button onClick={addComment} disabled={!commentDraft.trim()} className="px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-bold hover:bg-teal-700 disabled:opacity-50">{t('Add comment')}</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Modal CRUD */}
        {isModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center">
            <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden transform transition-all">
              <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gray-50">
                <h3 className="text-xl font-bold text-gray-900">
                  {isEditing ? (formData.type === 'manual' ? t('Edit Manual Line') : t('Change Invoice Date(s)')) : t('New Manual Line')}
                </h3>
                <button onClick={() => setIsModalOpen(false)} className="text-gray-900 font-bold hover:text-gray-900 transition-colors">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleSave} className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">{t('Date')}</label>
                  <input 
                    type="date" 
                    required
                    value={formData.date}
                    onChange={e => setFormData({...formData, date: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">{t('Description')}</label>
                  <input 
                    type="text" 
                    required
                    disabled={formData.type === 'invoice-date'}
                    placeholder={t('E.g. Tax payment, Payroll...')}
                    value={formData.description}
                    onChange={e => setFormData({...formData, description: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 transition-all disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">{t('Amount (€)')}</label>
                  <input 
                    type="text" 
                    required
                    disabled={formData.type === 'invoice-date'}
                    placeholder={t('E.g. -1500 or 200+500')}
                    value={formData.amount}
                    onChange={e => setFormData({...formData, amount: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 transition-all disabled:opacity-50"
                  />
                </div>
                <div className="pt-4 flex gap-3">
                  <button 
                    type="button" 
                    onClick={() => setIsModalOpen(false)}
                    className="flex-1 py-2.5 px-4 rounded-lg font-medium text-gray-800 font-medium bg-gray-50 hover:bg-gray-200 border border-gray-200 transition-colors"
                  >
                    {t('Cancel')}
                  </button>
                  <button 
                    type="submit"
                    className="flex-1 py-2.5 px-4 rounded-lg font-medium text-gray-900 bg-black hover:bg-gray-800 text-white shadow-lg shadow-gray-500/20 transition-all flex justify-center items-center gap-2"
                  >
                    <Save size={16} /> {t('Save')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Recordatorio al cliente (común con Recobros) */}
        {reminder && (
          <ReminderDialog customer={reminder.customer} invoices={reminder.invoices} onClose={() => setReminder(null)}
            onSent={async () => {
              const newSelected = { ...selectedInvoices };
              reminder.invoices.forEach((i: any) => delete newSelected[i.id]);
              setSelectedInvoices(newSelected);
              setReminder(null);
              await fetchCashflow();
            }} />
        )}

        {/* Recurring Payments Modal */}
        {recurringModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center">
            <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gray-50 shrink-0">
                <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Calendar className="text-indigo-600" />
                  {t('Recurring Payments Configuration')}
                </h3>
                <div className="flex items-center gap-3">
                  <button onClick={() => { setEditingRecurring({ id: null, description: '' }); setRecurringForm(newRecurringForm()); }}
                    className="px-3 py-1.5 bg-indigo-600 text-white hover:bg-indigo-700 font-bold text-sm rounded-lg transition-colors">
                    + {t('New recurring payment')}
                  </button>
                  <button onClick={() => setRecurringModalOpen(false)} className="text-gray-500 hover:text-gray-900 transition-colors">
                    <X size={20} />
                  </button>
                </div>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 bg-white">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200 text-sm text-gray-500 font-bold bg-gray-50">
                      <th className="p-3">{t('BC Code')}</th>
                      <th className="p-3">{t('Description')}</th>
                      <th className="p-3 text-center">{t('Configured in App')}</th>
                      <th className="p-3 text-center">{t('Actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recurringPayments.length === 0 ? (
                      <tr><td colSpan={4} className="p-4 text-center text-gray-500">{t('There are no recurring payments from BC or manual ones.')}</td></tr>
                    ) : (
                      recurringPayments.map(rec => (
                        <tr key={rec.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                          <td className="p-3 font-mono text-sm text-gray-600">{isManualRecurring(rec) ? <span className="font-sans text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">MANUAL</span> : rec.bcCode}</td>
                          <td className="p-3 font-medium text-gray-900">{rec.description}</td>
                          <td className="p-3 text-center">
                            {rec.isActive ? (
                              <div className="text-sm">
                                <span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded font-bold mr-2">{t('ACTIVE')}</span>
                                <div>{t(FREQUENCIES.find(f => f.value === (rec.frequency || 'monthly'))?.label || '')}{rec.frequency === 'weekly' ? '' : ` · ${t('day {n}', { n: rec.dayOfMonth })}`} | {getCurrencySymbol(rec.currencyCode || 'EUR')}{rec.amount}</div>
                                <div className="text-xs text-gray-500">{t('From:')} {rec.activeFromDate ? new Date(rec.activeFromDate).toLocaleDateString(locale) : '-'}</div>
                              </div>
                            ) : (
                              <span className="bg-gray-100 text-gray-500 px-2 py-0.5 rounded font-bold text-sm">{t('NOT ADDED')}</span>
                            )}
                          </td>
                          <td className="p-3 text-center">
                            {rec.isActive ? (
                              <button onClick={() => handleRemoveRecurring(rec)} className="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 font-bold text-xs rounded transition-colors">
                                {isManualRecurring(rec) ? t('Delete payment') : t('Remove from Cashflow')}
                              </button>
                            ) : (
                              <button onClick={() => {
                                setEditingRecurring(rec);
                                setRecurringForm(newRecurringForm());
                              }} className="px-3 py-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 font-bold text-xs rounded transition-colors">
                                {t('Add to Cashflow')}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Edit Recurring Details Sub-Modal */}
        {editingRecurring && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex justify-center items-center">
            <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden transform transition-all">
              <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gray-50">
                <h3 className="text-xl font-bold text-gray-900">
                  {editingRecurring.id ? t('Configure Payment') : t('New recurring payment')}
                </h3>
                <button onClick={() => setEditingRecurring(null)} className="text-gray-900 hover:text-gray-900 transition-colors">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleSaveRecurring} className="p-6 space-y-4">
                {editingRecurring.id ? (
                  <p className="text-sm text-gray-600 font-medium mb-4">{editingRecurring.description}</p>
                ) : (
                  <div>
                    <label className="block text-sm font-bold text-gray-900 mb-1">{t('Description')}</label>
                    <input
                      type="text" required autoFocus placeholder={t('e.g. Office rent')}
                      value={recurringForm.description}
                      onChange={e => setRecurringForm({...recurringForm, description: e.target.value})}
                      className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-sm font-bold text-gray-900 mb-1">{t('Frequency')}</label>
                  <select
                    value={recurringForm.frequency}
                    onChange={e => setRecurringForm({...recurringForm, frequency: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{t(f.label)}</option>)}
                  </select>
                  {recurringForm.frequency === 'weekly' && (
                    <p className="text-xs text-gray-500 mt-1">{t('Every 7 days from the start date.')}</p>
                  )}
                </div>
                {recurringForm.frequency !== 'weekly' && <div>
                  <label className="block text-sm font-bold text-gray-900 mb-1">{t('Day of Month (1-31)')}</label>
                  <input 
                    type="number" min="1" max="31" required
                    value={recurringForm.dayOfMonth}
                    onChange={e => setRecurringForm({...recurringForm, dayOfMonth: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  {recurringForm.frequency !== 'monthly' && (
                    <p className="text-xs text-gray-500 mt-1">{t('In the month of the start date and every {n} months.', { n: recurringForm.frequency === 'quarterly' ? '3' : recurringForm.frequency === 'semiannual' ? '6' : '12' })}</p>
                  )}
                </div>}
                <div>
                  <label className="block text-sm font-bold text-gray-900 mb-1">{t('Amount (e.g. -1000)')}</label>
                  <input 
                    type="number" step="0.01" required
                    value={recurringForm.amount}
                    onChange={e => setRecurringForm({...recurringForm, amount: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-900 mb-1">{t('Starting from (Date)')}</label>
                  <input 
                    type="date" required
                    value={recurringForm.activeFromDate}
                    onChange={e => setRecurringForm({...recurringForm, activeFromDate: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div className="pt-4 flex gap-3">
                  <button type="button" onClick={() => setEditingRecurring(null)} className="flex-1 py-2 px-4 rounded-lg font-medium text-gray-800 bg-gray-50 border border-gray-200 hover:bg-gray-200">
                    {t('Cancel')}
                  </button>
                  <button type="submit" className="flex-1 py-2 px-4 rounded-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 flex justify-center items-center gap-2">
                    <Save size={16} /> {t('Save')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Subtotal de las líneas marcadas */}
        {selectionCount > 0 && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-black text-white rounded-xl shadow-2xl px-5 py-3 flex items-center gap-5">
            <span className="text-sm text-gray-300">{selectionCount === 1 ? t('{n} line selected', { n: selectionCount }) : t('{n} lines selected', { n: selectionCount })}</span>
            <span className="text-sm font-semibold uppercase tracking-wider text-gray-300">Subtotal</span>
            <span className={`text-lg font-black ${selectionTotal < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
              {selectionTotal > 0 ? '+' : ''}{getCurrencySymbol(currentCurrency)}{selectionTotal.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <button onClick={() => { setSelectedEntries([]); setSelectedInvoices({}); }} className="p-1 text-gray-400 hover:text-white rounded transition-colors" title={t('Clear selection')}>
              <X size={16} />
            </button>
          </div>
        )}
      </div>
  );
}
