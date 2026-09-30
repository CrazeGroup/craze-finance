'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, User } from 'lucide-react';
import Image from 'next/image';

const SSO_ERRORS: Record<string, string> = {
  sso_not_registered: 'Tu cuenta de Microsoft no está dada de alta en la aplicación. Contacta con un administrador.',
  sso_cancelled: 'Inicio de sesión con Microsoft cancelado',
  sso_invalid: 'No se pudo validar el inicio de sesión con Microsoft. Inténtalo de nuevo.',
  sso_config: 'El inicio de sesión con Microsoft no está configurado',
};

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    if (code) setError(SSO_ERRORS[code] || 'Error al iniciar sesión');
  }, []);

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
        setError(data.error || 'Error al iniciar sesión');
        setLoading(false);
      } else {
        // Redirigir al inicio recargando para que el RootLayout lea la sesión
        window.location.href = '/';
      }
    } catch (err) {
      setError('Error de conexión');
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
            Iniciar Sesión
          </h1>
          <p className="text-gray-500 text-sm font-medium">
            Accede a tu panel financiero
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-lg text-sm mb-6 text-center">
            {error}
          </div>
        )}

        <a
          href="/api/auth/microsoft/login"
          className="w-full flex items-center justify-center gap-3 py-3 px-4 border border-gray-300 rounded-xl text-sm font-bold text-gray-800 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-black transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          Iniciar sesión con Microsoft
        </a>

        <div className="flex items-center my-6">
          <div className="flex-1 border-t border-gray-200"></div>
          <span className="px-3 text-xs font-medium text-gray-400">o con usuario y contraseña</span>
          <div className="flex-1 border-t border-gray-200"></div>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">Usuario</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <User size={18} className="text-gray-400" />
              </div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl bg-gray-50 text-black placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent transition-all"
                placeholder="tu.usuario"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">Contraseña</label>
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
              'Entrar'
            )}
          </button>
        </form>

      </div>
    </div>
  );
}
