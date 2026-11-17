// PDF del recordatorio (cliente): el HTML de /api/preview-report convertido con html2pdf dentro de un iframe aislado
// (html2canvas no entiende el CSS de Tailwind 4). Devuelve un data URI. Solo en el navegador.
export function previewReportUrl(customerId: number, invoiceIds: number[], message: string) {
  return `/api/preview-report?customerId=${customerId}&invoices=${invoiceIds.join(',')}&message=${encodeURIComponent(message)}`;
}

export async function buildReminderPdf(customerId: number, invoiceIds: number[], message: string): Promise<string> {
  const html = await (await fetch(previewReportUrl(customerId, invoiceIds, message))).text();
  const iframe = document.createElement('iframe');
  Object.assign(iframe.style, { position: 'absolute', width: '800px', height: '1000px', left: '-9999px' });
  document.body.appendChild(iframe);
  try {
    return await new Promise<string>((resolve, reject) => {
      iframe.onload = async () => {
        try {
          const win = iframe.contentWindow as any;
          for (let i = 0; i < 20 && !win.html2pdf; i++) await new Promise(r => setTimeout(r, 250));
          resolve(await win.html2pdf().set({
            margin: 10, filename: 'Overdue_Invoices.pdf', image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          }).from(win.document.getElementById('pdf-content')).outputPdf('datauristring'));
        } catch (err) { reject(err); }
      };
      const doc = iframe.contentDocument!;
      doc.open();
      doc.write(`<!DOCTYPE html><html><head><script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script></head><body><div id="pdf-content">${html}</div></body></html>`);
      doc.close();
    });
  } finally {
    iframe.remove();
  }
}
