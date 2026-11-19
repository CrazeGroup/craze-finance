'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, User } from 'lucide-react';
import Image from 'next/image';
import { useT } from '@/contexts/LanguageContext';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { t, tx } = useT();

  // Errores de la vuelta del inicio de sesión con Microsoft (/login?error=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('error'), detail = params.get('detail');
    const messages: Record<string, string> = {
      sso_config: t('Microsoft sign-in is not configured yet.'),
      sso_usuario: t('Your Microsoft account does not have access to this application.'),
      sso_cancelado: t('Microsoft sign-in was cancelled.'),
      sso_state: t('The Microsoft sign-in session has expired. Please try again.'),
      sso_error: t('Could not sign in with Microsoft.'),
    };
    if (code) setError((messages[code] || t('Sign-in error')) + (detail ? ` (${detail})` : ''));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t('Sign-in error'));
        setLoading(false);
      } else {
        // Redirigir al inicio recargando para que el RootLayout lea la sesión
        window.location.href = '/';
      }
    } catch (err) {
      setError(t('Connection error'));
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="mb-8">
        <Image src="/logo.png" alt="Craze Group Logo" width={200} height={60} className="object-contain" />
      </div>
      <div className="max-w-md w-full bg-white border border-gray-200 rounded-2xl p-8 shadow-xl">
        
        <div className="text-center mb-8">
          <h1 className="text-2xl font-black text-black mb-2">
            {t('Sign In')}
          </h1>
          <p className="text-gray-500 text-sm font-medium">
            {t('Access your financial dashboard')}
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-lg text-sm mb-6 text-center">
            {tx(error)}
          </div>
        )}

        <a
          href="/api/auth/microsoft"
          className="w-full flex items-center justify-center gap-3 py-3 px-4 border border-gray-300 rounded-xl text-sm font-bold text-black bg-white hover:bg-gray-50 transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#F25022" /><rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
            <rect x="1" y="11" width="9" height="9" fill="#00A4EF" /><rect x="11" y="11" width="9" height="9" fill="#FFB900" />
          </svg>
          {t('Sign in with Microsoft')}
        </a>

        <div className="flex items-center gap-3 my-6 text-xs text-gray-400">
          <div className="flex-1 h-px bg-gray-200" />{t('or with username and password')}<div className="flex-1 h-px bg-gray-200" />
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">{t('Username')}</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <User size={18} className="text-gray-400" />
              </div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl bg-gray-50 text-black placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent transition-all"
                placeholder={t('your.username')}
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">{t('Password')}</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock size={18} className="text-gray-400" />
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl bg-gray-50 text-black placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent transition-all"
                placeholder="••••••••"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-black hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-black disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            ) : (
              t('Log in')
            )}
          </button>
        </form>

      </div>
    </div>
  );
}
