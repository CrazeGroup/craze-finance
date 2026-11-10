import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { bankLedgerEntries, batchLines, journalByCode, openEntries, type MovementResult, type OpenEntry, type SuggestedLine } from '@/lib/banco';
import { remittanceItems, vendorRemittances, type Remittance } from '@/lib/amazonVendor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Amazon permite 0,5 llamadas/s: el detalle de cada pago que falta es una llamada
export const maxDuration = 300;
// Detalles por llamada (≈ 2 s cada uno); el resto se pide con otra llamada
const MAX_DETAILS = 100;

const r2 = (v: number) => Math.round(v * 100) / 100;
const cents = (v: number) => Math.round(v * 100);
const isoMinus = (d: string, n: number) => new Date(Date.parse(d) - n * 86400000).toISOString().slice(0, 10);

// BANCO con la cuenta de Amazon Vendor (AMAVEN): en vez de un extracto, los pagos de Amazon de la Finance Remittance API.
// Un pago está registrado si AMAVEN tiene movimientos con su nº de pago (Document No.) o ya está en el lote; para los que
// faltan, una línea por factura de la remesa: la factura abierta de cliente o proveedor con ese nº (liquidada), o si no
// la cuenta con la que se registraron los pagos de ese país. Como en AMAVEN, cada pago lleva además el traspaso de su importe
// al banco (la Bank Account más usada como contrapartida en AMAVEN, p. ej. 1820 00), con el mismo nº de documento.
// Los pagos aún en curso (IN_PROGRESS) no se sugieren. Body: { bankNo, journalCode, from, to }
export async function POST(req: Request) {
  try {
    const company = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
    if (company === 'ALL') return NextResponse.json({ error: 'Selecciona una empresa concreta.' }, { status: 400 });
    const { bankNo, journalCode, from, to } = await req.json();
    if (!bankNo) return NextResponse.json({ error: 'Elige la cuenta de banco.' }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) {
      return NextResponse.json({ error: 'Indica el periodo (desde y hasta).' }, { status: 400 });
    }

    const ctx = await getBcContext(company);
    const journal = journalCode ? await journalByCode(ctx, journalCode) : null;
    // Para aprender las cuentas de cada país, los movimientos de AMAVEN desde 6 meses antes
    const histFrom = isoMinus(from, 180);
    const [remittances, history, open, inBatch] = await Promise.all([
      vendorRemittances(from, to),
      bankLedgerEntries(ctx, bankNo, histFrom),
      openEntries(ctx).catch(() => [] as OpenEntry[]),
      journal ? batchLines(ctx, journal.id, bankNo) : Promise.resolve([]),
    ]);
    const paid = remittances.filter(r => /success|paid|complete/i.test(r.status));
    const held = remittances.filter(r => /progress|pending|schedul/i.test(r.status));
    const entries = history.filter(e => !e.reversed);
    const byDoc = new Map<string, typeof entries>();
    for (const e of entries) byDoc.set(e.docNo, [...(byDoc.get(e.docNo) || []), e]);
    const batchDocs = new Map<string, typeof inBatch>();
    for (const b of inBatch) batchDocs.set(b.docNo, [...(batchDocs.get(b.docNo) || []), b]);

    // Cuenta de cliente y de proveedor más usada en AMAVEN para los pagos de cada país (los ya registrados del periodo)
    const learn = new Map<string, Map<string, number>>();
    for (const r of paid) {
      for (const e of byDoc.get(r.paymentNumber) || []) {
        if (e.balType !== 'Customer' && e.balType !== 'Vendor') continue;
        const k = `${r.country}|${e.balType}`;
        const m = learn.get(k) || new Map<string, number>();
        m.set(e.balNo, (m.get(e.balNo) || 0) + 1);
        learn.set(k, m);
      }
    }
    const usual = (country: string, side: 'Customer' | 'Vendor') => {
      const m = learn.get(`${country}|${side}`) || learn.get(`|${side}`);
      if (!m) {
        // Sin pagos de ese país en el periodo: la más usada en todo el historial de AMAVEN
        const all = new Map<string, number>();
        for (const e of entries) if (e.balType === side) all.set(e.balNo, (all.get(e.balNo) || 0) + 1);
        return Array.from(all.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      }
      return Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0][0];
    };
    const nameOf = new Map(open.map(o => [`${o.side}|${o.no}`, o.name]));
    // Banco al que se traspasan los pagos de Amazon
    const banksUsed = new Map<string, number>();
    for (const e of entries) if (e.balType === 'Bank Account') banksUsed.set(e.balNo, (banksUsed.get(e.balNo) || 0) + 1);
    const transferBank = Array.from(banksUsed.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    // Solo facturas y abonos (no pagos abiertos que lleven ese nº como documento externo)
    const docs = open.filter(o => /invoice|credit/i.test(o.docType));
    const custByDoc = new Map(docs.filter(o => o.side === 'Customer').map(o => [o.docNo, o]));
    const vendByDoc = new Map<string, OpenEntry>();
    for (const o of docs.filter(o => o.side === 'Vendor')) { if (o.extDocNo) vendByDoc.set(o.extDocNo, o); vendByDoc.set(o.docNo, o); }

    // Líneas sugeridas de un pago que falta, desde su detalle
    const suggestion = async (r: Remittance) => {
      const items = await remittanceItems(r.uniquePaymentId);
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

    let details = 0;
    let pending = 0;
    const movements: MovementResult[] = [];
    for (const [idx, r] of paid.entries()) {
      const base = {
        idx, date: r.date, valueDate: r.date, text: `Amazon Vendor · ${r.country} · ${r.method}`,
        purpose: `PAYMENT-NUM ${r.paymentNumber} · ID ${r.uniquePaymentId} · ${r.lineCount} ${r.lineCount === 1 ? 'factura' : 'facturas'}${r.currency && r.currency !== 'EUR' ? ` · ${r.currency}` : ''}`,
        name: 'Amazon', iban: '', endToEnd: r.uniquePaymentId, amount: r2(r.amount), pending: false, account: '',
      };
      const posted = byDoc.get(r.paymentNumber);
      if (posted?.length) {
        // Sin el traspaso al banco: clientes + proveedores = importe del pago
        const sum = posted.filter(e => e.balType !== 'Bank Account').reduce((t, e) => t + e.amount, 0);
        movements.push({
          ...base, status: 'posted', suggestion: null, doubtful: cents(sum) !== cents(r.amount),
          matched: posted.map(e => ({ docNo: e.docNo, date: e.date, description: e.description, balType: e.balType, balNo: e.balNo, amount: e.amount })),
        });
        continue;
      }
      const batched = batchDocs.get(r.paymentNumber);
      if (batched?.length) {
        movements.push({ ...base, status: 'batch', suggestion: null, matched: batched.map(b => ({ docNo: b.docNo, date: b.date, description: b.description, balType: '', balNo: '', amount: b.bankAmount })) });
        continue;
      }
      if (details >= MAX_DETAILS) {
        pending++;
        movements.push({ ...base, status: 'new', matched: [], suggestion: { documentNo: r.paymentNumber, source: 'Amazon', note: 'Detalle no leído: analiza un periodo más corto', lines: [] } });
        continue;
      }
      details++;
      movements.push({ ...base, status: 'new', matched: [], suggestion: await suggestion(r) });
      // Traspaso del pago al banco (mismo nº de documento)
      if (cents(r.amount) && transferBank) {
        movements.push({
          ...base, idx: 100000 + idx, amount: -r2(r.amount), text: `Traspaso a ${transferBank}`, purpose: `PAYMENT-NUM ${r.paymentNumber} · traspaso del pago al banco`,
          status: 'new', matched: [], suggestion: {
            documentNo: r.paymentNumber, source: 'Amazon', note: `Traspaso a ${transferBank}, como los pagos ya registrados en AMAVEN`,
            lines: [{ accountType: 'Bank Account', accountNo: transferBank, accountName: '', description: r.paymentNumber, amount: -r2(r.amount) }],
          },
        });
      }
    }


    const currencies = Array.from(new Set(paid.map(r => r.currency).filter(c => c && c !== 'EUR')));
    const warning = [
      currencies.length ? `Hay pagos en ${currencies.join(', ')}: revisa que correspondan a esta cuenta.` : '',
      pending ? `${pending} pagos sin detalle (Amazon solo deja leer ${MAX_DETAILS} por vez): vuelve a analizar un periodo más corto.` : '',
    ].filter(Boolean).join(' ');
    return NextResponse.json({
      bankNo, journalCode: journal?.code || '', from, warning, entries: entries.filter(e => e.date >= isoMinus(from, 10)).length, movements,
      // Pagos que Amazon aún está procesando: se muestran aparte, no se registran
      held: held.map(r => ({ date: r.date, valueDate: r.date, name: `Amazon ${r.country} · ${r.status}`, purpose: `PAYMENT-NUM ${r.paymentNumber} · ${r.lineCount} facturas`, amount: r2(r.amount) })),
    });
  } catch (error: any) {
    console.error('BANCO Amazon:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
