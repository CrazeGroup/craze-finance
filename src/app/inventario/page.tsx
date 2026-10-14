"use client";

import { useState } from 'react';
import { Save, Calculator, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

type Row = {
  itemNo: string; description: string; inventory: number; systemUnitCost: number; calculatedMeanCost: number;
  purchasedQty: number; purchaseEntries: number; invActual: number; invNuevo: number; invDiff: number;
};
type Summary = { totalSystemVal: number; totalNewVal: number; difference: number };

const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().substring(0, 7); };
const eur = (v: number) => `€${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function InventarioPage() {
  const { selectedCompany } = useCompany();
  const [month, setMonth] = useState<string>(lastMonth);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [date, setDate] = useState('');
  const [saved, setSaved] = useState(false);

  // Cálculo en directo de BC (movimientos de valor, fichas de producto y movimientos de compra hasta fin de mes)
  const calculate = async (force = false) => {
    setIsProcessing(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch(`/api/inventory-valuation/calculate?month=${month}${force ? '&force=1' : ''}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
      setResults(json.rows);
      setSummary(json.summary);
      setDate(json.date);
    } catch (err: any) {
      setError(err.message);
      setResults([]);
      setSummary(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const saveToDatabase = async () => {
    if (!summary) return;
    try {
      const selectedDate = new Date(`${month}-01T12:00:00Z`);
      const res = await fetch('/api/inventory-valuation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          month: selectedDate.toISOString(),
          totalSystemVal: summary.totalSystemVal,
          totalNewVal: summary.totalNewVal,
          difference: summary.difference,
          details: null,
        }),
      });
      if (!res.ok) throw new Error('API error');
      setSaved(true);
    } catch (err) {
      console.error('Save error', err);
      alert('Error al guardar en la base de datos.');
    }
  };

  if (selectedCompany === 'ALL') {
    return <div className="min-h-screen p-8"><p className="text-sm text-gray-600">Selecciona una empresa concreta en el menú lateral.</p></div>;
  }

  return (
    <div className="min-h-screen p-8 pb-32 overflow-y-auto">
      <div className="max-w-7xl mx-auto space-y-12">
        <header>
          <h1 className="text-4xl font-black text-black tracking-tight">Cálculo de Inventario (Coste Medio)</h1>
          <p className="text-gray-500 mt-2 font-medium max-w-3xl">
            Valoración a coste medio ponderado de las compras frente a la valoración de Business Central, por producto, a fin de mes.
            Se lee en directo de BC ({selectedCompany}): movimientos de valor, fichas de producto y movimientos de compra y ensamblado.
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-6 md:col-span-1 shadow-sm border border-gray-100 flex flex-col gap-6 bg-white rounded-xl">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Mes de Cierre</label>
              <input type="month" value={month} onChange={e => { setMonth(e.target.value); setSaved(false); }}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-blue-500 focus:border-blue-500 outline-none shadow-sm" />
            </div>
            <div className="pt-4 border-t border-gray-100 space-y-2">
              <button onClick={() => calculate()} disabled={isProcessing || !month}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                <Calculator className={`w-5 h-5 ${isProcessing ? 'animate-spin' : ''}`} />
                {isProcessing ? 'Leyendo Business Central…' : 'Calcular Coste Medio desde BC'}
              </button>
              {summary && (
                <button onClick={() => calculate(true)} disabled={isProcessing}
                  className="w-full text-xs text-gray-500 hover:text-gray-900 flex items-center justify-center gap-1 disabled:opacity-50">
                  <RefreshCw className="w-3 h-3" /> Volver a leer de BC (sin caché)
                </button>
              )}
            </div>
            {error && <p className="text-sm text-red-700 flex items-start gap-2"><AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}</p>}
          </div>

          {summary && (
            <div className="p-6 md:col-span-2 shadow-sm border border-gray-100 flex flex-col justify-between bg-white rounded-xl relative overflow-hidden">
              <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
                <AlertCircle className="w-48 h-48" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 mb-1">Resultado del Análisis</h2>
                <p className="text-xs text-gray-500 mb-6">A {date.split('-').reverse().join('/')} · {results.length} productos de inventario</p>
                <div className="grid grid-cols-3 gap-6">
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <p className="text-sm font-medium text-gray-500 mb-1">Valoración Sistema (BC)</p>
                    <p className="text-2xl font-bold text-gray-900">{eur(summary.totalSystemVal)}</p>
                  </div>
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <p className="text-sm font-medium text-gray-500 mb-1">Valoración Coste Medio</p>
                    <p className="text-2xl font-bold text-gray-900">{eur(summary.totalNewVal)}</p>
                  </div>
                  <div className={`p-4 rounded-xl border ${summary.difference > 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                    <p className="text-sm font-medium text-gray-700 mb-1">Diferencia Total</p>
                    <p className={`text-2xl font-bold ${summary.difference > 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {summary.difference > 0 ? '+' : ''}{eur(summary.difference)}
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-8 pt-6 border-t border-gray-100 flex items-end justify-end">
                <button onClick={saveToDatabase} disabled={saved}
                  className={`font-medium py-3 px-6 rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 ${saved ? 'bg-green-100 text-green-700 cursor-not-allowed' : 'bg-black hover:bg-gray-800 text-white'}`}>
                  {saved ? <><CheckCircle2 className="w-5 h-5" /> Guardado en Dashboard</> : <><Save className="w-5 h-5" /> Guardar Cierre Mensual</>}
                </button>
              </div>
            </div>
          )}
        </div>

        {results.length > 0 && (
          <div className="shadow-sm border border-gray-100 bg-white rounded-xl overflow-hidden mt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-gray-600">
                <thead className="bg-gray-50 text-gray-700 border-b border-gray-200 text-xs uppercase font-semibold">
                  <tr>
                    <th className="px-6 py-4">Nº Producto</th>
                    <th className="px-6 py-4">Descripción</th>
                    <th className="px-6 py-4 text-right">Cantidad (BC)</th>
                    <th className="px-6 py-4 text-right">Coste BC</th>
                    <th className="px-6 py-4 text-right">Nuevo Coste Medio</th>
                    <th className="px-6 py-4 text-right">Val. Sistema</th>
                    <th className="px-6 py-4 text-right">Val. Nueva</th>
                    <th className="px-6 py-4 text-right">Diferencia</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {results.map(item => (
                    <tr key={item.itemNo} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3 font-medium text-gray-900">{item.itemNo}</td>
                      <td className="px-6 py-3 max-w-xs truncate" title={item.description}>{item.description}</td>
                      <td className="px-6 py-3 text-right">{item.inventory.toLocaleString()}</td>
                      <td className="px-6 py-3 text-right">€{item.systemUnitCost.toFixed(2)}</td>
                      <td className="px-6 py-3 text-right font-medium text-blue-600" title={item.purchaseEntries ? `${item.purchaseEntries} movimientos de compra/ensamblado, ${item.purchasedQty.toLocaleString()} uds` : 'Sin compras: coste de la ficha'}>
                        €{item.calculatedMeanCost.toFixed(2)}
                      </td>
                      <td className="px-6 py-3 text-right">€{item.invActual.toFixed(2)}</td>
                      <td className="px-6 py-3 text-right">€{item.invNuevo.toFixed(2)}</td>
                      <td className={`px-6 py-3 text-right font-bold ${item.invDiff > 0 ? 'text-green-600' : item.invDiff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                        {item.invDiff > 0 ? '+' : ''}€{item.invDiff.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
