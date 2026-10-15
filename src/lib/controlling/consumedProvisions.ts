import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/reporting/cache';
import { today } from '@/lib/reporting/period';
import { findService } from '@/lib/royalties';

// Controlling · Consumed Provisions, entre dos fechas de registro:
// - Provisionado: asientos PROV* del periodo en las cuentas de resultados de cada provisión (PROVISION_ACCOUNTS: 4769 02,
//   6020 10, 6600 30, 6600 31, 6837 00), igual que los saldos de la cuenta de resultados.
// - Calculado LM (referencia; puede diferir por abonos posteriores): página 60000 "Documents LM Components", sin Main Item:
//     Provision Conditions = Total Provision Sales · Provision KAM = "Provision HHRR" (campo Total_Provision_Bonus)
//     Provision Royalties = Total Provision Royalties · Provision Marketing = Provision Marketing sin ventas a Amazon
//     Provision Amazon Promotion = Provision Marketing de las ventas a Amazon.
// - Consumido: facturas y abonos de compra que han acabado en las cuentas PROV-KONDITIONS / PROV-MARKETING /
//   PROV-ROYALTIES / PROV-AMZPROM. Se sigue el hilo por el Document No.: cuenta todo lo que un documento de compra
//   tiene en esas cuentas en el periodo (su registro inicial, periodificaciones y las reclasificaciones de diario hechas
//   con el mismo nº de documento). También cuentan los asientos PROV + número (PROV1, PROV3…: refacturación de royalties
//   que consume PROV-ROYALTIES), los asientos de diario en esas cuentas sin factura detrás (p. ej. Skonto Reclassification)
//   y, en los asientos PROV-…, lo que rebaja la cuenta de provisión de la serie (3071 13…) contra otras cuentas de balance
//   (p. ej. PROV-00049: traspaso de la 3071 06). No cuentan la dotación (cuenta de resultados) ni el traspaso desde la PROV-*,
//   que ya son las facturas contadas una a una. Así lo consumido coincide con el del Reporting (provisionado − abierto).

const str = (v: any) => (v == null ? '' : String(v).trim());
const num = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const q = (s: string) => s.replace(/'/g, "''");

export const CONCEPTS = [
  { key: 'conditions', label: 'Provision Conditions', account: 'PROV-KONDITIONS' },
  { key: 'kam', label: 'Provision KAM', account: '' },
  { key: 'royalties', label: 'Provision Royalties', account: 'PROV-ROYALTIES' },
  { key: 'marketing', label: 'Provision Marketing (sin Amazon)', account: 'PROV-MARKETING' },
  { key: 'amazon', label: 'Provision Amazon Promotion', account: 'PROV-AMZPROM' },
] as const;
type Key = typeof CONCEPTS[number]['key'];
const ACCOUNTS = CONCEPTS.map(c => c.account).filter(Boolean) as string[];
// Cuenta de resultados (sin espacios) → concepto; el primer prefijo que encaja
const PROVISION_ACCOUNTS: [string, Key][] = [['660031', 'amazon'], ['6600', 'marketing'], ['4769', 'conditions'], ['6020', 'kam'], ['6837', 'royalties']];
// Cuenta de provisión (balance) de cada concepto
const SERIES_ACCOUNT: Record<Key, string> = { conditions: '307113', kam: '307108', royalties: '307112', marketing: '307201', amazon: '307202' };
const conceptOf = (account: string) => { const a = account.replace(/\s+/g, ''); return PROVISION_ACCOUNTS.find(([p]) => a.startsWith(p))?.[1] || null; };
const PURCHASE_CODES = /^(PURCHASES|PUR-DEFER)$/i;
const isAmazon = (r: any) => /amazon/i.test(`${str(r.Sell_to_Customer_Name)} ${str(r.Bill_to_Customer_Name)}`);

async function generated(ctx: BcContext, from: string, to: string) {
  const service = await findService(ctx);
  const sample = await bcFetchAll(odataUrl(service.url, { $top: '1' }), ctx.token);
  const keys = Object.keys(sample[0] || {});
  const k = (name: string) => keys.find(x => x.toLowerCase() === name.toLowerCase());
  const F = {
    date: k('Posting_date'), main: k('Main_Item_CRZ') || k('Main_Item'), sales: k('Total_Provision_Sales'), kam: k('Total_Provision_Bonus'),
    royalties: k('Total_Provision_Royalties'), marketing: k('Provision_Marketing'), sell: k('Sell_to_Customer_Name'), bill: k('Bill_to_Customer_Name'),
  };
  const missing = Object.entries(F).filter(([, v]) => !v).map(([n]) => n);
  if (sample.length && missing.length) throw new Error(`El servicio "${service.name}" no tiene los campos ${missing.join(', ')}.`);
  if (!sample.length) return { conditions: 0, kam: 0, royalties: 0, marketing: 0, amazon: 0, lines: 0, byMonth: {} as Record<string, Record<Key, number>> };
  const rows = await bcFetchAll(odataUrl(service.url, {
    $filter: `${F.date} ge ${from} and ${F.date} le ${to}`, $select: Object.values(F).join(','),
  }), ctx.token);
  const out = { conditions: 0, kam: 0, royalties: 0, marketing: 0, amazon: 0, lines: 0, byMonth: {} as Record<string, Record<Key, number>> };
  for (const r0 of rows) {
    const r = { ...r0, Sell_to_Customer_Name: r0[F.sell!], Bill_to_Customer_Name: r0[F.bill!] };
    if (r0[F.main!] === true) continue;
    const v: Record<Key, number> = {
      conditions: num(r0[F.sales!]), kam: num(r0[F.kam!]), royalties: num(r0[F.royalties!]),
      marketing: isAmazon(r) ? 0 : num(r0[F.marketing!]), amazon: isAmazon(r) ? num(r0[F.marketing!]) : 0,
    };
    const m = str(r0[F.date!]).substring(0, 7);
    const bm = (out.byMonth[m] ||= { conditions: 0, kam: 0, royalties: 0, marketing: 0, amazon: 0 });
    for (const key of Object.keys(v) as Key[]) { out[key] += v[key]; bm[key] += v[key]; }
    out.lines++;
  }
  return out;
}

export async function consumedProvisionsReport(ctx: BcContext, company: string, from: string, to: string, force = false) {
  return cached(`ctrl:consumedProv5:${company}:${from}:${to}`, to < today() ? 6 * HOUR : 1 * HOUR, async () => {
    const [gen, entries, vendors, provEntries] = await Promise.all([
      generated(ctx, from, to),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: `Posting_Date ge ${from} and Posting_Date le ${to} and (${ACCOUNTS.map(a => `G_L_Account_No eq '${a}'`).join(' or ')})`,
        $select: 'Entry_No,Posting_Date,Document_Type,Document_No,G_L_Account_No,Description,Amount,Source_Type,Source_No,Source_Code,External_Document_No,Bal_Account_No',
      }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Vendor_Card_Excel`, { $select: 'No,Name' }), ctx.token).catch(() => [] as any[]),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: `startswith(Document_No,'PROV') and Posting_Date ge ${from} and Posting_Date le ${to}`,
        $select: 'Entry_No,Posting_Date,Document_No,G_L_Account_No,Description,Amount,Source_Code,Bal_Account_No',
      }), ctx.token),
    ]);
    // Provisionado por concepto y mes (cuentas de resultados)
    const booked: Record<Key, number> = { conditions: 0, kam: 0, royalties: 0, marketing: 0, amazon: 0 };
    const bookedByMonth: Record<string, Record<Key, number>> = {};
    for (const e of provEntries) {
      const key = conceptOf(str(e.G_L_Account_No));
      if (!key) continue;
      booked[key] += num(e.Amount);
      const m = str(e.Posting_Date).substring(0, 7);
      (bookedByMonth[m] ||= { conditions: 0, kam: 0, royalties: 0, marketing: 0, amazon: 0 })[key] += num(e.Amount);
    }
    const vendorName = new Map(vendors.map((v: any) => [str(v.No), str(v.Name)]));

    // Movimientos de cada documento (sin asientos de provisión PROV…)
    const byDoc = new Map<string, any[]>();
    for (const e of entries) {
      const doc = str(e.Document_No);
      if (!doc || /^PROV-/i.test(doc)) continue;   // dotaciones de provisión
      byDoc.set(doc, [...(byDoc.get(doc) || []), e]);
    }
    // Documentos que solo llegan por reclasificación: se busca su registro de compra original en cualquier cuenta
    const reclassOnly = Array.from(byDoc.entries()).filter(([d, list]) => !/^PROV\d/i.test(d) && !list.some(e => PURCHASE_CODES.test(str(e.Source_Code)))).map(([d]) => d);
    const chunks = Array.from({ length: Math.ceil(reclassOnly.length / 30) }, (_, i) => reclassOnly.slice(i * 30, i * 30 + 30));
    const origin = new Map<string, any[]>();
    for (let i = 0; i < chunks.length; i += 8) {
      const parts = await Promise.all(chunks.slice(i, i + 8).map(c => bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: `(${c.map(d => `Document_No eq '${q(d)}'`).join(' or ')}) and Source_Code eq 'PURCHASES'`,
        $select: 'Document_No,Document_Type,Posting_Date,G_L_Account_No,Amount,Source_No,External_Document_No,Gen_Posting_Type',
      }), ctx.token)));
      for (const e of parts.flat()) origin.set(str(e.Document_No), [...(origin.get(str(e.Document_No)) || []), e]);
    }

    type DocOut = {
      documentNo: string; type: string; vendorNo: string; vendorName: string; externalDocNo: string; firstDate: string;
      initialAccounts: string[]; reclassified: boolean; movements: { date: string; account: string; amount: number; source: string; description: string; balAccount: string }[];
      byAccount: Record<string, number>;
    };
    const docs: DocOut[] = [];
    const excludedJournal = 0;
    for (const [doc, list] of byDoc) {
      const purchase = list.filter(e => PURCHASE_CODES.test(str(e.Source_Code)));
      const reinvoicing = /^PROV\d/i.test(doc);   // PROV1, PROV3…: refacturación de royalties
      const found = purchase.length ? purchase : reinvoicing ? list : (origin.get(doc) || []);
      const journal = !found.length;   // diario sin factura/abono de compra detrás (Skonto Reclassification…)
      const orig = journal ? list : found;
      const typed = orig.find(e => str(e.Document_Type)) || orig[0];
      const vendorNo = str(orig.find(e => str(e.Source_No))?.Source_No);
      const byAccount: Record<string, number> = {};
      for (const e of list) byAccount[str(e.G_L_Account_No)] = r2((byAccount[str(e.G_L_Account_No)] || 0) + num(e.Amount));
      docs.push({
        documentNo: doc, type: reinvoicing ? 'Refacturación (diario)' : journal ? 'Diario' : str(typed.Document_Type).replace(/_x0020_/g, ' ') || '–', vendorNo, vendorName: vendorName.get(vendorNo) || '',
        externalDocNo: str(orig.find(e => str(e.External_Document_No))?.External_Document_No),
        firstDate: [...list, ...orig].map(e => str(e.Posting_Date).substring(0, 10)).sort()[0],
        initialAccounts: journal ? Array.from(new Set(list.map(e => str(e.Bal_Account_No)).filter(Boolean)))
          : Array.from(new Set(orig.filter(e => str(e.Gen_Posting_Type) === 'Purchase' || ACCOUNTS.includes(str(e.G_L_Account_No))).map(e => str(e.G_L_Account_No)))),
        reclassified: !journal && list.some(e => !PURCHASE_CODES.test(str(e.Source_Code))),
        movements: list.sort((a, b) => a.Entry_No - b.Entry_No).map(e => ({
          date: str(e.Posting_Date).substring(0, 10), account: str(e.G_L_Account_No), amount: r2(num(e.Amount)),
          source: str(e.Source_Code), description: str(e.Description), balAccount: str(e.Bal_Account_No),
        })),
        byAccount,
      });
    }

    // Asientos PROV-…: lo que rebaja la cuenta de provisión de cada concepto contra otras cuentas de balance
    // = saldo en la cuenta de la serie + dotación (cuenta de resultados) + traspaso desde la cuenta PROV-*
    const provDocs = new Map<string, any[]>();
    for (const e of provEntries) if (/^PROV-/i.test(str(e.Document_No))) provDocs.set(str(e.Document_No), [...(provDocs.get(str(e.Document_No)) || []), e]);
    const transferMonth: Record<string, Partial<Record<Key, number>>> = {};
    for (const [doc, list] of provDocs) {
      for (const c of CONCEPTS) {
        if (!c.account) continue;
        const key = c.key as Key;
        let t = 0;
        for (const e of list) {
          const a = str(e.G_L_Account_No).replace(/\s+/g, '');
          if (a === SERIES_ACCOUNT[key] || a === c.account || conceptOf(a) === key) t += num(e.Amount);
        }
        if (Math.abs(t) < 0.5) continue;
        const sources = list.filter(e => {
          const a = str(e.G_L_Account_No).replace(/\s+/g, '');
          return !conceptOf(a) && !ACCOUNTS.includes(str(e.G_L_Account_No)) && !Object.values(SERIES_ACCOUNT).includes(a);
        });
        const date = list.map(e => str(e.Posting_Date).substring(0, 10)).sort().pop() as string;
        docs.push({
          documentNo: doc, type: 'Traspaso (asiento PROV)', vendorNo: '', vendorName: '', externalDocNo: '', firstDate: date,
          initialAccounts: Array.from(new Set(sources.map(e => str(e.G_L_Account_No)))), reclassified: false,
          movements: sources.sort((a, b) => a.Entry_No - b.Entry_No).map(e => ({
            date: str(e.Posting_Date).substring(0, 10), account: str(e.G_L_Account_No), amount: r2(num(e.Amount)),
            source: str(e.Source_Code), description: str(e.Description), balAccount: str(e.Bal_Account_No),
          })),
          byAccount: { [c.account]: r2(t) },
        });
        (transferMonth[date.substring(0, 7)] ||= {})[key] = ((transferMonth[date.substring(0, 7)] || {})[key] || 0) + t;
      }
    }

    const concepts = CONCEPTS.map(c => {
      const list = c.account ? docs.filter(d => Math.abs(d.byAccount[c.account] || 0) >= 0.005) : [];
      const consumed = r2(list.reduce((s, d) => s + (d.byAccount[c.account] || 0), 0));
      const provision = r2(booked[c.key]);
      return {
        ...c, provision, lm: r2(gen[c.key]), consumed: c.account ? consumed : null, pending: r2(provision - (c.account ? consumed : 0)),   // sin cuenta de consumo (KAM): todo pendiente
        docs: list.map(d => ({ ...d, amount: d.byAccount[c.account] })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
      };
    });
    // Consumido por mes (fecha de cada movimiento) para comparar con lo generado
    const months = Array.from(new Set([...Object.keys(bookedByMonth), ...entries.map((e: any) => str(e.Posting_Date).substring(0, 7))])).sort();
    const docSet = new Set(docs.map(d => d.documentNo));
    const byMonth = months.map(m => ({
      month: m,
      ...Object.fromEntries(CONCEPTS.map(c => [c.key, {
        provision: r2(bookedByMonth[m]?.[c.key] || 0), lm: r2(gen.byMonth[m]?.[c.key] || 0),
        consumed: c.account ? r2(entries.filter((e: any) => docSet.has(str(e.Document_No)) && !/^PROV-/i.test(str(e.Document_No)) && str(e.G_L_Account_No) === c.account && str(e.Posting_Date).startsWith(m)).reduce((s: number, e: any) => s + num(e.Amount), 0)
          + (transferMonth[m]?.[c.key as Key] || 0)) : null,
      }])),
    }));
    return { company, from, to, lmLines: gen.lines, concepts, byMonth, excludedJournal, glEntries: entries.length };
  }, force);
}
