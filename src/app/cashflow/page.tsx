'use client';
import React, { useState, useEffect, useRef } from 'react';
import { Plus, Edit2, Trash2, RefreshCw, AlertCircle, Save, X, ChevronRight, ChevronDown, Download, Upload, Archive, Send, Briefcase, Calendar } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useCompany } from '@/contexts/CompanyContext';

export default function CashflowPage() {
  const { selectedCompany } = useCompany();
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
  const [selectedEntries, setSelectedEntries] = useState<any[]>([]);
  const [draggedItem, setDraggedItem] = useState<any>(null);
  const [consolidatedCurrency, setConsolidatedCurrency] = useState('EUR');
  
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

  
  // Email states
  const [selectedInvoices, setSelectedInvoices] = useState<Record<number, boolean>>({});
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailDraft, setEmailDraft] = useState({
    customerId: 0,
    to: '',
    subject: '',
    message: '',
    invoices: [] as any[]
  });
  const [isSendingEmail, setIsSendingEmail] = useState(false);

  const [spEmailModalOpen, setSpEmailModalOpen] = useState(false);
  const [spEmailDraft, setSpEmailDraft] = useState({
    customerId: 0,
    to: '',
    subject: '',
    message: '',
    invoices: [] as any[]
  });
  const [isSendingSpEmail, setIsSendingSpEmail] = useState(false);
  
  // Recurring Payments
  const [recurringModalOpen, setRecurringModalOpen] = useState(false);
  const [recurringPayments, setRecurringPayments] = useState<any[]>([]);
  const [editingRecurring, setEditingRecurring] = useState<any>(null);
  const [recurringForm, setRecurringForm] = useState({ amount: '', dayOfMonth: '1', activeFromDate: '' });

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
  }, [showArchived, currentCurrency]);

  const handleSync = async () => {
    try {
      setSyncing(true);
      // Trigger a BC sync to get the latest invoices
      await fetch('/api/sync-bc', { method: 'POST' });
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
    if (!confirm('¿Estás seguro de eliminar esta línea manual?')) return;
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
      if (confirm('No has seleccionado ninguna línea manual. ¿Quieres borrar TODAS las líneas manuales?')) {
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
    
    if (!confirm(`¿Borrar las ${manualIds.length} líneas manuales seleccionadas?`)) return;
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
    if (!confirm(`¿${isArchiving ? 'Archivar' : 'Restaurar'} las ${selectedEntries.length} líneas seleccionadas?`)) return;
    
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
    if (!confirm(entry.isArchived ? '¿Restaurar esta línea al Cashflow activo?' : '¿Estás seguro de que quieres archivar esta línea y sacarla del Cashflow?')) return;
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
    
    const confirmMsg = `¿Mover "${draggedItem.description}" a la fecha de "${targetEntry.description}" (${new Date(targetEntry.date).toLocaleDateString('es-ES')})?`;
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

  const openEmailModal = (entry: any) => {
    if (!entry.customer) return;
    const selectedList = entry.invoices?.filter((inv: any) => selectedInvoices[inv.id]) || [];
    if (selectedList.length === 0) {
      alert("Selecciona al menos una factura para este cliente.");
      return;
    }

    const invoiceDetails = selectedList.map((i: any) => `- Factura ${i.bcId}: €${i.amount.toLocaleString(undefined, {minimumFractionDigits: 2})} (Vence el ${new Date(i.dueDate).toLocaleDateString()})`).join('\n');
    
    setEmailDraft({
      customerId: entry.customer.id,
      to: entry.customer.email || '',
      subject: `Recordatorio de facturas pendientes - ${entry.customer.name}`,
      message: `Estimado ${entry.customer.name},\n\nNos ponemos en contacto con usted para recordarle que existen facturas pendientes de pago en su cuenta.\nLe agradeceríamos que las liquidara lo antes posible.\n\n${invoiceDetails}`,
      invoices: selectedList
    });
    setEmailModalOpen(true);
  };

  const openSpEmailModal = (entry: any) => {
    if (!entry.customer) return;
    const selectedList = entry.invoices?.filter((inv: any) => selectedInvoices[inv.id]) || [];
    if (selectedList.length === 0) {
      alert("Selecciona al menos una factura para notificar al comercial.");
      return;
    }
    if (!entry.customer.salespersonName) {
      alert("Este cliente no tiene un comercial asignado.");
      return;
    }
    const totalAmount = selectedList.reduce((acc: number, inv: any) => acc + inv.amount, 0);
    setSpEmailDraft({
      customerId: entry.customer.id,
      to: 'prueba.comercial@craze.local', // Placeholder
      subject: `[Acción Requerida] Cliente ${entry.customer.name} - Facturas Pendientes`,
      message: `Hola ${entry.customer.salespersonName},\n\nNecesitamos tu asistencia urgente respecto a la cuenta de ${entry.customer.name} (${entry.customer.bcId}). Tienen facturas pendientes por un total de €${totalAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}.\n\nPor favor, contacta con ellos para asegurar una fecha de pago.\n\nGracias,\nEquipo de Finanzas`,
      invoices: selectedList
    });
    setSpEmailModalOpen(true);
  };

  const confirmSendEmail = async () => {
    setIsSendingEmail(true);
    try {
      const res = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: emailDraft.customerId,
          invoiceIds: emailDraft.invoices.map((i: any) => i.id),
          to: emailDraft.to,
          subject: emailDraft.subject,
          message: emailDraft.message
        })
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.previewUrl ? `Correo simulado enviado al cliente.\nMíralo aquí: ${data.previewUrl}` : 'Correo enviado correctamente.');
        const newSelected = { ...selectedInvoices };
        emailDraft.invoices.forEach((i: any) => delete newSelected[i.id]);
        setSelectedInvoices(newSelected);
        await fetchCashflow();
        setEmailModalOpen(false);
      } else {
        alert('Error al enviar correo: ' + data.error);
      }
    } catch (e) {
      alert('Error en el sistema de correos.');
    } finally {
      setIsSendingEmail(false);
    }
  };

  const confirmSendSpEmail = async () => {
    setIsSendingSpEmail(true);
    try {
      const res = await fetch('/api/send-salesperson-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: spEmailDraft.customerId,
          invoiceIds: spEmailDraft.invoices.map((i: any) => i.id),
          to: spEmailDraft.to,
          subject: spEmailDraft.subject,
          message: spEmailDraft.message
        })
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.previewUrl ? `Correo simulado enviado al comercial.\nMíralo aquí: ${data.previewUrl}` : 'Correo enviado al comercial correctamente.');
        const newSelected = { ...selectedInvoices };
        spEmailDraft.invoices.forEach((i: any) => delete newSelected[i.id]);
        setSelectedInvoices(newSelected);
        await fetchCashflow();
        setSpEmailModalOpen(false);
      } else {
        alert('Error al enviar correo: ' + data.error);
      }
    } catch (e) {
      alert('Error en el sistema de correos.');
    } finally {
      setIsSendingSpEmail(false);
    }
  };

  // Exporta lo que se ve en pantalla (divisa, filtro y archivadas): saldo inicial + una fila por línea,
  // sin el detalle de facturas de los cobros agrupados
  const handleExportCashflow = () => {
    const visible = entries.filter(e => filterType === 'ALL' || (filterType === 'AUTO' && !e.isManual) || (filterType === 'MANUAL' && e.isManual));
    const [d, m, y] = initialBalanceDate.split('/').map(Number);
    const rows: any[][] = [
      ['Fecha', 'Descripción', 'Importe', 'Saldo'],
      [y && m && d ? new Date(Date.UTC(y, m - 1, d)) : initialBalanceDate, 'Saldo Inicial', null, initialBalance],
      ...visible.map(e => [new Date(e.date), e.description, e.amount, e.balance]),
    ];

    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let r = 1; r <= range.e.r; r++) {
      const dateCell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
      if (dateCell && dateCell.t === 'd') dateCell.z = 'dd/mm/yyyy';
      for (const c of [2, 3]) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.t === 'n') cell.z = '#,##0.00';
      }
    }
    ws['!cols'] = [{ wch: 12 }, { wch: 50 }, { wch: 16 }, { wch: 16 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Cashflow ${currentCurrency}`);
    const today = new Date().toISOString().substring(0, 10);
    XLSX.writeFile(wb, `Cashflow_${selectedCompany}_${currentCurrency}_${today}.xlsx`.replace(/\s+/g, '_'));
  };

  const handleExportTemplate = () => {
    const ws = XLSX.utils.json_to_sheet([
      { fecha: '2026-08-01', supplier: 'Ejemplo Pago Alquiler', amount: -1500.50 }
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
          alert('El archivo no tiene el formato correcto o está vacío. Asegúrate de tener las columnas: fecha, supplier, amount.');
          return;
        }

        const entriesWithCurrency = newEntries.map(e => ({ ...e, currency: currentCurrency }));

        setSyncing(true);
        await fetch('/api/cashflow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entriesWithCurrency)
        });
        
        alert(`¡Se han importado ${newEntries.length} registros en la cuenta ${currentCurrency}!`);
        fetchCashflow();
      } catch (err) {
        console.error('Failed to import Excel:', err);
        alert('Error importando el archivo.');
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
      const payload = {
        id: editingRecurring.id,
        isActive: true,
        amount: recurringForm.amount,
        dayOfMonth: recurringForm.dayOfMonth,
        activeFromDate: recurringForm.activeFromDate,
        currencyCode: currentCurrency
      };
      await fetch('/api/cashflow/recurring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setEditingRecurring(null);
      fetchRecurringPayments();
      fetchCashflow();
    } catch (err) { console.error(err); }
  };

  const handleRemoveRecurring = async (rec: any) => {
    try {
      await fetch('/api/cashflow/recurring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rec.id, isActive: false })
      });
      fetchRecurringPayments();
      fetchCashflow();
    } catch (err) { console.error(err); }
  };

  return (
    <div className="flex-1 p-8 max-w-[1600px] mx-auto overflow-hidden">
        <div className="flex justify-between items-center mb-8 sticky top-0 z-10 bg-gray-50/95 backdrop-blur-md pb-4 pt-6 -mt-6 border-b border-gray-200">
          <div>
            <h1 className="text-4xl font-black text-black mb-2">
              Previsión de Tesorería (Cashflow)
            </h1>
            <div className="flex items-center gap-4">
              <p className="text-gray-900 font-bold text-sm">Flujo de caja basado en cobros y entradas manuales.</p>
              <div className="flex bg-white rounded-lg p-1 border border-gray-200 items-center">
                <button onClick={() => setFilterType('ALL')} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filterType === 'ALL' ? 'bg-gray-200 text-gray-900' : 'text-gray-900 font-bold hover:text-gray-900 hover:bg-gray-50'}`}>Todos</button>
                <button onClick={() => setFilterType('AUTO')} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filterType === 'AUTO' ? 'bg-teal-500/30 text-teal-700 font-bold' : 'text-gray-900 font-bold hover:text-gray-900 hover:bg-gray-50'}`}>Automáticos</button>
                <button onClick={() => setFilterType('MANUAL')} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filterType === 'MANUAL' ? 'bg-blue-500/30 text-blue-700 font-bold' : 'text-gray-900 font-bold hover:text-gray-900 hover:bg-gray-50'}`}>Manuales</button>
                <div className="w-px h-4 bg-white/10 mx-2"></div>
                <button onClick={() => setShowArchived(!showArchived)} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${showArchived ? 'bg-purple-500/30 text-purple-700 font-bold border border-purple-500/50' : 'text-gray-900 font-bold hover:text-purple-700 font-bold hover:bg-purple-500/10'}`}>
                  {showArchived ? 'Ocultar Archivadas' : 'Ver Archivadas'}
                </button>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input 
              type="file" 
              accept=".xlsx, .xls, .csv" 
              className="hidden" 
              ref={fileInputRef}
              onChange={handleImport}
            />
            <button 
              onClick={handleBulkDelete}
              className="flex items-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-gray-700 font-bold rounded-lg border border-red-500/20 transition-colors text-sm"
              title={selectedEntries.filter(e => e.isManual).length > 0 ? "Borrar Manuales Seleccionadas" : "Borrar Todo (Manuales)"}
            >
              <Trash2 size={16} /> {selectedEntries.filter(e => e.isManual).length > 0 ? `Borrar (${selectedEntries.filter(e => e.isManual).length})` : 'Borrar Todas'}
            </button>
            {selectedEntries.length > 0 && (
              <button 
                onClick={handleBulkArchive}
                className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 text-purple-700 font-bold rounded-lg border border-purple-500/20 transition-colors text-sm"
                title="Archivar Seleccionadas"
              >
                <Archive size={16} /> Archivar ({selectedEntries.length})
              </button>
            )}
            <button 
              onClick={handleExportCashflow}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-gray-900 font-bold rounded-lg border border-emerald-500/20 transition-colors text-sm"
              title="Exportar el cashflow en pantalla a Excel"
            >
              <Download size={16} /> Exportar Excel
            </button>
            <button 
              onClick={handleExportTemplate}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-gray-900 font-bold rounded-lg border border-emerald-500/20 transition-colors text-sm"
              title="Descargar Plantilla Excel"
            >
              <Download size={16} /> Plantilla
            </button>
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={syncing}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-black rounded-lg border border-blue-500/20 transition-colors text-sm"
              title="Importar Excel"
            >
              <Upload size={16} className={syncing ? "animate-pulse" : ""} /> Importar Excel
            </button>
            
            <button 
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-2 px-4 py-2 bg-gray-50 hover:bg-gray-200 text-gray-900 rounded-lg border border-gray-200 transition-colors ml-4 text-sm"
            >
              <RefreshCw size={16} className={syncing ? "animate-spin text-black" : "text-gray-900 font-bold"} />
              {syncing ? 'Sincronizando...' : 'Actualizar Local'}
            </button>
            <button 
              onClick={openAddModal}
              className="flex items-center gap-2 px-4 py-2 bg-black hover:bg-gray-800 text-white rounded-lg shadow-lg font-medium transition-all text-sm"
            >
              <Plus size={16} /> Añadir Línea
            </button>
            <button 
              onClick={openRecurringModal}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg shadow-lg font-medium transition-all text-sm ml-2"
            >
              <Calendar size={16} /> Configurar Recurrentes
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
                Cuenta {curr}
                {allBalances[curr] !== undefined && (
                  <span className={`ml-2 px-2 py-0.5 rounded text-xs font-black ${currentCurrency === curr ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-700'}`}>
                    {getCurrencySymbol(curr)}{allBalances[curr].toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                )}
              </button>
            ))}
          </div>
          
          {totalEurSum !== null && (
            <div className="bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-lg flex items-center gap-3">
              <span className="text-emerald-800 font-bold text-sm uppercase tracking-wider whitespace-nowrap">Saldo Consolidado</span>
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
                {(totalEurSum * (exchangeRates[consolidatedCurrency] || 1)).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-gray-200 bg-gray-50 backdrop-blur-md shadow-2xl overflow-hidden">
          {loading ? (
            <div className="flex justify-center items-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-teal-400"></div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-gray-200 text-sm font-medium text-gray-700 font-semibold bg-gray-50">
                    <th className="p-4 w-10 text-center">
                      <input 
                        type="checkbox" 
                        className="rounded border-gray-300 bg-white text-blue-500 focus:ring-blue-500"
                        onChange={(e) => {
                          const currentFilteredEntries = entries.filter(e => filterType === 'ALL' || (filterType === 'AUTO' && !e.isManual) || (filterType === 'MANUAL' && e.isManual));
                          if (e.target.checked) {
                            setSelectedEntries(currentFilteredEntries);
                          } else {
                            setSelectedEntries([]);
                          }
                        }}
                        checked={entries.length > 0 && selectedEntries.length === entries.filter(e => filterType === 'ALL' || (filterType === 'AUTO' && !e.isManual) || (filterType === 'MANUAL' && e.isManual)).length}
                      />
                    </th>
                    <th className="p-4">Fecha</th>
                    <th className="p-4">Supplier o Description</th>
                    <th className="p-4 text-right">Amount</th>
                    <th className="p-4 text-right">Balance</th>
                    <th className="p-4 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <tr className="bg-gray-50/50 border-b-2 border-gray-200 font-medium">
                    <td className="p-4 text-center text-slate-500">-</td>
                    <td className="p-4 text-gray-700 font-semibold">-</td>
                    <td className="p-4 font-medium text-gray-700 font-semibold">Saldo Inicial ({initialBalanceDate})</td>
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
                          {getCurrencySymbol(currentCurrency)}{initialBalance.toLocaleString('es-ES', { minimumFractionDigits: 2 })}
                          <button onClick={() => { setIsEditingBalance(true); setNewBalance(initialBalance.toString()); }} className="opacity-0 group-hover:opacity-100 p-1 text-black hover:bg-blue-400/20 rounded transition-all"><Edit2 size={12}/></button>
                        </>
                      )}
                    </td>
                    <td className="p-4 text-center text-slate-600">-</td>
                  </tr>

                  {entries
                    .filter(e => filterType === 'ALL' || (filterType === 'AUTO' && !e.isManual) || (filterType === 'MANUAL' && e.isManual))
                    .length === 0 ? (
                     <tr><td colSpan={6} className="p-8 text-center text-gray-700 font-semibold">No hay movimientos a partir del 29/07/2026</td></tr>
                  ) : (
                    entries
                      .filter(e => filterType === 'ALL' || (filterType === 'AUTO' && !e.isManual) || (filterType === 'MANUAL' && e.isManual))
                      .map((entry, idx) => (
                      <React.Fragment key={entry.id}>
                        <tr 
                          draggable={true}
                          onDragStart={(e) => handleDragStart(e, entry)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => handleDrop(e, entry)}
                          className={`hover:bg-gray-50 transition-colors group cursor-pointer ${draggedItem?.id === entry.id ? 'opacity-50' : ''}`}
                          onClick={() => entry.isGroup && toggleGroup(entry.id)}
                        >
                          <td className="p-4 text-center cursor-move" title="Arrastrar para mover">
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
                            {new Date(entry.date).toLocaleDateString('es-ES')}
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
                                <span className="bg-indigo-500/20 text-indigo-700 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-indigo-500/30">Recurrente</span>
                              ) : (
                                <span className="bg-teal-500/20 text-teal-700 font-bold px-1.5 py-0.5 rounded text-[10px] uppercase border border-gray-200">Auto</span>
                              )}
                              <span className="text-gray-900">{entry.description}</span>
                              {entry.isGroup && <span className="text-xs text-slate-500">({entry.invoices?.length} facturas)</span>}
                            </div>
                          </td>
                          <td className="p-4 text-right font-medium">
                            <span className={entry.amount > 0 ? "text-emerald-600 font-bold" : entry.amount < 0 ? "text-red-600 font-bold" : "text-gray-700 font-semibold font-bold"}>
                              {entry.amount > 0 ? '+' : ''}{getCurrencySymbol(currentCurrency)}{entry.amount.toLocaleString('es-ES', { minimumFractionDigits: 2 })}
                            </span>
                          </td>
                          <td className="p-4 text-right">
                            <span className={entry.balance <= -1000000 ? 'text-purple-600 font-black text-lg' : entry.balance < 0 ? 'text-red-600 font-bold text-base' : 'text-emerald-600 font-bold text-base'}>
                              {getCurrencySymbol(currentCurrency)}{entry.balance.toLocaleString('es-ES', { minimumFractionDigits: 2 })}
                            </span>
                          </td>
                          <td className="p-4 text-center">
                            <div className="flex justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              {!entry.isRecurring && (
                                <>
                                  <button onClick={(e) => { e.stopPropagation(); openEditModal(entry); }} className="p-1.5 text-black hover:bg-blue-400/20 rounded-md transition-colors" title="Editar Fecha/Registro">
                                    <Edit2 size={14} />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); handleArchive(entry); }} className="p-1.5 text-black hover:bg-purple-400/20 rounded-md transition-colors" title={entry.isArchived ? "Restaurar al cashflow" : "Archivar (ocultar del cashflow)"}>
                                    {entry.isArchived ? <RefreshCw size={14} /> : <Archive size={14} />}
                                  </button>
                                </>
                              )}
                              {entry.isGroup && entry.customer && (
                                <>
                                  <button onClick={(e) => { e.stopPropagation(); openEmailModal(entry); }} className="p-1.5 text-gray-900 font-bold hover:bg-emerald-400/20 rounded-md transition-colors" title="Enviar Recordatorio al Cliente">
                                    <Send size={14} />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); openSpEmailModal(entry); }} className="p-1.5 text-orange-400 hover:bg-orange-400/20 rounded-md transition-colors" title="Avisar al Comercial">
                                    <Briefcase size={14} />
                                  </button>
                                </>
                              )}
                              {entry.isManual && (
                                <button onClick={(e) => { e.stopPropagation(); handleDelete(entry.dbId); }} className="p-1.5 text-gray-700 font-semibold font-bold hover:bg-red-400/20 rounded-md transition-colors" title="Eliminar">
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
                              {new Date(inv.cashflowDate || inv.confirmedPaymentDate || inv.dueDate).toLocaleDateString('es-ES')}
                            </td>
                            <td className="p-3 text-sm text-gray-600">
                              {inv.bcId} <span className="text-slate-500 text-xs ml-2">({inv.status})</span>
                            </td>
                            <td className="p-3 text-sm text-right text-gray-600">
                              €{inv.amount.toLocaleString('es-ES', { minimumFractionDigits: 2 })}
                            </td>
                            <td className="p-3 text-right text-slate-500">-</td>
                            <td className="p-3 text-center">
                              <div className="flex justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={(e) => { e.stopPropagation(); openEditModal({ isManual: false, id: inv.id, date: inv.cashflowDate || inv.dueDate, description: inv.bcId, amount: inv.amount }); }} className="p-1 text-black/70 hover:text-black hover:bg-blue-400/20 rounded transition-colors" title="Editar fecha individual">
                                  <Edit2 size={12} />
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); handleArchive({ isManual: false, id: inv.id, isArchived: inv.isArchived, invoices: [inv] }); }} className="p-1 text-black/70 hover:text-black hover:bg-purple-400/20 rounded transition-colors" title={inv.isArchived ? "Restaurar individualmente" : "Archivar individualmente"}>
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

        {/* Modal CRUD */}
        {isModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center">
            <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden transform transition-all">
              <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gray-50">
                <h3 className="text-xl font-bold text-gray-900">
                  {isEditing ? (formData.type === 'manual' ? 'Editar Línea Manual' : 'Cambiar Fecha de Factura(s)') : 'Nueva Línea Manual'}
                </h3>
                <button onClick={() => setIsModalOpen(false)} className="text-gray-900 font-bold hover:text-gray-900 transition-colors">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleSave} className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">Fecha</label>
                  <input 
                    type="date" 
                    required
                    value={formData.date}
                    onChange={e => setFormData({...formData, date: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">Descripción</label>
                  <input 
                    type="text" 
                    required
                    disabled={formData.type === 'invoice-date'}
                    placeholder="Ej. Pago de impuestos, Nóminas..."
                    value={formData.description}
                    onChange={e => setFormData({...formData, description: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 transition-all disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">Importe (€)</label>
                  <input 
                    type="text" 
                    required
                    disabled={formData.type === 'invoice-date'}
                    placeholder="Ej. -1500 o 200+500"
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
                    Cancelar
                  </button>
                  <button 
                    type="submit"
                    className="flex-1 py-2.5 px-4 rounded-lg font-medium text-gray-900 bg-black hover:bg-gray-800 text-white shadow-lg shadow-gray-500/20 transition-all flex justify-center items-center gap-2"
                  >
                    <Save size={16} /> Guardar
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Email Customer Modal */}
        {emailModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center">
            <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden transform transition-all">
              <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gray-50">
                <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Send className="text-gray-900 font-bold" />
                  Enviar Recordatorio a {emailDraft.to}
                </h3>
                <button onClick={() => setEmailModalOpen(false)} className="text-gray-900 font-bold hover:text-gray-900 transition-colors">
                  <X size={20} />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">Para (Email del Cliente)</label>
                  <input 
                    type="email" 
                    value={emailDraft.to}
                    onChange={e => setEmailDraft({...emailDraft, to: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">Asunto</label>
                  <input 
                    type="text" 
                    value={emailDraft.subject}
                    onChange={e => setEmailDraft({...emailDraft, subject: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">Mensaje</label>
                  <textarea 
                    rows={8}
                    value={emailDraft.message}
                    onChange={e => setEmailDraft({...emailDraft, message: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 resize-none font-mono text-sm"
                  />
                </div>
                <div className="flex justify-end gap-3 mt-6">
                  <button onClick={() => setEmailModalOpen(false)} className="px-5 py-2.5 text-sm font-medium text-gray-900 font-bold hover:text-gray-900 transition-colors">
                    Cancelar
                  </button>
                  <button 
                    onClick={confirmSendEmail}
                    disabled={isSendingEmail}
                    className="px-5 py-2.5 bg-gray-800 hover:bg-gray-700 text-white text-gray-900 text-sm font-medium rounded-xl shadow-lg transition-all disabled:opacity-50 flex items-center gap-2"
                  >
                    {isSendingEmail ? <RefreshCw className="animate-spin" size={16} /> : <Send size={16} />}
                    {isSendingEmail ? 'Enviando...' : 'Enviar Correo'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Email Salesperson Modal */}
        {spEmailModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center">
            <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden transform transition-all">
              <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gray-50">
                <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Briefcase className="text-orange-400" />
                  Avisar al Comercial
                </h3>
                <button onClick={() => setSpEmailModalOpen(false)} className="text-gray-900 font-bold hover:text-gray-900 transition-colors">
                  <X size={20} />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">Para</label>
                  <input 
                    type="text" 
                    value={spEmailDraft.to}
                    onChange={e => setSpEmailDraft({...spEmailDraft, to: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">Asunto</label>
                  <input 
                    type="text" 
                    value={spEmailDraft.subject}
                    onChange={e => setSpEmailDraft({...spEmailDraft, subject: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900 font-bold mb-1">Mensaje</label>
                  <textarea 
                    rows={8}
                    value={spEmailDraft.message}
                    onChange={e => setSpEmailDraft({...spEmailDraft, message: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-orange-500/50 resize-none font-mono text-sm"
                  />
                </div>
                <div className="flex justify-end gap-3 mt-6">
                  <button onClick={() => setSpEmailModalOpen(false)} className="px-5 py-2.5 text-sm font-medium text-gray-900 font-bold hover:text-gray-900 transition-colors">
                    Cancelar
                  </button>
                  <button 
                    onClick={confirmSendSpEmail}
                    disabled={isSendingSpEmail}
                    className="px-5 py-2.5 bg-gray-600 hover:bg-gray-500 text-white text-gray-900 text-sm font-medium rounded-xl shadow-lg transition-all disabled:opacity-50 flex items-center gap-2"
                  >
                    {isSendingSpEmail ? <RefreshCw className="animate-spin" size={16} /> : <Briefcase size={16} />}
                    {isSendingSpEmail ? 'Enviando...' : 'Enviar al Comercial'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Recurring Payments Modal */}
        {recurringModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center">
            <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gray-50 shrink-0">
                <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Calendar className="text-indigo-600" />
                  Configuración de Pagos Recurrentes
                </h3>
                <button onClick={() => setRecurringModalOpen(false)} className="text-gray-500 hover:text-gray-900 transition-colors">
                  <X size={20} />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 bg-white">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200 text-sm text-gray-500 font-bold bg-gray-50">
                      <th className="p-3">Código BC</th>
                      <th className="p-3">Descripción</th>
                      <th className="p-3 text-center">Configurado en App</th>
                      <th className="p-3 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recurringPayments.length === 0 ? (
                      <tr><td colSpan={4} className="p-4 text-center text-gray-500">No hay pagos recurrentes sincronizados de BC.</td></tr>
                    ) : (
                      recurringPayments.map(rec => (
                        <tr key={rec.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                          <td className="p-3 font-mono text-sm text-gray-600">{rec.bcCode}</td>
                          <td className="p-3 font-medium text-gray-900">{rec.description}</td>
                          <td className="p-3 text-center">
                            {rec.isActive ? (
                              <div className="text-sm">
                                <span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded font-bold mr-2">ACTIVO</span>
                                <div>Día {rec.dayOfMonth} | {getCurrencySymbol(rec.currencyCode || 'EUR')}{rec.amount}</div>
                                <div className="text-xs text-gray-500">Desde: {rec.activeFromDate ? new Date(rec.activeFromDate).toLocaleDateString() : '-'}</div>
                              </div>
                            ) : (
                              <span className="bg-gray-100 text-gray-500 px-2 py-0.5 rounded font-bold text-sm">NO AÑADIDO</span>
                            )}
                          </td>
                          <td className="p-3 text-center">
                            {rec.isActive ? (
                              <button onClick={() => handleRemoveRecurring(rec)} className="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 font-bold text-xs rounded transition-colors">
                                Quitar del Cashflow
                              </button>
                            ) : (
                              <button onClick={() => {
                                setEditingRecurring(rec);
                                setRecurringForm({ amount: '', dayOfMonth: '1', activeFromDate: new Date().toISOString().split('T')[0] });
                              }} className="px-3 py-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 font-bold text-xs rounded transition-colors">
                                Añadir al Cashflow
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
                  Configurar Pago
                </h3>
                <button onClick={() => setEditingRecurring(null)} className="text-gray-900 hover:text-gray-900 transition-colors">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleSaveRecurring} className="p-6 space-y-4">
                <p className="text-sm text-gray-600 font-medium mb-4">{editingRecurring.description}</p>
                <div>
                  <label className="block text-sm font-bold text-gray-900 mb-1">Día del Mes (1-31)</label>
                  <input 
                    type="number" min="1" max="31" required
                    value={recurringForm.dayOfMonth}
                    onChange={e => setRecurringForm({...recurringForm, dayOfMonth: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-900 mb-1">Importe (ej. -1000)</label>
                  <input 
                    type="number" step="0.01" required
                    value={recurringForm.amount}
                    onChange={e => setRecurringForm({...recurringForm, amount: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-900 mb-1">A partir de (Fecha)</label>
                  <input 
                    type="date" required
                    value={recurringForm.activeFromDate}
                    onChange={e => setRecurringForm({...recurringForm, activeFromDate: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div className="pt-4 flex gap-3">
                  <button type="button" onClick={() => setEditingRecurring(null)} className="flex-1 py-2 px-4 rounded-lg font-medium text-gray-800 bg-gray-50 border border-gray-200 hover:bg-gray-200">
                    Cancelar
                  </button>
                  <button type="submit" className="flex-1 py-2 px-4 rounded-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 flex justify-center items-center gap-2">
                    <Save size={16} /> Guardar
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </div>
  );
}
