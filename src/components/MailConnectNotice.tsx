'use client';

import { useEffect, useState } from 'react';

// Aviso al volver de "Conectar mi correo" (?mail=conectado|otra_cuenta|sin_permiso|error&detail=)
const TEXT: Record<string, string> = {
  conectado: 'Correo conectado: tus recordatorios saldrán desde tu propio buzón (y quedarán en tus Elementos enviados).',
  otra_cuenta: 'La cuenta de Microsoft elegida no es la de tu usuario de la app. Vuelve a intentarlo con tu cuenta.',
  sin_permiso: 'Microsoft no ha dado acceso permanente al correo. Vuelve a intentarlo.',
  error: 'No se pudo conectar el correo.',
};

export default function MailConnectNotice() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const m = p.get('mail');
    if (!m) return;
    const detail = p.get('detail') || '';
    const admin = /AADSTS65001|AADSTS90094|admin/i.test(detail);
    setMsg({ ok: m === 'conectado', text: `${TEXT[m] || TEXT.error}${m === 'error' ? (admin ? ' Hace falta que un administrador de Microsoft 365 apruebe el permiso "Mail.Send" (delegado) de la aplicación.' : detail ? ` (${detail})` : '') : ''}` });
    p.delete('mail'); p.delete('detail');
    window.history.replaceState(null, '', `${window.location.pathname}${p.toString() ? `?${p}` : ''}`);
  }, []);
  if (!msg) return null;
  return (
    <div className={`mb-4 flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${msg.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
      <span>{msg.text}</span>
      <button onClick={() => setMsg(null)} className="font-bold">×</button>
    </div>
  );
}
