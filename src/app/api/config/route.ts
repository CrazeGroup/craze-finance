import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export async function GET() {
  try {
    // Los Excels del Reporting también se guardan en ApiConfig: no se devuelven aquí
    const configs = await prisma.apiConfig.findMany({ where: { NOT: { key: { startsWith: 'reporting:' } } } });
    return NextResponse.json(configs);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch configs' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const data = await request.json();
    
    if (!data.key || !data.url) {
      return NextResponse.json({ error: 'Key and URL are required' }, { status: 400 });
    }

    const config = await prisma.apiConfig.upsert({
      where: { key: data.key },
      update: { url: data.url, config: data.config || null },
      create: { key: data.key, url: data.url, config: data.config || null },
    });

    return NextResponse.json(config);
  } catch (error: any) {
    console.error('Error in POST /api/config', error);
    return NextResponse.json({ error: 'Failed to save config', details: error.message }, { status: 500 });
  }
}
