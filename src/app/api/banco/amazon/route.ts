import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import { bankLedgerEntries, batchLines, journalByCode, openEntries, type MovementResult, type OpenEntry, type SuggestedLine } from '@/lib/banco';
import { amazonCompany, remittanceItems, vendorRemittances, type Remittance, type RemittanceItem } from '@/lib/amazonVendor';
import { readSetting, writeSetting } from '@/lib/reporting/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Amazon permite 0,5 llamadas/s: el detalle de cada pago que falta es una llamada
export const maxDuration = 300;
// Detalles por llamada (≈ 2 s cada uno); el resto se pide con otra llamada
const MAX_DETAILS = 100;
// Sin revisión anterior, los pagos de los últimos 60 días; después, desde una semana antes de la última revisión
const FIRST_DAYS = 60;
const SETTLE_DAYS = 7;

const r2 = (v: number) => Math.round(v * 100) / 100;
const cents = (v: number) => Math.round(v * 100);
const today = () => new Date().toISOString().slice(0, 10);
const isoMinus = (d: string, n: number) => new Date(Date.parse(d) - n * 86400000).toISOString().slice(0, 10);

// Pagos de Amazon ya vistos, por empresa: done = su desglose ya está en AMAVEN (no se vuelven a comprobar pasada una
// semana); items = detalle de los que faltan (no cambia una vez pagado); checkedUntil = hasta dónde se leyó la API
type Stored = Remittance & { done?: boolean };
type Store = { checkedUntil: string; payments: Record<string, Stored>; items: Record<string, RemittanceItem[]> };

// BANCO con la cuenta de Amazon Vendor (AMAVEN). El cobro real se sube con el extracto de SPARKASSE contra AMAVEN; aquí se
// sube a AMAVEN el desglose de cada pago de Amazon (Finance Remittance API) para que el saldo de cada pago en AMAVEN quede
// en 0. Un pago está hecho cuando AMAVEN tiene movimientos de clientes/proveedores (no del banco) con su nº de pago como
// Document No., o está en el lote. Para los que faltan, una línea por factura de la remesa: la factura abierta de cliente o
// proveedor con ese nº (liquidada), o si no la cuenta con la que se registraron los pagos de ese país. Los pagos aún en curso
// (IN_PROGRESS) no se sugieren. Body: { bankNo, journalCode, from? } (from: releer la API desde esa fecha)
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    if (!amazonCompany(company)) return NextResponse.json({ error: 'Esta empresa no vende a Amazon: los pagos de Amazon Vendor son de CRAZE GmbH y CRAZE Toys Ltd (UK).' }, { status: 400 });
    const { bankNo, journalCode, from: askedFrom } = await req.json();
    if (!bankNo) return NextResponse.json({ error: 'Elige la cuenta de banco.' }, { status: 400 });
    if (askedFrom && !/^\d{4}-\d{2}-\d{2}$/.test(askedFrom)) return NextResponse.json({ error: 'Fecha "desde" no válida.' }, { status: 400 });

    const key = `amazon:remittances:${company}:${bankNo}`;
    const store = await readSetting<Store>(key, { checkedUntil: '', payments: {}, items: {} });
    const to = today();
    // Desde una semana antes de la última revisión, o desde el pago más antiguo que seguía en curso
    const stillHeld = Object.values(store.payments).filter(r => !/success|paid|complete/i.test(r.status)).map(r => r.date).sort()[0];
    const auto = store.checkedUntil ? isoMinus(store.checkedUntil, SETTLE_DAYS) : isoMinus(to, FIRST_DAYS);
    const from = askedFrom || (stillHeld && stillHeld < auto ? stillHeld : auto);

    const ctx = await getBcContext(company);
    const journal = journalCode ? await journalByCode(ctx, journalCode) : null;
    const [fetched, bank] = await Promise.all([
      vendorRemittances(from, to, company),
      bcFetchAll(odataUrl(`${ctx.apiBase}/bankAccounts`, { $filter: `number eq '${String(bankNo).replace(/'/g, "''")}'`, $select: 'currencyCode' }), ctx.token).catch(() => []),
    ]);
    // Solo los pagos en la divisa de la cuenta (sin divisa = EUR)
    const bankCur = String(bank[0]?.currencyCode || '') || 'EUR';
    for (const r of fetched) {
      if ((r.currency || 'EUR') !== bankCur) continue;
      store.payments[r.uniquePaymentId] = { ...r, done: store.payments[r.uniquePaymentId]?.done };
    }

    // Por comprobar: los que no están hechos y los hechos de la última semana (por si se anulan)
    const weekAgo = isoMinus(to, SETTLE_DAYS);
    const all = Object.values(store.payments);
    const toCheck = all.filter(r => !r.done || r.date >= weekAgo);
    const oldDone = all.length - toCheck.length;
    const paid = toCheck.filter(r => /success|paid|complete/i.test(r.status)).sort((a, b) => a.date.localeCompare(b.date) || a.paymentNumber.localeCompare(b.paymentNumber));
    const held = toCheck.filter(r => /progress|pending|schedul/i.test(r.status));

    // Movimientos de AMAVEN desde 6 meses antes del pago más antiguo por comprobar (también para aprender las cuentas)
    const oldest = paid.reduce((m, r) => (r.date < m ? r.date : m), to);
    const [history, open, inBatch] = await Promise.all([
      bankLedgerEntries(ctx, bankNo, isoMinus(oldest, 180)),
      openEntries(ctx).catch(() => [] as OpenEntry[]),
      journal ? batchLines(ctx, journal.id, bankNo) : Promise.resolve([]),
    ]);
    // El desglose: movimientos de clientes, proveedores o cuentas (el cobro desde SPARKASSE es de tipo banco)
    const entries = history.filter(e => !e.reversed && e.balType !== 'Bank Account');
    const byDoc = new Map<string, typeof entries>();
    for (const e of entries) byDoc.set(e.docNo, [...(byDoc.get(e.docNo) || []), e]);
    const batchDocs = new Map<string, typeof inBatch>();
    for (const b of inBatch) batchDocs.set(b.docNo, [...(batchDocs.get(b.docNo) || []), b]);

    // Cuenta de cliente y de proveedor más usada en AMAVEN para los pagos de cada país
    const learn = new Map<string, Map<string, number>>();
    for (const r of all) {
      for (const e of byDoc.get(r.paymentNumber) || []) {
        if (e.balType !== 'Customer' && e.balType !== 'Vendor') continue;
        const k = `${r.country}|${e.balType}`;
        const m = learn.get(k) || new Map<string, number>();
        m.set(e.balNo, (m.get(e.balNo) || 0) + 1);
        learn.set(k, m);
      }
    }
    const usual = (country: string, side: 'Customer' | 'Vendor') => {
      const m = learn.get(`${country}|${side}`);
      if (!m) {
        // Sin pagos de ese país: la más usada en todo el historial de AMAVEN
        const any = new Map<string, number>();
        for (const e of entries) if (e.balType === side) any.set(e.balNo, (any.get(e.balNo) || 0) + 1);
        return Array.from(any.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      }
      return Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0][0];
    };
    const nameOf = new Map(open.map(o => [`${o.side}|${o.no}`, o.name]));
    // Solo facturas y abonos (no pagos abiertos que lleven ese nº como documento externo)
    const docs = open.filter(o => /invoice|credit/i.test(o.docType));
    const custByDoc = new Map(docs.filter(o => o.side === 'Customer').map(o => [o.docNo, o]));
    const vendByDoc = new Map<string, OpenEntry>();
    for (const o of docs.filter(o => o.side === 'Vendor')) { if (o.extDocNo) vendByDoc.set(o.extDocNo, o); vendByDoc.set(o.docNo, o); }

    // Líneas sugeridas de un pago que falta, desde su detalle (guardado una vez leído)
    let details = 0;
    const suggestion = async (r: Remittance) => {
      let items = store.items[r.uniquePaymentId];
      if (!items) {
        details++;
        items = await remittanceItems(r);
        store.items[r.uniquePaymentId] = items;
      }
      let applied = 0, byCountry = 0, empty = 0;
      const lines: SuggestedLine[] = items.map(i => {
        const amount = r2(i.netPaid);
        // Factura abierta con ese nº: de cliente (nuestras facturas de venta) o de proveedor (notas de cargo de Amazon)
        const c = custByDoc.get(i.invoiceNumber);
        const v = vendByDoc.get(i.invoiceNumber);
        const o = c && (!v || amount > 0) ? c : v;
        const description = (i.description || i.invoiceNumber || 'AMAZON VENDOR').substring(0, 100);
        if (o) {
          applied++;
          return {
            accountType: o.side, accountNo: o.no, accountName: o.name, description, amount,
            appliesToDocType: /credit/i.test(o.docType) ? 'Credit Memo' : 'Invoice', appliesToDocNo: o.docNo,
          } as SuggestedLine;
        }
        const side = amount >= 0 ? 'Customer' : 'Vendor';
        const no = usual(r.country, side);
        if (no) byCountry++; else empty++;
        return { accountType: no ? side : '', accountNo: no, accountName: nameOf.get(`${side}|${no}`) || '', description: `${description} ${i.invoiceNumber}`.trim().substring(0, 100), amount };
      });
      const diff = r2(r.amount - lines.reduce((t, l) => t + l.amount, 0));
      if (Math.abs(diff) >= 0.01) {
        lines.push({ accountType: '', accountNo: '', accountName: '', description: 'Diferencia con el pago de Amazon', amount: diff });
      }
      const note = [
        `${items.length} ${items.length === 1 ? 'factura' : 'facturas'} de la remesa`,
        applied ? `${applied} liquidan facturas abiertas` : '',
        byCountry ? `${byCountry} a la cuenta habitual de ${r.country} (sin factura abierta con ese nº)` : '',
        empty ? `${empty} sin cuenta` : '',
        Math.abs(diff) >= 0.01 ? `el detalle no suma el pago (${diff.toFixed(2)})` : '',
      ].filter(Boolean).join(' · ');
      return { documentNo: r.paymentNumber, source: 'Amazon', note, lines };
    };

    let pending = 0;
    const movements: MovementResult[] = [];
    for (const [idx, r] of paid.entries()) {
      const base = {
        idx, date: r.date, valueDate: r.date, text: `Amazon Vendor · ${r.country} (${r.marketplace}) · ${r.method}`,
        purpose: `PAYMENT-NUM ${r.paymentNumber} · ID ${r.uniquePaymentId} · ${r.lineCount} ${r.lineCount === 1 ? 'factura' : 'facturas'}${r.currency && r.currency !== 'EUR' ? ` · ${r.currency}` : ''}`,
        name: 'Amazon', iban: '', endToEnd: r.uniquePaymentId, amount: r2(r.amount), pending: false, account: '',
      };
      const posted = byDoc.get(r.paymentNumber);
      if (posted?.length) {
        store.payments[r.uniquePaymentId].done = true;
        delete store.items[r.uniquePaymentId];
        const sum = posted.reduce((t, e) => t + e.amount, 0);
        movements.push({
          ...base, status: 'posted', suggestion: null, doubtful: cents(sum) !== cents(r.amount),
          matched: posted.map(e => ({ docNo: e.docNo, date: e.date, description: e.description, balType: e.balType, balNo: e.balNo, amount: e.amount })),
        });
        continue;
      }
      store.payments[r.uniquePaymentId].done = false;
      const batched = batchDocs.get(r.paymentNumber);
      if (batched?.length) {
        movements.push({ ...base, status: 'batch', suggestion: null, matched: batched.map(b => ({ docNo: b.docNo, date: b.date, description: b.description, balType: '', balNo: '', amount: b.bankAmount })) });
        continue;
      }
      if (details >= MAX_DETAILS && !store.items[r.uniquePaymentId]) {
        pending++;
        movements.push({ ...base, status: 'new', matched: [], suggestion: { documentNo: r.paymentNumber, source: 'Amazon', note: 'Detalle aún no leído: vuelve a pulsar Leer pagos de Amazon', lines: [] } });
        continue;
      }
      movements.push({ ...base, status: 'new', matched: [], suggestion: await suggestion(r) });
    }

    // Revisado hasta hoy (la siguiente lectura repasa la última semana)
    if (!askedFrom || askedFrom <= (store.checkedUntil || to)) store.checkedUntil = to;
    await writeSetting(key, store);

    const warning = [
      pending ? `${pending} pagos sin detalle (Amazon solo deja leer ${MAX_DETAILS} cada vez): vuelve a pulsar Leer pagos de Amazon.` : '',
    ].filter(Boolean).join(' ');
    return NextResponse.json({
      bankNo, journalCode: journal?.code || '', from, warning, entries: entries.length, movements,
      amazon: { readFrom: from, oldDone, checkedUntil: store.checkedUntil },
      // Pagos que Amazon aún está procesando: se muestran aparte, no se registran
      held: held.map(r => ({ date: r.date, valueDate: r.date, name: `Amazon ${r.country} · ${r.status}`, purpose: `PAYMENT-NUM ${r.paymentNumber} · ${r.lineCount} facturas`, amount: r2(r.amount) })),
    });
  } catch (error: any) {
    console.error('BANCO Amazon:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
