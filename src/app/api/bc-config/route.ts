import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

const SECRET_MASK = '********';

// Never send the client secret to the browser
function maskSecret(config: any) {
  return config ? { ...config, clientSecret: config.clientSecret ? SECRET_MASK : '' } : {};
}

export async function GET() {
  try {
    const config = await prisma.businessCentralConfig.findUnique({
      where: { id: 1 }
    });
    return NextResponse.json(maskSecret(config));
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const data = await request.json();
    // The form sends the mask back unchanged when the secret wasn't edited: keep the stored one
    const keepSecret = data.clientSecret === SECRET_MASK;
    const config = await prisma.businessCentralConfig.upsert({
      where: { id: 1 },
      update: {
        tenantId: data.tenantId || '',
        clientId: data.clientId || '',
        ...(keepSecret ? {} : { clientSecret: data.clientSecret || '' }),
        environment: data.environment || 'Production',
        companyId: data.companyId || ''
      },
      create: {
        id: 1,
        tenantId: data.tenantId || '',
        clientId: data.clientId || '',
        clientSecret: data.clientSecret || '',
        environment: data.environment || 'Production',
        companyId: data.companyId || ''
      }
    });
    return NextResponse.json({ success: true, config: maskSecret(config) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
