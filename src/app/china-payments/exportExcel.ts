// Excel de China Payments como el Excel de pivots del usuario: hoja "Summary" con los pagos programados por fecha
// y la tabla proveedor → pago → facturas agrupada con esquema (+/− de Excel; las facturas salen plegadas),
// y una hoja "Invoices" con todas las líneas. exceljs se carga sólo al exportar.

type Entry = {
  vendorNo: string; vendorName: string; documentType: string; documentNo: string; externalDocumentNo: string;
  postingDate: string; dueDate: string; currencyCode: string; remainingAmount: number; remainingAmtLCY: number;
};
type Vendor = { vendorNo: string; name: string; total: number; payments: { date: string; list: Entry[]; total: number }[] };

const EUR_FMT = '#,##0.00 [$€-de-DE];[Red]-#,##0.00 [$€-de-DE]';
const NUM_FMT = '#,##0.00;[Red]-#,##0.00';
const DATE_FMT = 'dd/mm/yyyy';
const toDate = (d: string) => (d ? new Date(`${d}T00:00:00Z`) : null);

export async function buildChinaPaymentsXlsx(opts: {
  vendors: Vendor[]; byDate: [string, number][]; grandTotal: number; company: string; companyLabel: string; today: string;
  t: (s: string, p?: Record<string, any>) => string;
}) {
  const { vendors, byDate, grandTotal, company, companyLabel, today, t } = opts;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const tbc = t('To be confirmed');
  const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
  const thin = { style: 'thin' as const, color: { argb: 'FFD1D5DB' } };

  // ---- Summary ----
  const ws = wb.addWorksheet('Summary', {
    properties: { outlineLevelRow: 2, outlineProperties: { summaryBelow: false, summaryRight: false } } as any,
    views: [{ showGridLines: false }],
  });
  ws.columns = [{ width: 44 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 18 }, { width: 18 }];

  ws.addRow([t('China Payments') + ` – ${companyLabel}`]).font = { bold: true, size: 14 };
  ws.addRow([t('Payment forecast to China vendors (CHINA TRF)') + ` · ${new Date(`${today}T00:00:00`).toLocaleDateString('en-GB')}`]).font = { italic: true, color: { argb: 'FF6B7280' } };
  ws.addRow([]);

  // Pagos programados (todas las proveedores), como las tarjetas de la página
  const h1 = ws.addRow([t('Scheduled payments'), t('Amount (EUR)'), t('Invoices')]);
  h1.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  [1, 2, 3].forEach(c => { h1.getCell(c).fill = fill('FF4F46E5'); });
  h1.getCell(2).alignment = { horizontal: 'right' }; h1.getCell(3).alignment = { horizontal: 'right' };
  const countByDate = new Map<string, number>();
  for (const v of vendors) for (const p of v.payments) countByDate.set(p.date, (countByDate.get(p.date) || 0) + p.list.length);
  for (const [d, total] of byDate) {
    const r = ws.addRow([d ? toDate(d) : tbc, total, countByDate.get(d) || 0]);
    r.getCell(1).numFmt = DATE_FMT; r.getCell(1).alignment = { horizontal: 'left' };
    r.getCell(2).numFmt = EUR_FMT;
    [1, 2, 3].forEach(c => { r.getCell(c).border = { bottom: thin }; });
  }
  const g1 = ws.addRow([t('Grand total'), grandTotal, vendors.reduce((s, v) => s + v.payments.reduce((a, p) => a + p.list.length, 0), 0)]);
  g1.font = { bold: true }; g1.getCell(2).numFmt = EUR_FMT;
  [1, 2, 3].forEach(c => { g1.getCell(c).fill = fill('FFF3F4F6'); });

  ws.addRow([]); ws.addRow([]);

  // Proveedor → pago → facturas (esquema de filas: nivel 1 = pagos, nivel 2 = facturas plegadas)
  const head = ws.addRow([t('Vendor / payment / invoice'), t('Document'), t('Posting Date'), t('Due Date'), t('Currency'), t('Remaining'), t('Amount (EUR)')]);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  for (let c = 1; c <= 7; c++) head.getCell(c).fill = fill('FF4F46E5');
  [6, 7].forEach(c => { head.getCell(c).alignment = { horizontal: 'right' }; });
  const headRow = head.number;

  for (const v of vendors) {
    const vr = ws.addRow([`${v.name}  ${v.vendorNo}`, null, null, null, null, null, v.total]);
    vr.font = { bold: true }; vr.getCell(7).numFmt = EUR_FMT;
    for (let c = 1; c <= 7; c++) { vr.getCell(c).fill = fill('FFE0F2FE'); vr.getCell(c).border = { top: thin }; }
    for (const p of v.payments) {
      const pr = ws.addRow([`    ${p.date ? new Date(`${p.date}T00:00:00`).toLocaleDateString('en-GB') : tbc}  (${t('{n} invoices', { n: p.list.length })})`, null, null, null, null, null, p.total]);
      pr.outlineLevel = 1;
      // exceljs sólo marca collapsed por nivel; Excel lo quiere en la fila resumen (el pago) para mostrar "+"
      Object.defineProperty(pr, 'collapsed', { get: () => true });
      pr.font = { bold: true }; pr.getCell(7).numFmt = EUR_FMT;
      for (let c = 1; c <= 7; c++) pr.getCell(c).border = { bottom: thin };
      for (const e of p.list) {
        const ir = ws.addRow([`        ${e.externalDocumentNo || e.documentNo}`, e.documentNo, toDate(e.postingDate), toDate(e.dueDate),
          e.currencyCode || 'EUR', e.remainingAmount, e.remainingAmtLCY]);
        ir.outlineLevel = 2; ir.hidden = true;
        Object.defineProperty(ir, 'collapsed', { get: () => false });
        ir.font = { color: { argb: 'FF374151' } };
        ir.getCell(3).numFmt = DATE_FMT; ir.getCell(4).numFmt = DATE_FMT;
        ir.getCell(6).numFmt = NUM_FMT; ir.getCell(7).numFmt = EUR_FMT;
      }
    }
  }
  const gt = ws.addRow([t('Grand total'), null, null, null, null, null, grandTotal]);
  gt.font = { bold: true }; gt.getCell(7).numFmt = EUR_FMT;
  for (let c = 1; c <= 7; c++) { gt.getCell(c).fill = fill('FFF3F4F6'); gt.getCell(c).border = { top: { style: 'medium' } }; }
  ws.views = [{ state: 'frozen', ySplit: headRow, showGridLines: false } as any];

  // ---- Invoices (todas las líneas, como antes) ----
  const li = wb.addWorksheet('Invoices', { views: [{ state: 'frozen', ySplit: 1 }] });
  li.columns = [
    { header: t('Vendor'), width: 42 }, { header: t('Payment date'), width: 16 }, { header: t('Vendor Invoice No.'), width: 20 },
    { header: t('Document'), width: 18 }, { header: t('Type'), width: 12 }, { header: t('Posting Date'), width: 13 },
    { header: t('Due Date'), width: 13 }, { header: t('Currency'), width: 10 }, { header: t('Remaining'), width: 16 },
    { header: t('Remaining (EUR)'), width: 16 },
  ];
  li.getRow(1).font = { bold: true };
  for (const v of vendors) for (const p of v.payments) for (const e of p.list) {
    const r = li.addRow([`${e.vendorNo} ${e.vendorName}`, p.date ? toDate(p.date) : tbc, e.externalDocumentNo, e.documentNo, e.documentType,
      toDate(e.postingDate), toDate(e.dueDate), e.currencyCode || 'EUR', e.remainingAmount, e.remainingAmtLCY]);
    [2, 6, 7].forEach(c => { r.getCell(c).numFmt = DATE_FMT; });
    r.getCell(2).alignment = { horizontal: 'left' };
    r.getCell(9).numFmt = NUM_FMT; r.getCell(10).numFmt = NUM_FMT;
  }
  li.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 10 } };

  return wb.xlsx.writeBuffer();
}

export async function exportChinaPayments(opts: Parameters<typeof buildChinaPaymentsXlsx>[0]) {
  const buf = await buildChinaPaymentsXlsx(opts);
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = `China_payments_${opts.company}_${opts.today}.xlsx`.replace(/\s+/g, '_');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
