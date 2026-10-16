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
// Proveedores que se asignan a mano a un Customer Group (y, si se indica, a un concepto) en la tabla por grupo
// (Savi Marketing: condiciones de dm DE, aunque se registren en PROV-MARKETING)
const VENDOR_OVERRIDES: { vendor: RegExp; group: string; concept?: Key }[] = [
  { vendor: /\bsavi\b/i, group: '017', concept: 'conditions' },
  // Clientes que como proveedor no encajan por CIF ni por nombre (sufijo de país, razón social distinta)
  { vendor: /^dm[\s-]drogerie markt.*\bDE\b/i, group: '017' },
  { vendor: /rossmann/i, group: '008' },
  { vendor: /^rewe zentral/i, group: '018' },
  { vendor: /^edeka zentral/i, group: '014' },
  { vendor: /^amazon eu/i, group: '023' },
];
// Proveedor Markant (liquida las condiciones de varias cadenas: Provision Accounting Partner de la LM)
const MARKANT = /markant/i;
// Códigos y nombres de país en los nombres de Customer Group y proveedores
const COUNTRIES = new Set(['de', 'at', 'ch', 'uk', 'gb', 'fr', 'es', 'it', 'nl', 'be', 'pl', 'cz', 'pt', 'dk', 'se', 'eu', 'germany', 'austria', 'international']);
const normVat = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
// Nombre sin forma jurídica ni signos, para emparejar proveedor y cliente ("Müller Handels GmbH & Co. KG" → "muller")
const normName = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\b(gmbh|co|kg|ag|se|sarl|s a r l|sa|sl|s l|ltd|limited|bv|nv|spa|srl|sp z o o|ohg|ug|inc|llc|niederlassung|zentral|zentrale|handels|stiftung)\b/g, ' ')
  .replace(/\bdeutschland\b/g, 'de').replace(/\b(osterreich|oesterreich)\b/g, 'at')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const isAmazon = (r: any) => /amazon/i.test(`${str(r.Sell_to_Customer_Name)} ${str(r.Bill_to_Customer_Name)}`);

async function generated(ctx: BcContext, from: string, to: string) {
  const service = await findService(ctx);
  const sample = await bcFetchAll(odataUrl(service.url, { $top: '1' }), ctx.token);
  const keys = Object.keys(sample[0] || {});
  const k = (name: string) => keys.find(x => x.toLowerCase() === name.toLowerCase());
  const F = {
    date: k('Posting_date'), main: k('Main_Item_CRZ') || k('Main_Item'), sales: k('Total_Provision_Sales'), kam: k('Total_Provision_Bonus'),
    royalties: k('Total_Provision_Royalties'), marketing: k('Provision_Marketing'), sell: k('Sell_to_Customer_Name'), bill: k('Bill_to_Customer_Name'),
    group: k('Customer_Group_Code'), vat: k('VAT_Registration_No'), billVat: k('Bill_to_VAT_Registration_No'), dim: k('Customer_Dimension_Name'),
    partner: k('Provision_Accounting_Partner'),
  };
  const missing = Object.entries(F).filter(([n, v]) => !v && !['vat', 'billVat', 'dim', 'partner'].includes(n)).map(([n]) => n);
  if (sample.length && missing.length) throw new Error(`El servicio "${service.name}" no tiene los campos ${missing.join(', ')}.`);
  if (!sample.length) return { conditions: 0, kam: 0, royalties: 0, marketing: 0, amazon: 0, lines: 0, byMonth: {} as Record<string, Record<Key, number>>, byGroup: {} as Record<string, Record<Key, number>>, groupIds: {} as Record<string, { vats: Set<string>; names: Set<string> }>, markantByGroup: {} as Record<string, number> };
  const rows = await bcFetchAll(odataUrl(service.url, {
    $filter: `${F.date} ge ${from} and ${F.date} le ${to}`, $select: Object.values(F).filter(Boolean).join(','),
  }), ctx.token);
  const out = { conditions: 0, kam: 0, royalties: 0, marketing: 0, amazon: 0, lines: 0, byMonth: {} as Record<string, Record<Key, number>>, byGroup: {} as Record<string, Record<Key, number>>, groupIds: {} as Record<string, { vats: Set<string>; names: Set<string> }>, markantByGroup: {} as Record<string, number> };
  for (const r0 of rows) {
    const r = { ...r0, Sell_to_Customer_Name: r0[F.sell!], Bill_to_Customer_Name: r0[F.bill!] };
    if (r0[F.main!] === true) continue;
    const v: Record<Key, number> = {
      conditions: num(r0[F.sales!]), kam: num(r0[F.kam!]), royalties: num(r0[F.royalties!]),
      marketing: isAmazon(r) ? 0 : num(r0[F.marketing!]), amazon: isAmazon(r) ? num(r0[F.marketing!]) : 0,
    };
    const m = str(r0[F.date!]).substring(0, 7);
    const bm = (out.byMonth[m] ||= { conditions: 0, kam: 0, royalties: 0, marketing: 0, amazon: 0 });
    const bg = (out.byGroup[str(r0[F.group!])] ||= { conditions: 0, kam: 0, royalties: 0, marketing: 0, amazon: 0 });
    // Identificadores de los clientes del grupo (CIF y nombres) para encontrar sus facturas como proveedor
    const ids = (out.groupIds[str(r0[F.group!])] ||= { vats: new Set(), names: new Set() });
    for (const f of [F.vat, F.billVat]) if (f && str(r0[f])) ids.vats.add(normVat(str(r0[f])));
    for (const f of [F.sell, F.bill, F.dim]) if (f && str(r0[f])) ids.names.add(normName(str(r0[f])));
    for (const key of Object.keys(v) as Key[]) { out[key] += v[key]; bm[key] += v[key]; bg[key] += v[key]; }
    // Parte de Markant (Provision Accounting Partner), incluida en Total Provision Sales
    if (F.partner) out.markantByGroup[str(r0[F.group!])] = (out.markantByGroup[str(r0[F.group!])] || 0) + num(r0[F.partner]);
    out.lines++;
  }
  return out;
}

export async function consumedProvisionsReport(ctx: BcContext, company: string, from: string, to: string, force = false) {
  return cached(`ctrl:consumedProv13:${company}:${from}:${to}`, to < today() ? 6 * HOUR : 1 * HOUR, async () => {
    const [gen, entries, vendors, provEntries, customerGroups] = await Promise.all([
      generated(ctx, from, to),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: `Posting_Date ge ${from} and Posting_Date le ${to} and (${ACCOUNTS.map(a => `G_L_Account_No eq '${a}'`).join(' or ')})`,
        $select: 'Entry_No,Posting_Date,Document_Type,Document_No,G_L_Account_No,Description,Amount,Source_Type,Source_No,Source_Code,External_Document_No,Bal_Account_No',
      }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Vendor_Card_Excel`, { $select: 'No,Name,VAT_Registration_No' }), ctx.token).catch(() => [] as any[]),
      bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/General_Ledger_Entries_Excel`, {
        $filter: `startswith(Document_No,'PROV') and Posting_Date ge ${from} and Posting_Date le ${to}`,
        $select: 'Entry_No,Posting_Date,Document_No,G_L_Account_No,Description,Amount,Source_Code,Bal_Account_No',
      }), ctx.token),
      // Nombres de los Customer Groups (API custom customerGroups)
      bcFetchAll(odataUrl(`${ctx.customApiBase}/customerGroups`, { $select: 'code,description' }), ctx.token).catch(() => [] as any[]),
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
    // Calculado por la LM, por Customer Group
    const groupName = new Map(customerGroups.map((g: any) => [str(g.code), str(g.description)]));
    // Conditions sin la parte de Markant (Provision Accounting Partner), que va en su propia columna
    const lmByGroup = Object.entries(gen.byGroup).map(([code, v]) => {
      const markant = gen.markantByGroup[code] || 0;
      return {
        code: code || '(sin grupo)', name: groupName.get(code) || '',
        ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r2(x)])) as Record<Key, number>,
        conditions: r2(v.conditions - markant), markant: r2(markant),
        total: r2(Object.values(v).reduce((t, x) => t + x, 0)),
      };
    }).filter(g => Math.abs(g.markant) >= 0.005 || CONCEPTS.some(c => Math.abs(g[c.key]) >= 0.005))
      .sort((a, b) => b.total - a.total);
    // Facturas y abonos de compra de cada Customer Group: proveedor emparejado con los clientes del grupo en la LM,
    // por CIF y, si no, por nombre (exacto o primera palabra, cuando solo encaja en un grupo)
    const vendorVat = new Map(vendors.map((v: any) => [str(v.No), normVat(str(v.VAT_Registration_No))]));
    const groupOfVendor = new Map<string, string>();
    const override = (vendorNo: string) => VENDOR_OVERRIDES.find(o => o.vendor.test(vendorName.get(vendorNo) || ''));
    const byVat = new Map<string, string>(), byNameExact = new Map<string, string>(), byFirst = new Map<string, Set<string>>();
    for (const [code, ids] of Object.entries(gen.groupIds)) {
      ids.vats.forEach(v => { if (v) byVat.set(v, code); });
      ids.names.forEach(n => {
        if (!n) return;
        byNameExact.set(n, code);
        const first = n.split(' ')[0];
        if (first.length >= 3) byFirst.set(first, (byFirst.get(first) || new Set<string>()).add(code));
      });
    }
    // Último recurso: el nombre del Customer Group ("dm DE", "Müller", "Amazon EU", "Rewe International"…). Todas sus
    // palabras (sin el país) tienen que estar en el nombre del proveedor; si el proveedor lleva país, gana el grupo de ese país.
    const groupWords = Array.from(groupName.entries()).filter(([code]) => gen.byGroup[code]).map(([code, gname]) => {
      const words = normName(gname).split(' ').filter(Boolean);
      return { code, core: words.filter(w => !COUNTRIES.has(w)), country: words.find(w => COUNTRIES.has(w)) || '' };
    }).filter(g => g.core.length && g.core.every(w => w.length >= 2) && !(g.core.length === 1 && g.core[0].length < 3 && g.core[0] !== 'dm'));
    const byGroupName = (vendor: string) => {
      const words = new Set(normName(vendor).split(' ').filter(Boolean));
      const vendorCountry = Array.from(words).find(w => COUNTRIES.has(w)) || '';
      let best = '', bestScore = 0, tie = false;
      for (const g of groupWords) {
        if (!g.core.every(w => words.has(w))) continue;
        const score = g.core.length * 2 + (g.country && g.country === vendorCountry ? 1 : 0) - (g.country && vendorCountry && g.country !== vendorCountry ? 2 : 0)
          + (!g.country && !vendorCountry ? 0.5 : 0);
        if (score > bestScore) { best = g.code; bestScore = score; tie = false; } else if (score === bestScore) tie = true;
      }
      if (bestScore > 0 && !tie) return best;
      // Primera palabra distintiva del grupo (≥ 4 letras) que solo tiene un grupo: "Koordination GLOBUS Holding" → Globus Bingen
      const firstHits = groupWords.filter(g => g.core[0].length >= 4 && words.has(g.core[0]));
      const unique = firstHits.filter(g => groupWords.filter(x => x.core[0] === g.core[0]).length === 1);
      return unique.length === 1 ? unique[0].code : '';
    };
    const matchGroup = (vendorNo: string) => {
      if (groupOfVendor.has(vendorNo)) return groupOfVendor.get(vendorNo)!;
      const o = override(vendorNo);
      if (o) { groupOfVendor.set(vendorNo, o.group); return o.group; }
      const vat = vendorVat.get(vendorNo) || '';
      const name = normName(vendorName.get(vendorNo) || '');
      const first = byFirst.get(name.split(' ')[0]);
      const g = (vat && byVat.get(vat)) || byNameExact.get(name) || (first && first.size === 1 ? Array.from(first)[0] : '') || byGroupName(vendorName.get(vendorNo) || '');
      groupOfVendor.set(vendorNo, g);
      return g;
    };
    type GroupDoc = { concept: Key | 'markant'; documentNo: string; type: string; date: string; vendorNo: string; vendorName: string; externalDocNo: string; amount: number };
    const groupDocs = new Map<string, GroupDoc[]>();
    const markantDocs: { amount: number; documentNo: string; firstDate: string }[] = [];
    for (const c of concepts) {
      for (const x of c.docs) {
        if (!x.vendorNo || (x.type !== 'Invoice' && x.type !== 'Credit Memo')) continue;
        if (MARKANT.test(x.vendorName)) { markantDocs.push(x); continue; }
        const g = matchGroup(x.vendorNo);
        if (!g) continue;
        groupDocs.set(g, [...(groupDocs.get(g) || []), {
          concept: override(x.vendorNo)?.concept || c.key as Key, documentNo: x.documentNo, type: x.type, date: x.firstDate, vendorNo: x.vendorNo, vendorName: x.vendorName, externalDocNo: x.externalDocNo, amount: x.amount,
        }]);
      }
    }
    // Facturas de Markant: no indican el grupo; se reparten en proporción al Markant calculado de cada grupo
    const markantConsumed = markantDocs.reduce((t, x) => t + x.amount, 0);
    const markantCalc = lmByGroup.reduce((t, g) => t + g.markant, 0);
    const withConsumed = lmByGroup.map(g => {
      const docs = [...(groupDocs.get(g.code === '(sin grupo)' ? '' : g.code) || [])];
      const share = markantCalc ? g.markant / markantCalc : 0;
      if (share && markantConsumed) docs.push({
        concept: 'markant', documentNo: `Facturas Markant (${markantDocs.length})`, type: 'Reparto', date: markantDocs.map(x => x.firstDate).sort().pop() || '',
        vendorNo: '', vendorName: `Markant · ${(share * 100).toFixed(1)} % del total`, externalDocNo: '', amount: r2(markantConsumed * share),
      });
      const consumed = Object.fromEntries([...CONCEPTS.map(c => c.key), 'markant'].map(k => [k, r2(docs.filter(x => x.concept === k).reduce((t, x) => t + x.amount, 0))])) as Record<Key | 'markant', number>;
      // Factura y abono que se anulan (mismo proveedor, fecha, concepto e importe contrario): no se listan (suman 0)
      const pairKey = (x: GroupDoc) => `${x.vendorNo}|${x.date}|${x.concept}|${Math.abs(x.amount).toFixed(2)}`;
      const memos = new Map<string, GroupDoc[]>();
      for (const x of docs) if (x.type === 'Credit Memo') memos.set(pairKey(x), [...(memos.get(pairKey(x)) || []), x]);
      const hidden = new Set<GroupDoc>();
      for (const x of docs) {
        if (x.type !== 'Invoice') continue;
        const m = memos.get(pairKey(x));
        const y = m?.find(c => !hidden.has(c) && Math.abs(c.amount + x.amount) < 0.005);
        if (y) { hidden.add(x); hidden.add(y); }
      }
      const shown = docs.filter(x => !hidden.has(x));
      const cancelled = hidden.size / 2;
      return { ...g, consumed, consumedTotal: r2(Object.values(consumed).reduce((t, x) => t + x, 0)), cancelledPairs: cancelled, docs: shown.sort((a, b) => a.date.localeCompare(b.date)) };
    });

    return { company, from, to, lmLines: gen.lines, concepts, byMonth, lmByGroup: withConsumed, excludedJournal, glEntries: entries.length };
  }, force);
}
