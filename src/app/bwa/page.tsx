'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { ChevronRight, Search, Download, Filter, TrendingUp, DollarSign, Package, BarChart3, PieChart, Layers, ArrowUpRight, ArrowDownRight, Upload, FileSpreadsheet, Trash2, CheckCircle, RefreshCw } from 'lucide-react';

const formatCurrency = (val: number, currency = 'EUR') => {
  return new Intl.NumberFormat('de-DE', { 
    style: 'currency', 
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(val || 0);
};

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function BWAPage() {
  const { selectedCompany } = useCompany();
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [bwaData, setBwaData] = useState<any[]>([]);
  const [kpis, setKpis] = useState<{ code: string; description: string; total: number }[]>([]);
  const [currency, setCurrency] = useState('EUR');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState({ n: 0, force: false });

  const [expandedLevels, setExpandedLevels] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const fmt = (v: number) => formatCurrency(v, currency);

  // BWA del año en directo de BC (líneas BWA, mapeo de cuentas y movimientos contables de la empresa)
  useEffect(() => {
    if (selectedCompany === 'ALL') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/bwa/live?year=${year}${reload.force ? '&force=1' : ''}`)
      .then(async res => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(json.error || 'Error al leer la BWA de BC'); setBwaData([]); return; }
        setBwaData(json.rows);
        setKpis(json.kpis || []);
        setCurrency(json.currency || 'EUR');
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCompany, year, reload]);

  const toggleLevel = (levelId: string) => {
    const newSet = new Set(expandedLevels);
    if (newSet.has(levelId)) {
      newSet.delete(levelId);
    } else {
      newSet.add(levelId);
    }
    setExpandedLevels(newSet);
  };

  const filteredData = useMemo(() => {
    if (!searchTerm) return bwaData;
    const term = searchTerm.toLowerCase();
    return bwaData.filter((item: any) => 
      item.BwaGroup.toLowerCase().includes(term) || 
      item.Level.toLowerCase().includes(term) ||
      (item.Detail && item.Detail.some((d: any) => d.Description.toLowerCase().includes(term) || d.Item.toLowerCase().includes(term) || d.Vendor.toLowerCase().includes(term)))
    );
  }, [searchTerm, bwaData]);

  const exportToCSV = () => {
    const csvRows = [];
    const headers = [
      "BWA Group",
      "Level",
      "Item Code",
      "Item Description",
      "Vendor",
      ...months,
      "Total"
    ];
    csvRows.push(headers.join(";"));

    const escape = (val: any) => {
      if (val === undefined || val === null) return "";
      const strVal = String(val);
      if (strVal.includes(";") || strVal.includes("\n") || strVal.includes('"')) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    };

    filteredData.forEach((row: any) => {
      if (row.Detail && row.Detail.length > 0) {
        row.Detail.forEach((d: any) => {
          const rowData = [
            row.BwaGroup,
            row.Level,
            d.Item,
            d.Description,
            d.Vendor,
            ...months.map(m => d.Values[m] ?? 0),
            d.Total
          ];
          csvRows.push(rowData.map(escape).join(";"));
        });
      } else {
        const rowData = [
          row.BwaGroup,
          row.Level,
          "",
          "",
          "",
          ...months.map(m => row.Values[m] ?? 0),
          row.Total
        ];
        csvRows.push(rowData.map(escape).join(";"));
      }
    });

    const csvContent = "\uFEFF" + csvRows.join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `BWA_${selectedCompany}_${year}.csv`.replace(/\s+/g, '_'));
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const groups = useMemo(() => {
    const map = new Map();
    filteredData.forEach((item: any) => {
      if (!map.has(item.BwaGroup)) map.set(item.BwaGroup, []);
      map.get(item.BwaGroup).push(item);
    });
    return Array.from(map.entries());
  }, [filteredData]);

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-32">
      <header className="flex flex-wrap justify-between items-end mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-black text-black tracking-tight flex items-center gap-3">
            <BarChart3 className="text-indigo-600" size={36} /> 
            BWA Analytics Pro
          </h1>
          <p className="text-gray-700 font-semibold mt-2">Cuenta de resultados (BWA) por mes, en directo de Business Central · desglose por cuenta, concepto y proveedor/cliente</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg p-2 font-semibold">
            {Array.from({ length: 4 }, (_, i) => new Date().getFullYear() - i).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={() => setReload(r => ({ n: r.n + 1, force: true }))} disabled={loading}
            className="flex items-center gap-2 bg-black hover:bg-gray-800 text-white px-4 py-2 rounded-lg transition-all shadow-lg disabled:opacity-50">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} /> {loading ? 'Leyendo BC…' : 'Actualizar desde BC'}
          </button>
        </div>
      </header>

      {selectedCompany === 'ALL' && <p className="text-sm text-gray-600 mb-6">Selecciona una empresa concreta en el menú lateral.</p>}
      {error && <p className="mb-6 bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700">{error}</p>}
      {loading && !bwaData.length && <p className="mb-6 text-sm text-gray-500">Leyendo la BWA {year} de Business Central…</p>}

      {bwaData.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {kpis.map((k, i) => {
              const base = kpis[0]?.total || 0;
              const Icon = [DollarSign, Package, TrendingUp, PieChart][i] || BarChart3;
              return (
                <div key={k.code} className="bg-white rounded-2xl p-6 border border-gray-100 shadow-xl relative overflow-hidden">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-gray-500 font-bold text-sm tracking-wider uppercase">{k.code} {k.description}</h3>
                    <div className="p-2 bg-indigo-100 text-indigo-600 rounded-lg"><Icon size={24} /></div>
                  </div>
                  <div className="text-3xl font-black text-gray-900 mb-2">{fmt(k.total)}</div>
                  {i > 0 && base ? <div className="text-sm font-bold text-gray-500">{(k.total / base * 100).toFixed(1)}% sobre {kpis[0].description}</div> : <div className="text-sm font-bold text-gray-500">Acumulado {year}</div>}
                </div>
              );
            })}
          </div>
          <div className="bg-white border border-gray-200 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-md">
            <div className="p-6 border-b border-gray-100 flex flex-wrap justify-between items-center bg-gray-50/50 gap-4">
              <div className="flex items-center gap-3">
                <Layers size={24} className="text-indigo-600" />
                <h2 className="text-xl font-bold text-gray-900">Estructura BWA</h2>
              </div>
              <div className="flex gap-4">
                <div className="relative">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input 
                    type="text" 
                    placeholder="Buscar..." 
                    className="bg-white border border-gray-300 text-sm text-gray-900 rounded-lg pl-9 pr-4 py-2 outline-none focus:border-indigo-500 transition-colors w-64 shadow-sm"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <button 
                  onClick={exportToCSV}
                  className="flex items-center gap-2 bg-white hover:bg-gray-100 text-gray-900 border border-gray-200 px-4 py-2 rounded-lg font-bold transition-all shadow-sm"
                >
                  <Download size={16} /> Exportar CSV
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-gray-100 text-gray-600 font-bold uppercase text-xs tracking-wider border-b border-gray-200">
                  <tr>
                    <th className="p-4 w-[350px]">Estructura / Nivel</th>
                    {months.map(m => <th key={m} className="p-4 text-right">{m}</th>)}
                    <th className="p-4 text-right bg-indigo-50/50 text-indigo-900 rounded-tr-lg">Total Anual</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {groups.map(([groupName, levels]) => (
                    <React.Fragment key={groupName}>
                      <tr className="bg-slate-800 text-white">
                        <td colSpan={14} className="p-3 font-bold text-sm tracking-wide">{groupName}</td>
                      </tr>
                      {(levels as any[]).map((level: any) => {
                        const levelId = `${groupName}-${level.Level}`;
                        const isExpanded = expandedLevels.has(levelId);
                        const hasDetail = level.Detail && level.Detail.length > 0;

                        return (
                          <React.Fragment key={levelId}>
                            <tr 
                              className={`transition-colors border-b border-gray-50 ${hasDetail ? 'cursor-pointer hover:bg-indigo-50/50 group' : 'bg-white'}`}
                              onClick={() => hasDetail && toggleLevel(levelId)}
                            >
                              <td className="p-4 flex items-center gap-2">
                                {hasDetail && (
                                  <ChevronRight 
                                    size={16} 
                                    className={`text-gray-400 group-hover:text-indigo-600 transition-transform ${isExpanded ? 'rotate-90 text-indigo-600' : ''}`} 
                                  />
                                )}
                                {!hasDetail && <div className="w-4"></div>}
                                <span className={`${level.Level === 'Total' ? 'font-black text-gray-900' : 'font-semibold text-gray-700'}`}>
                                  {level.Level}
                                </span>
                                {hasDetail && (
                                  <span className="ml-2 text-[10px] font-bold bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">
                                    {level.Detail.length}
                                  </span>
                                )}
                              </td>
                              {months.map(m => (
                                <td key={m} className={`p-4 text-right font-medium ${level.Level === 'Total' ? 'text-gray-900 font-bold bg-gray-50/50' : 'text-gray-600'}`}>
                                  {fmt(level.Values[m])}
                                </td>
                              ))}
                              <td className={`p-4 text-right font-black ${level.Level === 'Total' ? 'text-indigo-700 bg-indigo-50' : 'text-gray-900 bg-gray-50/50'}`}>
                                {fmt(level.Total)}
                              </td>
                            </tr>
                            {isExpanded && hasDetail && (
                              <tr>
                                <td colSpan={14} className="p-0 border-b border-gray-200">
                                  <div className="bg-indigo-50/30 p-4 pl-12 shadow-inner border-y border-indigo-100">
                                    <table className="w-full text-xs">
                                      <thead className="text-gray-500 font-bold border-b border-indigo-100">
                                        <tr>
                                          <th className="pb-2 text-left">Código</th>
                                          <th className="pb-2 text-left">Descripción Artículo</th>
                                          <th className="pb-2 text-left">Proveedor</th>
                                          {months.map(m => <th key={m} className="pb-2 text-right">{m}</th>)}
                                          <th className="pb-2 text-right">Total</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-indigo-50/50">
                                        {level.Detail.map((d: any, idx: number) => (
                                          <tr key={idx} className="hover:bg-white transition-colors">
                                            <td className="py-2 font-mono text-indigo-900 font-medium">{d.Item}</td>
                                            <td className="py-2 text-gray-700 font-medium">{d.Description}</td>
                                            <td className="py-2 text-gray-600 truncate max-w-[150px] font-medium" title={d.Vendor}>{d.Vendor}</td>
                                            {months.map(m => (
                                              <td key={m} className="py-2 text-right text-gray-600 font-medium">
                                                {d.Values[m] !== 0 ? fmt(d.Values[m]) : '-'}
                                              </td>
                                            ))}
                                            <td className="py-2 text-right text-indigo-900 font-bold">{fmt(d.Total)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
