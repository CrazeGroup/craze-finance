'use client';

import type { Worker } from 'tesseract.js';

// OCR en el navegador (Tesseract, sin IA ni coste) para los PDFs sin texto: capturas de pantalla (recibos de Uber) y
// escaneos. Cada página se pinta a ~2000 px de ancho y se lee en alemán, inglés y español. El worker (unos MB con los
// idiomas) se carga la primera vez y se reutiliza
const MAX_PAGES = 3;
let worker: Promise<Worker> | null = null;
const getWorker = () => (worker ??= import('tesseract.js').then(t => t.createWorker(['deu', 'eng', 'spa'])));

async function pages(file: File) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
  const out: HTMLCanvasElement[] = [];
  for (let p = 1; p <= Math.min(pdf.numPages, MAX_PAGES); p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, 2000 / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    out.push(canvas);
  }
  return out;
}

export async function ocrPdf(file: File) {
  const w = await getWorker();
  const texts: string[] = [];
  for (const canvas of await pages(file)) texts.push((await w.recognize(canvas)).data.text);
  return texts.join('\n');
}
