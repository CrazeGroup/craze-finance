'use client';

import { useEffect, useState, useMemo } from 'react';
import { syncFromBc } from '@/lib/syncClient';
import { RefreshCcw, Send, CheckCircle, ChevronDown, ChevronRight, Filter, Briefcase } from 'lucide-react';

// Empresa activa (cookie que escribe CompanyContext)
const getSelectedCompany = () => decodeURIComponent(document.cookie.match(/(?:^|; )craze_selected_company=([^;]*)/)?.[1] || 'CRAZE');

export default function RecobrosPage() {
  const [rawInvoices, setRawInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Email Modal State (Customer)
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailDraft, setEmailDraft] = useState({
    customerId: 0,
    to: '',
    subject: '',
    message: '',
    invoices: [] as any[]
  });
  const [isSendingEmail, setIsSendingEmail] = useState(false);

  // Email Modal State (Salesperson)
  const [spEmailModalOpen, setSpEmailModalOpen] = useState(false);
  const [spEmailDraft, setSpEmailDraft] = useState({
    customerId: 0,
    to: '',
    subject: '',
    message: '',
    invoices: [] as any[]
  });
  const [isSendingSpEmail, setIsSendingSpEmail] = useState(false);

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
      const errors = await syncFromBc(getSelectedCompany());
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
      alert("Selecciona al menos una factura para este cliente.");
      return;
    }

    const totalAmount = selectedList.reduce((acc: number, inv: any) => acc + inv.amount, 0);
    const invoiceDetails = selectedList.map((i: any) => `- Invoice ${i.bcId}: €${i.amount.toLocaleString(undefined, {minimumFractionDigits: 2})} (Overdue on ${new Date(i.dueDate).toLocaleDateString()})`).join('\n');
    
    setEmailDraft({
      customerId: group.customer.id,
      to: group.customer.email || '',
      subject: `Recordatorio de facturas vencidas - ${group.customer.name}`,
      message: `Dear ${group.customer.name},\n\nWe are contacting you to remind you that there are overdue invoices pending payment on your account.\nWe would appreciate it if you could settle this matter as soon as possible.\n\n${invoiceDetails}`,
      invoices: selectedList
    });
    setEmailModalOpen(true);
  };

  const openSpEmailModal = (group: any) => {
    const selectedList = group.invoices.filter((inv: any) => selectedInvoices[inv.id]);
    if (selectedList.length === 0) {
      alert("Selecciona al menos una factura para notificar al comercial.");
      return;
    }

    if (!group.customer.salespersonName) {
      alert("Este cliente no tiene un comercial asignado.");
      return;
    }

    setSpEmailDraft({
      customerId: group.customer.id,
      to: 'prueba.comercial@craze.local', // Placeholder email for now
      subject: `[Action Required] Customer ${group.customer.name} - Overdue Invoices`,
      message: `Hi ${group.customer.salespersonName || 'Salesperson'},\n\nWe urgently need your assistance regarding ${group.customer.name}'s account (${group.customer.bcId}). They have significantly overdue invoices totaling €${group.amtOverdue.toLocaleString(undefined, {minimumFractionDigits: 2})}.\n\nWhile we value our relationship with them, these outstanding balances are severely impacting our credit risk metrics and cash flow. Please reach out to your contact immediately to secure a firm payment date. We need this resolved as soon as possible to avoid further escalation or a potential credit hold on their account.\n\nThank you for your prompt action,\nCraze Gmbh Finance Team`,
      invoices: selectedList
    });
    setSpEmailModalOpen(true);
  };

  const confirmSendEmail = async () => {
    setIsSendingEmail(true);
    try {
      // Generate PDF on client side to bypass Vercel Puppeteer limits
      const previewRes = await fetch(`/api/preview-report?customerId=${emailDraft.customerId}&invoices=${emailDraft.invoices.map((i: any) => i.id).join(',')}&message=${encodeURIComponent(emailDraft.message)}`);
      const htmlContent = await previewRes.text();
      
      // Run html2pdf inside an isolated iframe to prevent html2canvas from parsing Tailwind v4 CSS
      const iframe = document.createElement('iframe');
      iframe.style.position = 'absolute';
      iframe.style.width = '800px';
      iframe.style.height = '1000px';
      iframe.style.left = '-9999px';
      document.body.appendChild(iframe);
      
      const pdfBase64 = await new Promise<string>((resolve, reject) => {
        iframe.onload = async () => {
          try {
            const win = iframe.contentWindow as any;
            // Wait for html2pdf to be loaded in the iframe just in case
            if (!win.html2pdf) {
              await new Promise(r => setTimeout(r, 500));
            }
            const pdfStr = await win.html2pdf().set({
              margin: 10,
              filename: 'Facturas.pdf',
              image: { type: 'jpeg', quality: 0.98 },
              html2canvas: { scale: 2, useCORS: true, logging: false },
              jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            }).from(win.document.getElementById('pdf-content')).outputPdf('datauristring');
            resolve(pdfStr);
          } catch (err) {
            reject(err);
          }
        };

        iframe.contentDocument!.open();
        iframe.contentDocument!.write(`
          <!DOCTYPE html>
          <html>
            <head>
              <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
            </head>
            <body>
              <div id="pdf-content">${htmlContent}</div>
            </body>
          </html>
        `);
        iframe.contentDocument!.close();
      });
      
      document.body.removeChild(iframe);

      const res = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: emailDraft.customerId,
          invoiceIds: emailDraft.invoices.map((i: any) => i.id),
          to: emailDraft.to,
          subject: emailDraft.subject,
          message: emailDraft.message,
          pdfBase64: pdfBase64
        })
      });
      const data = await res.json();
      
      if (res.ok) {
        if (data.previewUrl) {
          alert(`Correo simulado enviado al cliente.\nMíralo aquí: ${data.previewUrl}`);
        } else {
          alert('Correo enviado correctamente.');
        }
        
        const newSelected = { ...selectedInvoices };
        emailDraft.invoices.forEach((i: any) => delete newSelected[i.id]);
        setSelectedInvoices(newSelected);
        await fetchInvoices();
        setEmailModalOpen(false);
      } else {
        alert('Error al enviar correo: ' + data.error);
      }
    } catch (e: any) {
      alert('Error en el sistema de correos: ' + e.message);
    } finally {
      setIsSendingEmail(false);
    }
  };

  const confirmSendSpEmail = async () => {
    setIsSendingSpEmail(true);
    try {
      // Generate PDF on client side to bypass Vercel Puppeteer limits
      const previewRes = await fetch(`/api/preview-report?customerId=${spEmailDraft.customerId}&invoices=${spEmailDraft.invoices.map((i: any) => i.id).join(',')}&message=${encodeURIComponent(spEmailDraft.message)}`);
      const htmlContent = await previewRes.text();
      
      // Run html2pdf inside an isolated iframe to prevent html2canvas from parsing Tailwind v4 CSS
      const iframe = document.createElement('iframe');
      iframe.style.position = 'absolute';
      iframe.style.width = '800px';
      iframe.style.height = '1000px';
      iframe.style.left = '-9999px';
      document.body.appendChild(iframe);
      
      const pdfBase64 = await new Promise<string>((resolve, reject) => {
        iframe.onload = async () => {
          try {
            const win = iframe.contentWindow as any;
            // Wait for html2pdf to be loaded in the iframe just in case
            if (!win.html2pdf) {
              await new Promise(r => setTimeout(r, 500));
            }
            const pdfStr = await win.html2pdf().set({
              margin: 10,
              filename: 'Facturas.pdf',
              image: { type: 'jpeg', quality: 0.98 },
              html2canvas: { scale: 2, useCORS: true, logging: false },
              jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            }).from(win.document.getElementById('pdf-content')).outputPdf('datauristring');
            resolve(pdfStr);
          } catch (err) {
            reject(err);
          }
        };

        iframe.contentDocument!.open();
        iframe.contentDocument!.write(`
          <!DOCTYPE html>
          <html>
            <head>
              <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
            </head>
            <body>
              <div id="pdf-content">${htmlContent}</div>
            </body>
          </html>
        `);
        iframe.contentDocument!.close();
      });
      
      document.body.removeChild(iframe);

      const res = await fetch('/api/send-salesperson-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: spEmailDraft.customerId,
          invoiceIds: spEmailDraft.invoices.map((i: any) => i.id),
          to: spEmailDraft.to,
          subject: spEmailDraft.subject,
          message: spEmailDraft.message,
          pdfBase64: pdfBase64
        })
      });
      const data = await res.json();
      
      if (res.ok) {
        if (data.previewUrl) {
          alert(`Correo simulado enviado al comercial.\nMíralo aquí: ${data.previewUrl}`);
        } else {
          alert('Correo enviado al comercial correctamente.');
        }
        
        const newSelected = { ...selectedInvoices };
        spEmailDraft.invoices.forEach((i: any) => delete newSelected[i.id]);
        setSelectedInvoices(newSelected);
        await fetchInvoices();
        setSpEmailModalOpen(false);
      } else {
        alert('Error al enviar correo al comercial: ' + data.error);
      }
    } catch (e: any) {
      alert('Error en el sistema de correos al comercial: ' + e.message);
    } finally {
      setIsSendingSpEmail(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-32">
      <header className="flex flex-wrap justify-between items-end mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-black text-black tracking-tight">
            Gestión de Recobros
          </h1>
          <p className="text-gray-700 font-semibold font-medium mt-2">Agrupación por cliente y selección avanzada.</p>
        </div>
        <div className="flex gap-4">
          <button 
            onClick={fetchInvoices}
            className="flex items-center gap-2 bg-white/10 hover:bg-gray-200 text-gray-900 px-4 py-2 rounded-lg transition-all backdrop-blur-sm border border-gray-200"
            disabled={loading || syncing}
          >
            <RefreshCcw size={18} className={loading && !syncing ? 'animate-spin' : ''} />
            Actualizar Local
          </button>
          <button 
            onClick={handleSync}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-gray-900 px-4 py-2 rounded-lg transition-all shadow-lg shadow-gray-500/20"
            disabled={loading || syncing}
          >
            <RefreshCcw size={18} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Sincronizando... (espera 1-2 min)' : 'Sincronizar BC'}
          </button>
        </div>
      </header>

      {/* Sorting & Search Controls */}
      <div className="mb-6 flex flex-col md:flex-row gap-6 bg-gray-50 p-4 rounded-xl border border-gray-200 backdrop-blur-sm">
        <div className="flex-1">
          <input 
            type="text" 
            placeholder="Buscar por cliente o nº factura..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white border border-gray-300 text-sm text-gray-900 rounded-lg px-4 py-2 outline-none focus:border-indigo-500 transition-colors placeholder-gray-500"
          />
        </div>
        
        <div className="flex flex-wrap gap-6 items-center">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-800 font-medium font-medium">Ordenar Clientes por:</span>
            <select 
              className="bg-white border border-gray-300 text-sm text-gray-900 rounded-lg px-3 py-1.5 outline-none"
              value={customerSortBy}
              onChange={(e) => setCustomerSortBy(e.target.value as any)}
            >
              <option value="amtOverdue">Mayor Importe Vencido</option>
              <option value="amtOpen">Mayor Importe Total Abierto</option>
              <option value="amtConfirmed">Mayor Importe Confirmado</option>
            </select>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-800 font-medium font-medium">Ordenar Facturas por:</span>
            <select 
              className="bg-white border border-gray-300 text-sm text-gray-900 rounded-lg px-3 py-1.5 outline-none"
              value={invoiceSortBy}
              onChange={(e) => setInvoiceSortBy(e.target.value as any)}
            >
              <option value="daysOverdue">Más días vencidos</option>
              <option value="amount">Mayor importe</option>
              <option value="reminders">Menos recordatorios</option>
            </select>
          </div>
        </div>
      </div>
      
      {/* Payment Method Filters */}
      {availablePaymentMethods.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-4 items-center bg-gray-50 p-4 rounded-xl border border-gray-200 backdrop-blur-sm">
          <span className="text-sm text-gray-800 font-medium font-medium">Filtrar por Forma de Pago:</span>
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
                Limpiar Filtro
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
          <p className="text-xl text-gray-800 font-medium">No hay facturas abiertas.</p>
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
                      <p className="text-xs text-gray-700 font-semibold">{group.customer.email || 'Sin email configurado'}</p>
                    </div>
                  </div>
                  
                  <div className="flex flex-wrap gap-6 text-sm flex-1 min-w-[350px]">
                    <div className="flex flex-col">
                      <span className="text-indigo-700 font-bold text-xs">Total Abierto</span>
                      <span className={`font-medium ${group.amtOpen > 0 ? 'text-gray-700 font-semibold font-bold' : group.amtOpen < 0 ? 'text-gray-900 font-bold' : 'text-gray-900'}`}>€{group.amtOpen.toLocaleString()}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-indigo-700 font-bold text-xs">Total Vencido</span>
                      <span className={`font-medium ${group.amtOverdue > 0 ? 'text-gray-700 font-semibold font-bold' : group.amtOverdue < 0 ? 'text-gray-900 font-bold' : 'text-gray-900'}`}>€{group.amtOverdue.toLocaleString()}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-indigo-700 font-bold text-xs">Total Confirmado</span>
                      <span className={`font-medium ${group.amtConfirmed > 0 ? 'text-gray-700 font-semibold font-bold' : group.amtConfirmed < 0 ? 'text-gray-900 font-bold' : 'text-gray-900'}`}>€{group.amtConfirmed.toLocaleString()}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-indigo-700 font-bold text-xs">Facturas</span>
                      <span className="font-medium text-gray-900">{group.totalCount} ({group.overdueCount} vencidas)</span>
                    </div>
                    {/* Salesperson info */}
                    <div className="flex flex-col border-l border-gray-200 pl-4">
                      <span className="text-emerald-700 font-bold text-xs flex items-center gap-1">
                        <Briefcase size={12} /> Comercial
                      </span>
                      <span className="font-medium text-gray-900">
                        {group.customer.salespersonName || 'Sin asignar'}
                      </span>
                      {group.customer.salespersonReminderCount > 0 && (
                        <span className="text-[10px] text-gray-900 font-bold/80">
                          {group.customer.salespersonReminderCount} avisos (Últ: {new Date(group.customer.salespersonLastReminderDate).toLocaleDateString()})
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
                      Avisar Cliente ({selectedCount})
                    </button>
                    <button
                      onClick={() => openSpEmailModal(group)}
                      className={`flex items-center justify-center w-full sm:w-auto gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                        !hasSelection || !group.customer.salespersonName
                          ? 'bg-gray-100 text-gray-900 font-bold hover:bg-gray-200'
                          : 'bg-gray-600 hover:bg-gray-500 text-white shadow-md'
                      }`}
                    >
                      <Briefcase size={16} />
                      Avisar Comercial
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
                        Todas las Vencidas
                      </button>
                      <button 
                        onClick={() => toggleSelectCustomerInvoices(group.invoices, false)}
                        className="text-xs bg-white/10 hover:bg-gray-200 text-gray-800 font-medium px-3 py-1.5 rounded border border-gray-100"
                      >
                        Deseleccionar
                      </button>
                      <button 
                        onClick={() => applySmartSelection(group.customer.id, group.invoices, 'zero')}
                        className={`text-xs px-3 py-1.5 rounded flex items-center gap-1 border border-indigo-500/30 transition-colors ${smartFilters[group.customer.id] === 'zero' ? 'bg-indigo-500/40 text-indigo-100' : 'bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-700 font-bold'}`}
                      >
                        <Filter size={12}/> 0 Recordatorios
                      </button>
                      <button 
                        onClick={() => applySmartSelection(group.customer.id, group.invoices, 'seven_days')}
                        className={`text-xs px-3 py-1.5 rounded flex items-center gap-1 border border-orange-500/30 transition-colors ${smartFilters[group.customer.id] === 'seven_days' ? 'bg-orange-500/40 text-orange-100' : 'bg-orange-500/10 hover:bg-orange-500/20 text-orange-300'}`}
                      >
                        <Filter size={12}/> Último &gt; 7 días
                      </button>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm text-gray-800 font-medium">
                        <thead className="text-gray-900 font-bold border-b border-gray-200">
                          <tr>
                            <th className="pb-2 w-8"></th>
                            <th className="pb-2 font-medium">Documento</th>
                            <th className="pb-2 font-medium">Tipo</th>
                            <th className="pb-2 font-medium">Forma Pago</th>
                            <th className="pb-2 font-medium">Moneda</th>
                            <th className="pb-2 font-medium">Imp. Original</th>
                            <th className="pb-2 font-medium">Imp. Restante</th>
                            <th className="pb-2 font-medium">Vencimiento</th>
                            <th className="pb-2 font-medium">Estado</th>
                            <th className="pb-2 font-medium">Recordatorios</th>
                            <th className="pb-2 font-medium">Fecha Recordatorio</th>
                            <th className="pb-2 font-medium">Fecha Pago Confirmado</th>
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
                              <td className="py-2 text-gray-900 font-bold">€{(inv.originalAmount || 0).toLocaleString()}</td>
                              <td className="py-2 font-semibold">
                                {inv.originalAmount && inv.originalAmount !== inv.amount ? (
                                  <div className="flex items-center gap-2">
                                    <span className="text-amber-400">€{inv.amount.toLocaleString()}</span>
                                    <span className="text-[10px] uppercase tracking-wider bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/30">Parcial</span>
                                  </div>
                                ) : (
                                  <span className={inv.amount > 0 ? "text-gray-700 font-semibold font-bold" : inv.amount < 0 ? "text-gray-900 font-bold" : "text-gray-900"}>€{inv.amount.toLocaleString()}</span>
                                )}
                              </td>
                              <td className="py-2 text-gray-700 font-semibold">{new Date(inv.dueDate).toLocaleDateString()}</td>
                              <td className="py-2">
                                {inv.isOverdue ? (
                                  <span className="text-gray-700 font-semibold font-bold font-medium">{inv.daysOverdue} días</span>
                                ) : (
                                  <span className="text-gray-900 font-bold">Al día</span>
                                )}
                              </td>
                              <td className="py-2">{inv.reminderCount}</td>
                              <td className="py-2 text-gray-700 font-semibold">
                                {inv.lastReminderSentAt ? new Date(inv.lastReminderSentAt).toLocaleDateString() : '-'}
                              </td>
                              <td className="py-2 font-medium text-gray-900 font-bold">
                                {inv.confirmedPaymentDate ? new Date(inv.confirmedPaymentDate).toLocaleDateString() : '-'}
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

      {/* Customer Email Modal */}
      {emailModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-gray-200 p-6 rounded-2xl w-full max-w-2xl shadow-2xl">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Avisar al Cliente</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-900 font-bold mb-1">Destinatario (Para)</label>
                <input 
                  type="email" 
                  value={emailDraft.to}
                  onChange={e => setEmailDraft({...emailDraft, to: e.target.value})}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-gray-900 outline-none focus:border-indigo-500"
                  placeholder="cliente@empresa.com"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-900 font-bold mb-1">Asunto</label>
                <input 
                  type="text" 
                  value={emailDraft.subject}
                  onChange={e => setEmailDraft({...emailDraft, subject: e.target.value})}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-gray-900 outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-900 font-bold mb-1">Mensaje</label>
                <textarea 
                  value={emailDraft.message}
                  onChange={e => setEmailDraft({...emailDraft, message: e.target.value})}
                  className="w-full h-48 bg-gray-50 border border-gray-200 rounded-lg p-3 text-gray-900 outline-none focus:border-indigo-500 resize-none"
                ></textarea>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              {emailDraft.invoices.length > 0 && (
                <a 
                  href={`/api/preview-report?customerId=${emailDraft.customerId}&invoices=${emailDraft.invoices.map((i: any) => i.id).join(',')}&message=${encodeURIComponent(emailDraft.message)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mr-auto px-4 py-2 rounded-lg text-black bg-blue-400/10 hover:bg-blue-400/20 transition-colors flex items-center gap-2"
                >
                  📄 Ver / Guardar PDF
                </a>
              )}
              <button 
                onClick={() => setEmailModalOpen(false)}
                className="px-4 py-2 rounded-lg text-gray-800 font-medium hover:bg-gray-50 transition-colors"
              >
                Cancelar
              </button>
              <button 
                onClick={confirmSendEmail}
                disabled={isSendingEmail || !emailDraft.to}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                  isSendingEmail || !emailDraft.to
                    ? 'bg-indigo-500/50 text-gray-900/50 cursor-not-allowed'
                    : 'bg-indigo-500 hover:bg-indigo-400 text-gray-900 shadow-lg shadow-gray-500/20'
                }`}
              >
                <Send size={16} className={isSendingEmail ? 'animate-pulse' : ''} />
                {isSendingEmail ? 'Enviando...' : 'Enviar Correo'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Salesperson Email Modal */}
      {spEmailModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-gray-300 p-6 rounded-2xl w-full max-w-2xl shadow-2xl">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Avisar al Comercial</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-900 font-bold/80 mb-1">Destinatario (Comercial)</label>
                <input 
                  type="email" 
                  value={spEmailDraft.to}
                  onChange={e => setSpEmailDraft({...spEmailDraft, to: e.target.value})}
                  className="w-full bg-gray-50 border border-emerald-500/20 rounded-lg p-2.5 text-gray-900 outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-900 font-bold/80 mb-1">Asunto</label>
                <input 
                  type="text" 
                  value={spEmailDraft.subject}
                  onChange={e => setSpEmailDraft({...spEmailDraft, subject: e.target.value})}
                  className="w-full bg-gray-50 border border-emerald-500/20 rounded-lg p-2.5 text-gray-900 outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-900 font-bold/80 mb-1">Mensaje (Personalizable)</label>
                <textarea 
                  value={spEmailDraft.message}
                  onChange={e => setSpEmailDraft({...spEmailDraft, message: e.target.value})}
                  className="w-full h-32 bg-gray-50 border border-emerald-500/20 rounded-lg p-3 text-gray-900 outline-none focus:border-emerald-500 resize-none"
                ></textarea>
              </div>
              <div className="bg-emerald-500/10 rounded-lg p-4 border border-emerald-500/20">
                <p className="text-sm text-emerald-700 font-bold font-medium mb-2">Se adjuntará un informe automático PDF/HTML con la siguiente información:</p>
                <ul className="text-xs text-emerald-200/80 list-disc list-inside space-y-1">
                  <li>Diseño CRAZE con cabecera y datos de empresa.</li>
                  <li>Listado de las {spEmailDraft.invoices.length} facturas seleccionadas.</li>
                  <li>Días de retraso e importe de cada factura.</li>
                </ul>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              {spEmailDraft.invoices.length > 0 && (
                <a 
                  href={`/api/preview-report?customerId=${spEmailDraft.customerId}&invoices=${spEmailDraft.invoices.map((i: any) => i.id).join(',')}&message=${encodeURIComponent(spEmailDraft.message)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mr-auto px-4 py-2 rounded-lg text-gray-900 font-bold bg-emerald-400/10 hover:bg-emerald-400/20 transition-colors flex items-center gap-2"
                >
                  📄 Ver / Guardar PDF
                </a>
              )}
              <button 
                onClick={() => setSpEmailModalOpen(false)}
                className="px-4 py-2 rounded-lg text-gray-800 font-medium hover:bg-gray-50 transition-colors"
              >
                Cancelar
              </button>
              <button 
                onClick={confirmSendSpEmail}
                disabled={isSendingSpEmail || !spEmailDraft.to}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                  isSendingSpEmail || !spEmailDraft.to
                    ? 'bg-emerald-600/50 text-gray-900/50 cursor-not-allowed'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-gray-900 shadow-lg shadow-gray-500/20'
                }`}
              >
                <Briefcase size={16} className={isSendingSpEmail ? 'animate-pulse' : ''} />
                {isSendingSpEmail ? 'Generando y Enviando...' : 'Avisar Comercial'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
