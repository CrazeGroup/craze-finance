'use client';

import { useState, useEffect } from 'react';
import { History } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface ActionLog {
  id: number;
  date: string;
  user: string;
  action: string;
  details?: string;
  companyId?: string;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<ActionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/logs')
      .then(res => {
        if (!res.ok) throw new Error('No autorizado o error del servidor');
        return res.json();
      })
      .then(data => {
        if (data.error) throw new Error(data.error);
        setLogs(data);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="w-full space-y-8">
        <header className="mb-12">
          <h1 className="text-4xl font-extrabold text-black tracking-tight flex items-center gap-4">
            <History size={36} className="text-black" />
            Registro de Actividad
          </h1>
          <p className="text-gray-500 mt-2 text-lg">
            Auditoría de acciones realizadas por los usuarios en la plataforma.
          </p>
        </header>

        {error && (
          <div className="bg-red-50 text-red-700 p-4 rounded-lg font-semibold border border-red-200">
            {error}
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          {loading ? (
            <div className="p-12 text-center text-gray-500 font-semibold animate-pulse">
              Cargando registros...
            </div>
          ) : logs.length === 0 ? (
            <div className="p-12 text-center text-gray-500 font-semibold">
              No hay acciones registradas aún.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-gray-600 text-sm font-semibold uppercase tracking-wider">
                    <th className="p-4 border-b border-gray-100">Fecha y Hora</th>
                    <th className="p-4 border-b border-gray-100">Usuario</th>
                    <th className="p-4 border-b border-gray-100">Empresa</th>
                    <th className="p-4 border-b border-gray-100">Acción</th>
                    <th className="p-4 border-b border-gray-100">Detalles</th>
                  </tr>
                </thead>
                <tbody className="text-sm font-medium text-gray-800 divide-y divide-gray-50">
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                      <td className="p-4 whitespace-nowrap text-gray-500">
                        {format(new Date(log.date), "dd MMM yyyy, HH:mm", { locale: es })}
                      </td>
                      <td className="p-4">{log.user}</td>
                      <td className="p-4">{log.companyId || '-'}</td>
                      <td className="p-4 font-bold text-black">{log.action}</td>
                      <td className="p-4 text-gray-600" title={log.details || ''}>
                        {log.details || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
