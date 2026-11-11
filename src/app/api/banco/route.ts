import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';
import {
  bankLedgerEntries, batchLines, journalByCode, matchBatch, matchMovements, openEntries, parseBankFile, collapseGroups, suggest,
  type MovementResult, type Party,
} from '@/lib/banco';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

async function company() {
  const c = (await cookies()).get('craze_selected_company')?.value || 'CRAZE';
  if (c === 'ALL') throw new Error('Selecciona una empresa concreta.');
  return c;
}

// Cuentas de banco y lotes del General Journal (con su cuenta de contrapartida) de la empresa
export async function GET() {
  try {
    const companyId = await company();
    const ctx = await getBcContext(companyId);
    const [banks, journals, accounts, customers, vendors] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.apiBase}/bankAccounts`, { $select: 'number,displayName,iban,currencyCode,blocked' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.apiBase}/journals`, { $select: 'code,displayName,balancingAccountNumber' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.apiBase}/accounts`, { $select: 'number,displayName' }), ctx.token).catch(() => []),
      prisma.customer.findMany({ where: { companyId }, select: { bcId: true, name: true } }),
      prisma.vendor.findMany({ where: { companyId }, select: { bcId: true, name: true } }),
    ]);
    // Nombre de cada cuenta por tipo|número, para mostrarlo junto al nº en las líneas del diario
    const names: Record<string, string> = {};
    for (const a of accounts as any[]) names[`G/L Account|${a.number}`] = a.displayName;
    for (const b of banks as any[]) names[`Bank Account|${b.number}`] = b.displayName;
    for (const c of customers) if (c.bcId) names[`Customer|${c.bcId}`] = c.name;
    for (const v of vendors) if (v.bcId) names[`Vendor|${v.bcId}`] = v.name;
    return NextResponse.json({
      names,
      banks: banks.filter((b: any) => !b.blocked).map((b: any) => ({ number: b.number, name: b.displayName, iban: String(b.iban || '').replace(/\s/g, '').toUpperCase(), currency: b.currencyCode })),
      journals: journals.map((j: any) => ({ code: j.code, name: j.displayName, bankNo: j.balancingAccountNumber })),
    });
  } catch (error: any) {
    console.error('BANCO cuentas:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Analiza el extracto: multipart con file (CSV del banco), bankNo y journalCode
export async function POST(req: Request) {
  try {
    const companyId = await company();
    const form = await req.formData();
    const file = form.get('file');
    const bankNo = String(form.get('bankNo') || '');
    const journalCode = String(form.get('journalCode') || '');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Sube el extracto del banco (CSV o Excel).' }, { status: 400 });
    if (!bankNo) return NextResponse.json({ error: 'Elige la cuenta de banco.' }, { status: 400 });

    const all = parseBankFile(new Uint8Array(await file.arrayBuffer()), file.name);
    // Movimientos vorgemerkt / pendientes (retenidos, aún no cargados en la cuenta): no se cuadran ni se sugieren
    const held = all.filter(m => m.pending);
    const parsed = all.filter(m => !m.pending);
    if (!all.length) return NextResponse.json({ error: 'El fichero no tiene movimientos.' }, { status: 400 });
    if (!parsed.length) return NextResponse.json({ error: `El fichero solo tiene movimientos vorgemerkt (${held.length}, retenidos y aún no cargados en la cuenta): no hay nada que registrar.` }, { status: 400 });

    const ctx = await getBcContext(companyId);
    const from = new Date(Date.parse(parsed.reduce((a, m) => (m.date < a ? m.date : a), parsed[0].date)) - 10 * 86400000).toISOString().slice(0, 10);
    const journal = journalCode ? await journalByCode(ctx, journalCode) : null;
    // Para cuadrar, desde 10 días antes del extracto; para sugerir, los últimos 12 meses (o desde el extracto si es anterior)
    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const [history, open, inBatch, customers, vendors] = await Promise.all([
      bankLedgerEntries(ctx, bankNo, from < yearAgo ? from : yearAgo),
      openEntries(ctx).catch(() => []),
      journal ? batchLines(ctx, journal.id, bankNo) : Promise.resolve([]),
      prisma.customer.findMany({ where: { companyId }, select: { bcId: true, name: true } }),
      prisma.vendor.findMany({ where: { companyId }, select: { bcId: true, name: true } }),
    ]);
    const parties: Party[] = [
      ...customers.filter(c => c.bcId).map(c => ({ side: 'Customer' as const, no: c.bcId!, name: c.name })),
      ...vendors.filter(v => v.bcId).map(v => ({ side: 'Vendor' as const, no: v.bcId!, name: v.name })),
    ];

    const entries = history.filter(e => !e.reversed && e.date >= from);
    const matched = matchMovements(parsed, entries);
    const movements = collapseGroups(parsed, matched);
    const unposted = movements.filter(m => !matched.has(m.idx));
    const batched = matchBatch(unposted, inBatch);
    const suggestions = suggest(movements, matched, bankNo, open, parties, history, companyId);
    const usedEntries = new Set(Array.from(matched.values()).flat().map(e => e.entryNo));
    const freeEntries = entries.filter(e => !usedEntries.has(e.entryNo));

    const results: MovementResult[] = movements.map(m => {
      const es = matched.get(m.idx);
      if (es) return { ...m, status: 'posted', matched: es.map(e => ({ docNo: e.docNo, date: e.date, description: e.description, balType: e.balType, balNo: e.balNo, amount: e.amount })), suggestion: null };
      const b = batched.get(m.idx);
      if (b) return { ...m, status: 'batch', matched: [{ docNo: b.docNo, date: b.date, description: b.description, balType: '', balNo: '', amount: b.bankAmount }], suggestion: null };
      const s = suggestions.get(m.idx) || null;
      // Movimientos de banco sin cuadrar de la misma cuenta y fechas cercanas: puede que ya esté registrado con otro importe
      const accounts = new Set(s?.lines.map(l => l.accountNo).filter(Boolean));
      const near = freeEntries.filter(e => accounts.has(e.balNo) && Math.abs(Date.parse(e.date) - Date.parse(m.date)) <= 7 * 86400000);
      if (s && near.length) {
        s.note = [s.note, `¿Ya registrado? ${near.map(e => `${e.docNo} ${e.date.split('-').reverse().join('.')} ${e.amount.toFixed(2)}`).join(', ')} sin cuadrar con esta cuenta`].filter(Boolean).join(' · ');
      }
      return { ...m, status: 'new', matched: [], suggestion: s, doubtful: near.length > 0 };
    });

    const bank = await bcFetchAll(odataUrl(`${ctx.apiBase}/bankAccounts`, { $filter: `number eq '${bankNo.replace(/'/g, "''")}'`, $select: 'iban' }), ctx.token).catch(() => []);
    const bankIban = String(bank[0]?.iban || '').replace(/\s/g, '').toUpperCase();
    const fileAccount = movements[0].account;
    const warning = bankIban && fileAccount && bankIban !== fileAccount ? `El extracto es de la cuenta ${fileAccount} y la cuenta ${bankNo} de BC tiene el IBAN ${bankIban}.` : '';

    return NextResponse.json({
      bankNo, journalCode: journal?.code || '', from, warning, entries: entries.length, movements: results,
      held: held.map(m => ({ date: m.date, valueDate: m.valueDate, name: m.name, purpose: m.purpose, amount: m.amount })),
    });
  } catch (error: any) {
    console.error('BANCO análisis:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
