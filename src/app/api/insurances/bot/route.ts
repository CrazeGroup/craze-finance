import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { aiConfigured, AI_NOT_CONFIGURED, generateText } from '@/lib/ai';

export const maxDuration = 60; // Allow 60s for OpenAI

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    
    const { message } = await req.json();

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    if (!aiConfigured()) {
      return NextResponse.json({ error: AI_NOT_CONFIGURED }, { status: 500 });
    }

    const whereClause = companyId === 'ALL' ? {} : { companyId };
    
    // Fetch all insurances for this company to provide context
    const policies = await prisma.insurancePolicy.findMany({
      where: whereClause,
    });

    if (policies.length === 0) {
      return NextResponse.json({ 
        reply: "No tienes ninguna póliza de seguro registrada para esta empresa, por lo que no puedo consultar incidencias." 
      });
    }

    // Build Context
    const parts: any[] = [];
    let contextText = `Eres un asistente inteligente especializado en seguros de la empresa ${policies.length > 0 ? policies[0].companyId : 'CRAZE'}.
A continuación se adjuntan los documentos PDF de las pólizas activas de esta empresa, así como sus datos básicos.
Utiliza esta información para responder a la pregunta del usuario.

DATOS BÁSICOS DE LAS PÓLIZAS:
`;

    let index = 0;
    for (const policy of policies) {
      let attachmentsList = [];
      let hasLegacyFile = policy.fileBase64 && policy.fileName?.toLowerCase().endsWith('.pdf');
      
      let parsedAttachments: any[] = [];
      if (policy.attachments && typeof policy.attachments === 'string') {
        try { parsedAttachments = JSON.parse(policy.attachments); } catch(e){}
      } else if (Array.isArray(policy.attachments)) {
        parsedAttachments = policy.attachments;
      }

      if (hasLegacyFile) attachmentsList.push(policy.fileName);
      parsedAttachments.forEach(att => attachmentsList.push(att.fileName));

      contextText += `\n--- PÓLIZA ${index + 1} ---
Nombre: ${policy.description}
Válida desde: ${policy.startDate.toLocaleDateString()} hasta ${policy.endDate.toLocaleDateString()}
Archivos adjuntos: ${attachmentsList.length > 0 ? attachmentsList.join(', ') : 'NO HAY DOCUMENTOS ADJUNTOS'}
`;
      
      // Attach legacy PDF
      if (hasLegacyFile) {
        parts.push({
          inlineData: {
            data: policy.fileBase64!.split(',')[1] || policy.fileBase64!,
            mimeType: 'application/pdf'
          }
        });
      }
      
      // Attach new main fileUrl
      if (policy.fileUrl && policy.fileName?.toLowerCase().endsWith('.pdf')) {
        try {
          const fileRes = await fetch(policy.fileUrl);
          if (fileRes.ok) {
            const arrayBuffer = await fileRes.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');
            parts.push({ inlineData: { data: base64, mimeType: 'application/pdf' } });
          }
        } catch (e) {
          console.error('Error fetching fileUrl:', policy.fileUrl, e);
        }
      }

      // Attach all new attachments
      for (const att of parsedAttachments) {
        if (att.fileName?.toLowerCase().endsWith('.pdf')) {
          const base64Data = att.fileData || att.fileBase64;
          if (base64Data) {
            parts.push({
              inlineData: {
                data: base64Data.split(',')[1] || base64Data,
                mimeType: 'application/pdf'
              }
            });
          } else if (att.fileUrl) {
            try {
              const fileRes = await fetch(att.fileUrl);
              if (fileRes.ok) {
                const arrayBuffer = await fileRes.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                parts.push({ inlineData: { data: base64, mimeType: 'application/pdf' } });
              }
            } catch (e) {
              console.error('Error fetching fileUrl:', att.fileUrl, e);
            }
          }
        }
      }
      
      index++;
    }

    contextText += `\nPREGUNTA DEL USUARIO: ${message}`;
    
    // The prompt text goes first
    parts.unshift(contextText);

    const reply = await generateText(parts);

    return NextResponse.json({ reply });

  } catch (error: any) {
    console.error('Error in Insurance Bot:', error);
    return NextResponse.json({ error: error.message || 'Error interno del bot de seguros' }, { status: 500 });
  }
}
