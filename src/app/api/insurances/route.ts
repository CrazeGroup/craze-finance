import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const companyId = searchParams.get('companyId');
    const cookieStore = await cookies();
    const defaultCompany = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    const targetCompany = companyId || defaultCompany;

    const whereClause = targetCompany === 'ALL' ? {} : { companyId: targetCompany };

    // Do not return the massive base64 file data or extracted text to the client list view
    const policies = await prisma.insurancePolicy.findMany({
      where: whereClause,
      orderBy: { endDate: 'asc' },
      select: {
        id: true,
        companyId: true,
        description: true,
        startDate: true,
        endDate: true,
        fileName: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return NextResponse.json(policies);
  } catch (error: any) {
    console.error('Error fetching insurances:', error);
    return NextResponse.json({ error: 'Failed to fetch insurances' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const defaultCompany = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    
    const body = await req.json();
    let { companyId = defaultCompany, description, startDate, endDate, fileName, fileBase64, fileUrl, attachments } = body;

    // If fileName is empty but we have attachments, use the first attachment's name so the UI knows there is a file
    if (!fileName && attachments && attachments.length > 0) {
      fileName = attachments[0].fileName;
    }

    if (!description || !startDate || !endDate) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    let extractedText = '';

    const policy = await prisma.insurancePolicy.create({
      data: {
        companyId,
        description,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        fileName,
        fileBase64,
        fileUrl,
        extractedText,
        attachments: attachments || []
      }
    });

    await logAction('Insurance policy added', `Insurance: ${description}`, companyId);

    // Return the policy without the heavy base64 strings
    return NextResponse.json({
      id: policy.id,
      description: policy.description,
      startDate: policy.startDate,
      endDate: policy.endDate,
      fileName: policy.fileName
    });
  } catch (error: any) {
    console.error('Error creating insurance:', error);
    return NextResponse.json({ error: 'Failed to create insurance' }, { status: 500 });
  }
}
