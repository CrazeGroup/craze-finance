import { CONSOLIDATED, REPORT_COMPANIES } from './CompanySelect';

// Datos de Compras por artículo / por proveedor (/api/controlling/purchase-items) de una empresa o, en
// "CRAZE Consolidated", de todas: artículos unidos por nº, y cada proveedor marcado con su empresa (importes en la
// divisa de cada documento, como en una sola empresa).
export async function fetchPurchaseItems(company: string, from: string, to: string, force: boolean): Promise<any> {
  const one = async (co: string) => {
    const res = await fetch(`/api/controlling/purchase-items?company=${encodeURIComponent(co)}&from=${from}&to=${to}${force ? '&force=1' : ''}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || data.error) throw new Error(`${co}: ${data.error || `HTTP ${res.status}`}`);
    return data;
  };
  if (company !== CONSOLIDATED) return one(company);
  // Una empresa que falle no tumba el consolidado: sale como aviso
  const settled = await Promise.allSettled(REPORT_COMPANIES.map(async co => ({ co, data: await one(co) })));
  const parts = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = settled.flatMap(r => (r.status === 'rejected' ? [String(r.reason?.message || r.reason)] : []));
  if (!parts.length) throw new Error(failed.join(' · '));
  const items = new Map<string, any>();
  for (const { co, data } of parts) {
    for (const it of data.items || []) {
      const cur = items.get(it.itemNo) || { ...it, net: 0, quantity: 0, vendors: [] };
      cur.net += it.net; cur.quantity += it.quantity;
      cur.vendors.push(...it.vendors.map((v: any) => ({ ...v, company: co, vendorNo: `${co} · ${v.vendorNo}`, name: v.name ? `${v.name} (${co})` : co })));
      items.set(it.itemNo, cur);
    }
  }
  const sum = (k: string) => parts.reduce((t, p) => t + (p.data[k] || 0), 0);
  return {
    items: Array.from(items.values()).sort((a, b) => b.net - a.net),
    excludedZero: sum('excludedZero'), excludedEqual: sum('excludedEqual'), cancelledPairs: sum('cancelledPairs'),
    warnings: [...failed.map(f => `No incluida en el consolidado: ${f}`), ...parts.flatMap(p => (p.data.warnings || []).map((w: string) => `${p.co}: ${w}`))],
    counts: {
      invoiceLines: parts.reduce((t, p) => t + (p.data.counts?.invoiceLines || 0), 0),
      creditMemoLines: parts.reduce((t, p) => t + (p.data.counts?.creditMemoLines || 0), 0),
      glEntries: parts.reduce((t, p) => t + (p.data.counts?.glEntries || 0), 0),
    },
  };
}
