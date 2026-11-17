'use client';

import { useEffect, useMemo, useState } from 'react';
import { Send, X } from 'lucide-react';
import { buildReminderPdf, previewReportUrl } from '@/lib/reminderPdf';
import { claimCountOf } from '@/lib/claimLevel';

// Recordatorio al cliente, el mismo en Recobros y en Cashflow. Tres niveles:
// 1 = normal; 2 = se puede poner al comercial en copia; 3 = además, aviso de que pasaremos el caso a la aseguradora.
// El nivel propuesto es la siguiente reclamación de las facturas (máx. 3). Al enviar, las facturas quedan con
// una reclamación más cada una (claimCount + 1, cada factura con su propio nº, que sale en el PDF) y lastReminderDate = hoy.
type Customer = { id: number; bcId?: string; name: string; email?: string | null; salespersonCode?: string | null; salespersonName?: string | null };
type Inv = { id: number; bcId: string; amount: number; dueDate: string; currencyCode?: string | null; lastReminderDate?: string | null; claimCount?: number | null };

export const INSURANCE_TEXT = 'If we do not receive payment or a reply from you within the next 7 days, we will be obliged to hand this matter over to our credit insurance agency.';

const SUBJECTS: Record<number, string> = {
  1: 'Payment reminder - overdue invoices',
  2: 'Second payment reminder - overdue invoices',
  3: 'Final payment reminder - overdue invoices',
};
const INTRO: Record<number, string> = {
  1: 'We are contacting you to remind you that there are overdue invoices pending payment on your account.\nWe would appreciate it if you could settle this matter as soon as possible.',
  2: 'We are contacting you again regarding the overdue invoices below, which remain unpaid despite our previous reminder.\nPlease arrange the payment as soon as possible or let us know the expected payment date.',
  3: 'Despite our previous reminders, the invoices below are still unpaid. This is our final reminder.\nPlease settle the outstanding amount immediately.',
};

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th'}`;
const money = (n: number, cur?: string | null) => `${cur && cur !== 'EUR' ? `${cur} ` : '€'}${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function buildMessage(name: string, level: number, invoices: Inv[], insurance: boolean) {
  const list = invoices.map(i => `- Invoice ${i.bcId}: ${money(i.amount, i.currencyCode)} (Overdue on ${new Date(i.dueDate).toLocaleDateString('de-DE')}, ${ordinal(claimCountOf(i) + 1)} reminder)`).join('\n');
  return `Dear ${name},\n\n${INTRO[level]}\n\n${list}${insurance ? `\n\n${INSURANCE_TEXT}` : ''}`;
}

export default function ReminderDialog({ customer, invoices, onClose, onSent }: {
  customer: Customer; invoices: Inv[]; onClose: () => void; onSent: () => void;
}) {
  const proposed = Math.min(3, Math.max(...invoices.map(claimCountOf), 0) + 1);
  const [level, setLevel] = useState(proposed);
  const [ccSales, setCcSales] = useState(proposed >= 2);
  const [insurance, setInsurance] = useState(proposed >= 3);
  const [to, setTo] = useState(customer.email || '');
  const [spEmail, setSpEmail] = useState('');
  const [spLoading, setSpLoading] = useState(false);
  const [subject, setSubject] = useState(`${SUBJECTS[proposed]} - ${customer.name}`);
  const [message, setMessage] = useState(buildMessage(customer.name, proposed, invoices, proposed >= 3));
  const [sending, setSending] = useState(false);

  // Email del comercial (BC) en cuanto se necesita
  useEffect(() => {
    if (!ccSales || spEmail || (!customer.salespersonCode && !customer.salespersonName)) return;
    setSpLoading(true);
    const q = new URLSearchParams({ code: customer.salespersonCode || '', name: customer.salespersonName || '' });
    fetch(`/api/salespeople/email?${q}`).then(r => r.json()).then(d => setSpEmail(d.email || '')).catch(() => {}).finally(() => setSpLoading(false));
  }, [ccSales]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeLevel = (l: number) => {
    setLevel(l);
    const ins = l >= 3;
    setCcSales(l >= 2);
    setInsurance(ins);
    setSubject(`${SUBJECTS[l]} - ${customer.name}`);
    setMessage(buildMessage(customer.name, l, invoices, ins));
  };
  const toggleInsurance = (on: boolean) => {
    setInsurance(on);
    setMessage(m => on ? (m.includes(INSURANCE_TEXT) ? m : `${m.trimEnd()}\n\n${INSURANCE_TEXT}`) : m.replace(`\n\n${INSURANCE_TEXT}`, '').replace(INSURANCE_TEXT, ''));
  };

  const total = useMemo(() => invoices.reduce((s, i) => s + i.amount, 0), [invoices]);
  const cc = ccSales && level >= 2 ? spEmail.trim() : '';
  const ids = invoices.map(i => i.id);

  const send = async () => {
    setSending(true);
    try {
      const pdfBase64 = await buildReminderPdf(customer.id, ids, message);
      const res = await fetch('/api/send-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: customer.id, invoiceIds: ids, to, cc, subject, message, pdfBase64, level, insurance }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error);
      alert(data.previewUrl ? `Correo simulado enviado.\nMíralo aquí: ${data.previewUrl}` : `Recordatorio ${level} enviado a ${to}${cc ? ` (copia a ${cc})` : ''}.`);
      onSent();
    } catch (e: any) {
      alert(`Error al enviar el recordatorio: ${e.message || e}`);
    } finally {
      setSending(false);
    }
  };

  const box = 'w-full bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-sm text-gray-900 outline-none focus:border-black';
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white border border-gray-200 p-6 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[95vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Recordatorio al cliente</h2>
            <p className="text-sm text-gray-600">{customer.bcId ? `#${customer.bcId} · ` : ''}{customer.name} · {invoices.length} factura(s) · {money(total, invoices[0]?.currencyCode)}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-black"><X size={20} /></button>
        </div>

        {/* Nivel del recordatorio */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {[1, 2, 3].map(l => (
            <button key={l} type="button" onClick={() => changeLevel(l)}
              className={`rounded-lg border px-3 py-2 text-left ${level === l ? 'border-black bg-black text-white' : 'border-gray-200 hover:border-gray-400'}`}>
              <div className="text-sm font-bold">{l}º recordatorio{l === proposed ? ' · sugerido' : ''}</div>
              <div className={`text-[11px] ${level === l ? 'text-gray-300' : 'text-gray-500'}`}>{l === 1 ? 'Normal' : l === 2 ? 'Comercial en copia' : 'Aviso aseguradora'}</div>
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-bold text-gray-900 mb-1">Para</label>
            <input type="text" value={to} onChange={e => setTo(e.target.value)} className={box} placeholder="cliente@empresa.com (varios separados por coma)" />
            {!customer.email && <p className="text-xs text-amber-700 mt-1">El cliente no tiene email en su ficha de BC.</p>}
          </div>

          {level >= 2 && (
            <div className="rounded-lg border border-gray-200 p-3 space-y-2">
              <label className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <input type="checkbox" checked={ccSales} onChange={e => setCcSales(e.target.checked)} />
                Comercial en copia{customer.salespersonName ? ` (${customer.salespersonName})` : ''}
              </label>
              {ccSales && (
                <input type="text" value={spEmail} onChange={e => setSpEmail(e.target.value)} className={box}
                  placeholder={spLoading ? 'Buscando el email del comercial en BC…' : 'email del comercial'} />
              )}
              {ccSales && !spLoading && !spEmail && <p className="text-xs text-amber-700">{customer.salespersonName ? 'El comercial no tiene email en BC: escríbelo aquí.' : 'El cliente no tiene comercial asignado: escribe el email.'}</p>}
              {level >= 3 && (
                <label className="flex items-start gap-2 text-sm font-semibold text-gray-900">
                  <input type="checkbox" className="mt-0.5" checked={insurance} onChange={e => toggleInsurance(e.target.checked)} />
                  <span>Añadir aviso de aseguradora <span className="block text-xs font-normal text-gray-500">“{INSURANCE_TEXT}”</span></span>
                </label>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-bold text-gray-900 mb-1">Asunto</label>
            <input type="text" value={subject} onChange={e => setSubject(e.target.value)} className={box} />
          </div>
          <div>
            <label className="block text-sm font-bold text-gray-900 mb-1">Mensaje (también va en el PDF)</label>
            <textarea value={message} onChange={e => setMessage(e.target.value)} className={`${box} h-52 resize-y`} />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-5">
          <a href={previewReportUrl(customer.id, ids, message)} target="_blank" rel="noopener noreferrer"
            className="mr-auto px-4 py-2 rounded-lg text-sm font-semibold text-black bg-gray-100 hover:bg-gray-200">📄 Ver PDF</a>
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-100">Cancelar</button>
          <button onClick={send} disabled={sending || !to.trim() || (ccSales && level >= 2 && !spEmail.trim() && spLoading)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-black text-white hover:bg-gray-800 disabled:opacity-40">
            <Send size={16} className={sending ? 'animate-pulse' : ''} /> {sending ? 'Enviando…' : `Enviar ${level}º recordatorio`}
          </button>
        </div>
      </div>
    </div>
  );
}
