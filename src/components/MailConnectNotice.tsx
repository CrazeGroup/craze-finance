'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/contexts/LanguageContext';

// Aviso al volver de "Conectar mi correo" (?mail=conectado|otra_cuenta|sin_permiso|error&detail=)
const TEXT: Record<string, string> = {
  conectado: 'Mail connected: your reminders will be sent from your own mailbox (and will appear in your Sent Items).',
  otra_cuenta: 'The selected Microsoft account is not the one of your app user. Please try again with your account.',
  sin_permiso: 'Microsoft did not grant permanent access to the mailbox. Please try again.',
  error: 'Could not connect the mailbox.',
};

export default function MailConnectNotice() {
  const { t } = useT();
  // Se guarda la clave y el detalle, y el texto se traduce al mostrarlo
  const [msg, setMsg] = useState<{ ok: boolean; key: string; isError: boolean; admin: boolean; detail: string } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const m = p.get('mail');
    if (!m) return;
    const detail = p.get('detail') || '';
    const admin = /AADSTS65001|AADSTS90094|admin/i.test(detail);
    setMsg({ ok: m === 'conectado', key: TEXT[m] ? m : 'error', isError: m === 'error', admin, detail });
    p.delete('mail'); p.delete('detail');
    window.history.replaceState(null, '', `${window.location.pathname}${p.toString() ? `?${p}` : ''}`);
  }, []);
  if (!msg) return null;
  return (
    <div className={`mb-4 flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${msg.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
      <span>{t(TEXT[msg.key])}{msg.isError ? (msg.admin ? ` ${t('A Microsoft 365 administrator needs to approve the application\'s "Mail.Send" (delegated) permission.')}` : msg.detail ? ` (${msg.detail})` : '') : ''}</span>
      <button onClick={() => setMsg(null)} className="font-bold">×</button>
    </div>
  );
}
