'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  BarChart3, PackageSearch, ShoppingCart, Users, TrendingUp, TrendingDown, Banknote,
  CheckCircle2, Clock, Truck, Globe2, Landmark, FileSpreadsheet, Wallet, Settings, Save, X, AlertCircle, Upload, Trash2
} from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { parseInventoryValueSheet } from '@/lib/reportingExcel';

// ---------- Utilidades ----------

const formatCurrency = (val: number | null | undefined, currency = 'EUR') =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(val || 0);

const formatNumber = (val: number, digits = 2) =>
  new Intl.NumberFormat('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(val || 0);

const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('es-ES', { month: 'short', year: 'numeric' });
};

const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const toMonth = (year: number, monthIndex: number) => `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

function useReport(endpoint: string, months: string[], reloadKey: number) {
  const [state, setState] = useState<{ data: any; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const monthsParam = months.join(',');

  useEffect(() => {
    if (!monthsParam) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetch(`/api/reporting/${endpoint}?months=${monthsParam}`, { cache: 'no-store' })
      .then(async res => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || data.error) setState({ data: null, loading: false, error: data.error || 'Error al cargar los datos' });
        else setState({ data, loading: false, error: null });
      })
      .catch(err => !cancelled && setState({ data: null, loading: false, error: err.message }));
    return () => { cancelled = true; };
  }, [endpoint, monthsParam, reloadKey]);

  return state;
}

// ---------- Componentes base ----------

function Section({ title, subtitle, icon, state, children }: any) {
  return (
    <section>
      <div className="mb-4 border-b border-gray-200 pb-2">
        <h2 className="text-xl font-bold text-black flex items-center gap-2">
          <span className="text-gray-700">{icon}</span>
          {title}
        </h2>
        {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
      </div>
      {state?.loading ? (
        <div className="flex items-center gap-3 text-gray-500 text-sm py-8">
          <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-indigo-400"></div>
          Cargando...
        </div>
      ) : state?.error ? (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-4">
          <AlertCircle size={18} className="flex-shrink-0 mt-0.5" />
          <span>{state.error}</span>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

const Card = ({ children, className = '' }: any) => (
  <div className={`bg-white border border-gray-200 rounded-xl shadow-sm overflow-x-auto ${className}`}>{children}</div>
);

const KPICard = ({ title, value, icon, currency }: any) => (
  <div className="bg-white border border-gray-200 p-6 rounded-xl shadow-sm">
    <div className="p-3 bg-gray-50 rounded-lg text-gray-700 w-fit mb-4">{icon}</div>
    <p className="text-xs text-gray-500 font-bold mb-1 uppercase tracking-wider">{title}</p>
    <h3 className="text-2xl font-black text-black tracking-tight">{formatCurrency(value, currency)}</h3>
  </div>
);

type MonthRow = { label: string; values: Record<string, number | null>; bold?: boolean };

// Tabla de filas x meses seleccionados
function MonthTable({ months, rows, emptyNote }: { months: string[]; rows: MonthRow[]; emptyNote?: string }) {
  return (
    <Card>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <th className="text-left font-bold p-3">Concepto</th>
            {months.map(m => <th key={m} className="text-right font-bold p-3 whitespace-nowrap">{monthLabel(m)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.label} className={`border-t border-gray-100 ${row.bold ? 'bg-gray-50 font-bold text-black' : 'text-gray-700'}`}>
              <td className="p-3">{row.label}</td>
              {months.map(m => (
                <td key={m} className="p-3 text-right whitespace-nowrap">
                  {row.values[m] === null || row.values[m] === undefined ? <span className="text-gray-400">—</span> : formatCurrency(row.values[m])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {emptyNote && <p className="text-xs text-gray-500 p-3 border-t border-gray-100">{emptyNote}</p>}
    </Card>
  );
}

// ---------- Selector de periodo ----------

function PeriodSelector({ year, setYear, months, setMonths }: any) {
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = toMonth(thisYear, now.getMonth());
  const years = [thisYear - 3, thisYear - 2, thisYear - 1, thisYear];

  const toggle = (month: string) => {
    if (months.includes(month)) {
      if (months.length > 1) setMonths(months.filter((m: string) => m !== month));
    } else {
      setMonths([...months, month].sort());
    }
  };

  const changeYear = (y: number) => {
    setYear(y);
    const last = y === thisYear ? now.getMonth() : 11;
    setMonths([toMonth(y, last)]);
  };

  const yearMonths = MONTH_NAMES.map((_, i) => toMonth(year, i)).filter(m => m <= thisMonth);

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={year}
          onChange={e => changeYear(Number(e.target.value))}
          className="bg-gray-100 text-sm font-semibold rounded-md px-3 py-2 text-gray-900 outline-none focus:ring-2 focus:ring-black"
        >
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={() => setMonths(yearMonths.slice(-1))} className="text-xs font-semibold px-3 py-2 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-700">Último mes</button>
        <button onClick={() => setMonths(yearMonths)} className="text-xs font-semibold px-3 py-2 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-700">Año completo</button>
        <span className="text-xs text-gray-500">Pulsa los meses para seleccionar uno o varios.</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {MONTH_NAMES.map((name, i) => {
          const month = toMonth(year, i);
          const disabled = month > thisMonth;
          const active = months.includes(month);
          return (
            <button
              key={month}
              disabled={disabled}
              onClick={() => toggle(month)}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-all ${
                active ? 'bg-black text-white shadow-md' : disabled ? 'bg-gray-50 text-gray-300 cursor-not-allowed' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Configuración ----------

function ConfigPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [accounts, setAccounts] = useState('');
  const [service, setService] = useState('ValueEntries');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/reporting/config').then(r => r.json()).then(cfg => {
      if (cfg.error) return;
      setAccounts((cfg.provisionAccounts || []).join(', '));
      setService(cfg.valueEntriesService || 'ValueEntries');
    });
  }, []);

  const save = async () => {
    setSaving(true);
    await fetch('/api/reporting/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provisionAccounts: accounts.split(/[,;\s]+/).filter(Boolean), valueEntriesService: service }),
    });
    setSaving(false);
    onSaved();
    onClose();
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-bold text-black flex items-center gap-2"><Settings size={18} /> Configuración del Reporting</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-black"><X size={18} /></button>
      </div>
      <label className="block">
        <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Cuentas contables de provisiones</span>
        <input value={accounts} onChange={e => setAccounts(e.target.value)} placeholder="Ej: 499000, 499100"
          className="mt-1 w-full bg-gray-100 rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black" />
        <span className="text-xs text-gray-500">Separadas por comas. Haber = dotación (original), debe = consumo.</span>
      </label>
      <label className="block">
        <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Servicio web de Value Entries (BC)</span>
        <input value={service} onChange={e => setService(e.target.value)}
          className="mt-1 w-full bg-gray-100 rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black" />
        <span className="text-xs text-gray-500">Nombre con el que está publicada la página 5802 &quot;Value Entries&quot; en Servicios web de BC.</span>
      </label>
      <button onClick={save} disabled={saving}
        className="flex items-center gap-2 bg-black text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-gray-800 disabled:opacity-50">
        <Save size={16} /> {saving ? 'Guardando...' : 'Guardar'}
      </button>
    </div>
  );
}

// ---------- Helpers de cartera ----------

const SNAPSHOT_NOTE = 'Los meses cerrados muestran la foto guardada a cierre de mes. "—" = no hay foto guardada para ese mes.';

// Filas por forma de pago a partir de las fotos de cada mes
function paymentMethodRows(months: string[], portfolio: any, side: 'customers' | 'vendors'): MonthRow[] {
  const methods = new Set<string>();
  months.forEach(m => Object.keys(portfolio.months[m]?.data[side].byPaymentMethod || {}).forEach(k => methods.add(k)));
  const last = months[months.length - 1];
  const sorted = Array.from(methods).sort((a, b) =>
    Math.abs(portfolio.months[last]?.data[side].byPaymentMethod[b] || 0) - Math.abs(portfolio.months[last]?.data[side].byPaymentMethod[a] || 0));
  const valueOf = (m: string, fn: (d: any) => number) => (portfolio.months[m] ? fn(portfolio.months[m].data[side]) : null);
  return [
    ...sorted.map(method => ({ label: method, values: Object.fromEntries(months.map(m => [m, valueOf(m, d => d.byPaymentMethod[method] || 0)])) })),
    { label: 'Total', bold: true, values: Object.fromEntries(months.map(m => [m, valueOf(m, d => d.total)])) },
  ];
}

function splitRows(months: string[], portfolio: any, pick: (d: any) => any, labels: [string, string, string]): MonthRow[] {
  const val = (m: string, key: string) => (portfolio.months[m] ? pick(portfolio.months[m].data)[key] : null);
  return [
    { label: labels[0], bold: true, values: Object.fromEntries(months.map(m => [m, val(m, 'total')])) },
    { label: labels[1], values: Object.fromEntries(months.map(m => [m, val(m, 'confirmed')])) },
    { label: labels[2], values: Object.fromEntries(months.map(m => [m, val(m, 'unconfirmed')])) },
  ];
}

function SplitCards({ months, portfolio, pick, labels }: any) {
  const last = months[months.length - 1];
  const data = portfolio.months[last] ? pick(portfolio.months[last].data) : null;
  if (!data) return null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
      <KPICard title={`${labels[0]} (${monthLabel(last)})`} value={data.total} icon={<Banknote size={24} />} />
      <KPICard title={labels[1]} value={data.confirmed} icon={<CheckCircle2 size={24} />} />
      <KPICard title={labels[2]} value={data.unconfirmed} icon={<Clock size={24} />} />
    </div>
  );
}

// ---------- Excels subidos ----------

const UPLOAD_PARSERS: Record<string, (rows: any[][]) => { month: string; toDate: string }> = {
  inventory: parseInventoryValueSheet,
};

// Subida de un Excel de BC: se lee en el navegador, se detecta el mes y se guarda por empresa y mes
function ExcelUploadBar({ kind, label, onUploaded }: { kind: string; label: string; onUploaded: () => void }) {
  const [uploads, setUploads] = useState<{ month: string; updatedAt: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => fetch(`/api/reporting/uploads?kind=${kind}`, { cache: 'no-store' })
    .then(r => r.json()).then(d => setUploads(d.uploads || [])).catch(() => {});
  useEffect(() => { load(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
      const data = UPLOAD_PARSERS[kind](rows);
      if (uploads.some(u => u.month === data.month) && !confirm(`Ya hay un Excel de ${monthLabel(data.month)}. ¿Sustituirlo?`)) return;
      const res = await fetch(`/api/reporting/uploads?kind=${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: data.month, data }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Error al guardar el Excel');
      setMessage({ ok: true, text: `Excel guardado como ${monthLabel(data.month)} (fecha ${new Date(data.toDate).toLocaleDateString('es-ES')}).` });
      await load();
      onUploaded();
    } catch (error: any) {
      setMessage({ ok: false, text: error.message });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (month: string) => {
    if (!confirm(`¿Eliminar el Excel de ${monthLabel(month)}?`)) return;
    await fetch(`/api/reporting/uploads?kind=${kind}&month=${month}`, { method: 'DELETE' });
    await load();
    onUploaded();
  };

  return (
    <div className="bg-white border border-dashed border-gray-300 rounded-xl p-4 mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden"
          onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
        <button onClick={() => inputRef.current?.click()} disabled={busy}
          className="flex items-center gap-2 bg-black text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-gray-800 disabled:opacity-50">
          <Upload size={16} /> {busy ? 'Leyendo...' : `Subir Excel ${label}`}
        </button>
        <span className="text-xs text-gray-500">El mes se toma de la fecha del Excel. Se guarda para la empresa seleccionada.</span>
      </div>
      {message && <p className={`text-sm ${message.ok ? 'text-emerald-700' : 'text-red-600'}`}>{message.text}</p>}
      {uploads.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Cargados:</span>
          {uploads.map(u => (
            <span key={u.month} className="flex items-center gap-1 bg-gray-100 text-gray-700 text-xs font-semibold pl-2.5 pr-1 py-1 rounded-md">
              {monthLabel(u.month)}
              <button onClick={() => remove(u.month)} title="Eliminar" className="p-0.5 text-gray-400 hover:text-red-600"><Trash2 size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Operacional ----------

function TopItemsTable({ title, items, icon }: any) {
  return (
    <Card>
      <div className="p-3 font-bold text-sm text-black flex items-center gap-2 border-b border-gray-100">{icon}{title}</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <th className="text-left font-bold p-2">Producto</th>
            <th className="text-right font-bold p-2">Inicio</th>
            <th className="text-right font-bold p-2">Fin</th>
            <th className="text-right font-bold p-2">Variación</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && <tr><td colSpan={4} className="p-3 text-gray-400 text-center">Sin movimientos</td></tr>}
          {items.map((i: any) => (
            <tr key={i.itemNo} className="border-t border-gray-100 text-gray-700">
              <td className="p-2"><div className="font-semibold text-black">{i.itemNo}</div><div className="text-xs text-gray-500 truncate max-w-[220px]">{i.description}</div></td>
              <td className="p-2 text-right whitespace-nowrap">{formatCurrency(i.startValue)}</td>
              <td className="p-2 text-right whitespace-nowrap">{formatCurrency(i.endValue)}</td>
              <td className={`p-2 text-right whitespace-nowrap font-bold ${i.diff > 0 ? 'text-emerald-600' : 'text-red-600'}`}>{i.diff > 0 ? '+' : ''}{formatCurrency(i.diff)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function OperationalTab({ months, reloadKey, companySelected }: { months: string[]; reloadKey: number; companySelected: boolean }) {
  const [uploadKey, setUploadKey] = useState(0);
  const inventory = useReport('inventory', months, reloadKey + uploadKey);
  const purchases = useReport('purchases', months, reloadKey);
  const portfolio = useReport('portfolio', months, reloadKey);
  const inv = inventory.data;

  return (
    <div className="space-y-10">
      {companySelected && <ExcelUploadBar kind="inventory" label="Inventory Value" onUploaded={() => setUploadKey(k => k + 1)} />}
      <Section title="Valor de inventario por almacén" icon={<PackageSearch />} state={inventory}
        subtitle="Excel Inventory Value de BC a último día de cada mes. Valor por almacén = cantidad x coste unitario del producto.">
        {inv && (
          <div className="space-y-4">
            {inv.missingMonths.length > 0 && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Falta el Excel de: {inv.missingMonths.map(monthLabel).join(', ')}.
              </p>
            )}
            {inv.byLocation.length > 0 && (
              <MonthTable months={months} rows={[
                ...inv.byLocation.map((l: any) => ({ label: l.location, values: l.values })),
                { label: 'Total', bold: true, values: inv.totals },
              ]} />
            )}
            {inv.comparison ? (
              <>
                <p className="text-xs text-gray-500">Top 10 productos: cierre de {monthLabel(inv.startMonth)} vs cierre de {monthLabel(inv.endMonth)}.</p>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <TopItemsTable title="Top 10 que más han subido" items={inv.comparison.topUp} icon={<TrendingUp size={16} className="text-emerald-600" />} />
                  <TopItemsTable title="Top 10 que más han bajado" items={inv.comparison.topDown} icon={<TrendingDown size={16} className="text-red-600" />} />
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-500">
                Para el top 10 de productos sube también el Excel de {inv.comparisonMissing.map(monthLabel).join(' y ')} (se compara con el cierre del mes anterior).
              </p>
            )}
          </div>
        )}
      </Section>

      <Section title="Compras de inventario (CHINA TRF)" icon={<ShoppingCart />} state={purchases}
        subtitle="Facturas de compra registradas en los meses seleccionados de proveedores con forma de pago CHINA TRF.">
        {purchases.data && (
          <div className="space-y-4">
            <MonthTable months={months} rows={[
              { label: 'Importe compras', bold: true, values: Object.fromEntries(months.map(m => [m, purchases.data.byMonth[m]?.total ?? 0])) },
            ]} />
            <Card>
              <details>
                <summary className="p-3 text-sm font-semibold cursor-pointer text-gray-700">
                  Ver facturas ({purchases.data.invoices.length}) · Total {formatCurrency(purchases.data.total)}
                </summary>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                      <th className="text-left font-bold p-2">Fecha</th>
                      <th className="text-left font-bold p-2">Documento</th>
                      <th className="text-left font-bold p-2">Proveedor</th>
                      <th className="text-right font-bold p-2">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchases.data.invoices.map((i: any) => (
                      <tr key={i.documentNo} className="border-t border-gray-100 text-gray-700">
                        <td className="p-2 whitespace-nowrap">{new Date(i.postingDate).toLocaleDateString('es-ES')}</td>
                        <td className="p-2">{i.documentNo}</td>
                        <td className="p-2">{i.vendorName}</td>
                        <td className="p-2 text-right whitespace-nowrap">{formatCurrency(i.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </Card>
          </div>
        )}
      </Section>

      <Section title="Cartera de clientes sin seguro" icon={<Users />} state={portfolio}
        subtitle="Importe abierto pendiente de cobro de AMAZON, ALDI y LIDL.">
        {portfolio.data && (
          <MonthTable months={months} emptyNote={SNAPSHOT_NOTE} rows={[
            ...['AMAZON', 'ALDI', 'LIDL'].map(k => ({
              label: k,
              values: Object.fromEntries(months.map(m => [m, portfolio.data.months[m] ? portfolio.data.months[m].data.customers.keyAccounts[k] : null])),
            })),
            {
              label: 'Total', bold: true,
              values: Object.fromEntries(months.map(m => [m, portfolio.data.months[m]
                ? Object.values(portfolio.data.months[m].data.customers.keyAccounts as Record<string, number>).reduce((s, v) => s + v, 0)
                : null])),
            },
          ]} />
        )}
      </Section>

      <Section title="Variación del coste medio (productos de Inventario)" icon={<BarChart3 />} state={inventory}
        subtitle={inv ? `Coste medio (valor / cantidad) a cierre de ${monthLabel(inv.startMonth)} vs ${monthLabel(inv.endMonth)}. Se muestran las 25 mayores variaciones.` : ''}>
        {inv && !inv.comparison && (
          <p className="text-sm text-gray-500">Sube el Excel de {inv.comparisonMissing.map(monthLabel).join(' y ')} para comparar el coste medio.</p>
        )}
        {inv?.comparison && (
          <div className="space-y-4">
            <div className="flex gap-3 text-sm">
              <span className="bg-red-50 text-red-700 font-semibold px-3 py-1.5 rounded-lg">{inv.comparison.avgCost.increased} productos suben</span>
              <span className="bg-emerald-50 text-emerald-700 font-semibold px-3 py-1.5 rounded-lg">{inv.comparison.avgCost.decreased} productos bajan</span>
            </div>
            <Card>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                    <th className="text-left font-bold p-3">Producto</th>
                    <th className="text-right font-bold p-3">Coste {monthLabel(inv.startMonth)}</th>
                    <th className="text-right font-bold p-3">Coste {monthLabel(inv.endMonth)}</th>
                    <th className="text-right font-bold p-3">Variación</th>
                    <th className="text-right font-bold p-3">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.comparison.avgCost.items.length === 0 && <tr><td colSpan={5} className="p-3 text-gray-400 text-center">Sin variaciones de coste medio</td></tr>}
                  {inv.comparison.avgCost.items.map((i: any) => (
                    <tr key={i.itemNo} className="border-t border-gray-100 text-gray-700">
                      <td className="p-3"><span className="font-semibold text-black">{i.itemNo}</span> <span className="text-gray-500">{i.description}</span></td>
                      <td className="p-3 text-right whitespace-nowrap">{formatCurrency(i.startUnitCost)}</td>
                      <td className="p-3 text-right whitespace-nowrap">{formatCurrency(i.endUnitCost)}</td>
                      <td className={`p-3 text-right whitespace-nowrap font-bold ${i.variationPct > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        {i.variationPct > 0 ? '+' : ''}{formatNumber(i.variationPct)}%
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">{formatNumber(i.endQty, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------- Dirección ----------

function BwaTable({ bwa }: { bwa: any }) {
  const showCompany = !!bwa.company;
  const showConsolidated = !!bwa.consolidated;
  const base = bwa.company?.rows || bwa.consolidated?.rows || [];
  const consolidatedByKey = new Map<string, any>((bwa.consolidated?.rows || []).map((r: any) => [`${r.group}|${r.level}`, r]));
  let lastGroup = '';

  return (
    <Card>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <th className="text-left font-bold p-3">Concepto</th>
            {showCompany && <th className="text-right font-bold p-3">Periodo</th>}
            {showCompany && <th className="text-right font-bold p-3">Acumulado año</th>}
            {showConsolidated && <th className="text-right font-bold p-3 bg-indigo-50 text-indigo-700">Consolidado periodo</th>}
            {showConsolidated && <th className="text-right font-bold p-3 bg-indigo-50 text-indigo-700">Consolidado acumulado</th>}
          </tr>
        </thead>
        <tbody>
          {base.map((row: any, idx: number) => {
            const groupHeader = row.group && row.group !== lastGroup;
            lastGroup = row.group;
            const cons = consolidatedByKey.get(`${row.group}|${row.level}`);
            const cols = 1 + (showCompany ? 2 : 0) + (showConsolidated ? 2 : 0);
            return [
              groupHeader && (
                <tr key={`g-${idx}`} className="bg-gray-50 border-t border-gray-200">
                  <td colSpan={cols} className="p-2 px-3 text-xs font-bold uppercase tracking-wider text-gray-500">{row.group}</td>
                </tr>
              ),
              <tr key={idx} className="border-t border-gray-100 text-gray-700">
                <td className="p-3">{row.level || row.group}</td>
                {showCompany && <td className="p-3 text-right whitespace-nowrap">{formatCurrency(row.period)}</td>}
                {showCompany && <td className="p-3 text-right whitespace-nowrap">{formatCurrency(row.ytd)}</td>}
                {showConsolidated && <td className="p-3 text-right whitespace-nowrap bg-indigo-50/40">{formatCurrency(cons?.period)}</td>}
                {showConsolidated && <td className="p-3 text-right whitespace-nowrap bg-indigo-50/40">{formatCurrency(cons?.ytd)}</td>}
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </Card>
  );
}

function ManagementTab({ months, reloadKey, openConfig }: { months: string[]; reloadKey: number; openConfig: () => void }) {
  const portfolio = useReport('portfolio', months, reloadKey);
  const provisions = useReport('provisions', months, reloadKey);
  const bwa = useReport('bwa', months, reloadKey);
  const cashflow = useReport('cashflow', months, reloadKey);
  const p = portfolio.data;
  const lastMonth = months[months.length - 1];

  return (
    <div className="space-y-10">
      <Section title="Cartera de clientes abierta por forma de pago" icon={<Banknote />} state={portfolio}
        subtitle="Total pendiente de cobro, detallado por forma de pago.">
        {p && <MonthTable months={months} rows={paymentMethodRows(months, p, 'customers')} emptyNote={SNAPSHOT_NOTE} />}
      </Section>

      <Section title="MARKANT" icon={<CheckCircle2 />} state={portfolio}
        subtitle="Cartera de clientes con forma de pago MARKANT y su fecha de pago confirmada.">
        {p && (
          <>
            <SplitCards months={months} portfolio={p} pick={(d: any) => d.customers.markant}
              labels={['Total abierto MARKANT', 'Con fecha de pago confirmada', 'Sin fecha de pago confirmada']} />
            {months.length > 1 && (
              <MonthTable months={months} emptyNote={SNAPSHOT_NOTE}
                rows={splitRows(months, p, d => d.customers.markant, ['Total abierto', 'Con fecha confirmada', 'Sin fecha confirmada'])} />
            )}
            {!p.months[lastMonth] && <p className="text-sm text-gray-500">No hay foto guardada para {monthLabel(lastMonth)}.</p>}
          </>
        )}
      </Section>

      <Section title="Cartera de proveedores abierta por forma de pago" icon={<Truck />} state={portfolio}
        subtitle="Total pendiente de pago, detallado por forma de pago.">
        {p && <MonthTable months={months} rows={paymentMethodRows(months, p, 'vendors')} emptyNote={SNAPSHOT_NOTE} />}
      </Section>

      <Section title="CHINA INV" icon={<Globe2 />} state={portfolio}
        subtitle="Facturas de proveedores abiertas con forma de pago CHINA INV y su fecha de pago confirmada.">
        {p && (
          <>
            <SplitCards months={months} portfolio={p} pick={(d: any) => d.vendors.chinaInv}
              labels={['Total abierto CHINA INV', 'Con fecha de pago confirmada', 'Sin fecha de pago confirmada']} />
            {months.length > 1 && (
              <MonthTable months={months} emptyNote={SNAPSHOT_NOTE}
                rows={splitRows(months, p, d => d.vendors.chinaInv, ['Total abierto', 'Con fecha confirmada', 'Sin fecha confirmada'])} />
            )}
            {!p.months[lastMonth] && <p className="text-sm text-gray-500">No hay foto guardada para {monthLabel(lastMonth)}.</p>}
          </>
        )}
      </Section>

      <Section title="Provisiones" icon={<Landmark />} state={provisions}
        subtitle={provisions.data?.from ? `Desde el ${new Date(provisions.data.from).toLocaleDateString('es-ES')} hasta el ${new Date(provisions.data.to).toLocaleDateString('es-ES')}.` : 'Desde principio de año hasta el último mes seleccionado.'}>
        {provisions.data?.notConfigured ? (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-4 flex items-center justify-between gap-4">
            <span>Configura las cuentas contables de provisiones para ver este apartado.</span>
            <button onClick={openConfig} className="font-semibold underline whitespace-nowrap">Configurar</button>
          </div>
        ) : provisions.data && (
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                  <th className="text-left font-bold p-3">Cuenta</th>
                  <th className="text-right font-bold p-3">Saldo inicio año</th>
                  <th className="text-right font-bold p-3">Provisión original</th>
                  <th className="text-right font-bold p-3">Consumido</th>
                  <th className="text-right font-bold p-3">Abierto</th>
                </tr>
              </thead>
              <tbody>
                {[...provisions.data.accounts, { account: 'Total', name: '', ...provisions.data.totals, isTotal: true }].map((r: any) => (
                  <tr key={r.account} className={`border-t border-gray-100 ${r.isTotal ? 'bg-gray-50 font-bold text-black' : 'text-gray-700'}`}>
                    <td className="p-3">{r.account} <span className="text-gray-500 font-normal">{r.name}</span></td>
                    <td className="p-3 text-right whitespace-nowrap">{formatCurrency(r.openingBalance)}</td>
                    <td className="p-3 text-right whitespace-nowrap">{formatCurrency(r.original)}</td>
                    <td className="p-3 text-right whitespace-nowrap">{formatCurrency(r.consumed)}</td>
                    <td className="p-3 text-right whitespace-nowrap font-bold">{formatCurrency(r.open)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      <Section title="BWA" icon={<FileSpreadsheet />} state={bwa}
        subtitle="Último BWA subido en BWA Analytics: meses seleccionados y acumulado desde enero.">
        {bwa.data && (
          bwa.data.company || bwa.data.consolidated ? (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">
                {bwa.data.company && <>BWA de la empresa subido el {new Date(bwa.data.company.reportDate).toLocaleDateString('es-ES')}. </>}
                {bwa.data.consolidated && <>Consolidado de: {bwa.data.consolidated.companies.map((c: any) => `${c.companyId} (${new Date(c.reportDate).toLocaleDateString('es-ES')})`).join(', ')}.</>}
              </p>
              <BwaTable bwa={bwa.data} />
            </div>
          ) : (
            <p className="text-sm text-gray-500">No hay ningún BWA subido para esta empresa.</p>
          )
        )}
      </Section>

      <Section title="Cashflow" icon={<Wallet />} state={cashflow}
        subtitle="Saldo inicial, cobros y pagos previstos y saldo final de cada mes, más la previsión de los 3 meses siguientes.">
        {cashflow.data && (
          <div className="space-y-4">
            {cashflow.data.currencies.map((c: any) => {
              const cols = [...c.months.map((m: any) => ({ ...m, forecast: false })), ...c.forecast.map((m: any) => ({ ...m, forecast: true }))];
              const rows: [string, string, boolean][] = [['Saldo inicial', 'opening', false], ['Cobros previstos', 'inflows', false], ['Pagos previstos', 'outflows', false], ['Saldo final', 'closing', true]];
              return (
                <Card key={c.currency}>
                  <div className="p-3 font-bold text-sm text-black border-b border-gray-100">{c.currency}</div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                        <th className="text-left font-bold p-3">Concepto</th>
                        {cols.map(col => (
                          <th key={col.month} className={`text-right font-bold p-3 whitespace-nowrap ${col.forecast ? 'bg-amber-50 text-amber-700' : ''}`}>
                            {monthLabel(col.month)}{col.forecast && <div className="normal-case font-semibold">Previsión</div>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(([label, key, bold]) => (
                        <tr key={key} className={`border-t border-gray-100 ${bold ? 'font-bold text-black' : 'text-gray-700'}`}>
                          <td className="p-3">{label}</td>
                          {cols.map(col => (
                            <td key={col.month} className={`p-3 text-right whitespace-nowrap ${col.forecast ? 'bg-amber-50/40' : ''} ${key === 'closing' && col.closing < 0 ? 'text-red-600' : ''}`}>
                              {formatCurrency(col[key], c.currency)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------- Página ----------

export default function ReportingPage() {
  const { selectedCompany } = useCompany();
  const now = new Date();
  // Por defecto: último mes cerrado
  const defaultMonth = toMonth(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(), now.getMonth() === 0 ? 11 : now.getMonth() - 1);
  const [year, setYear] = useState(Number(defaultMonth.substring(0, 4)));
  const [months, setMonths] = useState<string[]>([defaultMonth]);
  const [tab, setTab] = useState<'operational' | 'management'>('operational');
  const [showConfig, setShowConfig] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const periodLabel = useMemo(() => months.map(monthLabel).join(', '), [months]);

  return (
    <div className="min-h-screen p-8 pb-32 overflow-y-auto">
      <div className="max-w-7xl mx-auto space-y-8">
        <header className="flex flex-wrap justify-between items-start gap-4">
          <div>
            <h1 className="text-4xl font-black text-black tracking-tight">Reporting</h1>
            <p className="text-gray-500 mt-2 font-medium">
              {selectedCompany === 'ALL' ? 'Todas las empresas' : selectedCompany} · {periodLabel}
            </p>
          </div>
          <button onClick={() => setShowConfig(s => !s)}
            className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700">
            <Settings size={16} /> Configuración
          </button>
        </header>

        {showConfig && <ConfigPanel onClose={() => setShowConfig(false)} onSaved={() => setReloadKey(k => k + 1)} />}

        <PeriodSelector year={year} setYear={setYear} months={months} setMonths={setMonths} />

        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
          {([['operational', 'Operacional'], ['management', 'Dirección']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`px-5 py-2 rounded-md text-sm font-semibold transition-all ${tab === key ? 'bg-white text-black shadow-sm' : 'text-gray-600 hover:text-black'}`}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'operational'
          ? <OperationalTab months={months} reloadKey={reloadKey} companySelected={selectedCompany !== 'ALL'} />
          : <ManagementTab months={months} reloadKey={reloadKey} openConfig={() => setShowConfig(true)} />}
      </div>
    </div>
  );
}
