import { NextResponse } from 'next/server';
import { aiConfigured, AI_NOT_CONFIGURED, generateText } from '@/lib/ai';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow more time for PDF processing

export async function POST(req: Request) {
  try {
    if (!aiConfigured()) {
      return NextResponse.json({ error: AI_NOT_CONFIGURED }, { status: 500 });
    }

    const { attachments } = await req.json();

    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
      return NextResponse.json({ error: 'No se encontraron archivos válidos.' }, { status: 400 });
    }

    const prompt = `
Extrae la siguiente información de este contrato de cliente y sus anexos adjuntos:
1. El nombre del cliente o empresa contratante (clientName).
2. Una descripción corta o nombre del contrato (ej: "Contrato de Prestación de Servicios").
3. La fecha de inicio del contrato en formato YYYY-MM-DD.
4. La fecha de fin o vencimiento del contrato en formato YYYY-MM-DD.

Devuelve SOLO un objeto JSON válido con esta estructura exacta y nada más:
{
  "clientName": "string",
  "description": "string",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD"
}
Si alguna fecha no aparece, intenta deducirla o déjala en blanco.
`;

    const parts: any[] = [prompt];
    
    for (const att of attachments) {
      if (att.fileName?.toLowerCase().endsWith('.pdf')) {
        let base64Data = "";
        if (att.fileData) {
          base64Data = att.fileData.split(',')[1] || att.fileData;
        } else if (att.fileUrl) {
          const fileRes = await fetch(att.fileUrl);
          const arrayBuffer = await fileRes.arrayBuffer();
          base64Data = Buffer.from(arrayBuffer).toString('base64');
        } else if (att.fileBase64) {
          base64Data = att.fileBase64.split(',')[1] || att.fileBase64;
        } else {
          continue;
        }

        parts.push({
          inlineData: {
            data: base64Data,
            mimeType: 'application/pdf'
          }
        });
      }
    }

    let responseText = await generateText(parts, { json: true });
    // Clean up potential markdown formatting
    responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    responseText = responseText.match(/\{[\s\S]*\}/)?.[0] ?? responseText;
    
    const parsedData = JSON.parse(responseText);
    
    return NextResponse.json(parsedData);
  } catch (error: any) {
    console.error('Error extrañendo datos del PDF:', error);
    return NextResponse.json({ error: error.message || 'Error al procesar el PDF' }, { status: 500 });
  }
}
