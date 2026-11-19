import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Needs to be awaited in Next 15
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    
    // We only fetch this when downloading the file
    const policy = await prisma.customerContract.findUnique({
      where: { id: parseInt(id) },
      select: { fileName: true, fileUrl: true, attachments: true }
    });

    if (!policy) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return NextResponse.json(policy);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch policy' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const cookieStore = await cookies();
    const companyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    
    const policy = await prisma.customerContract.delete({
      where: { id: parseInt(id) }
    });

    await logAction('Contract deleted', `Contract deleted: ${policy.description}`, companyId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete policy' }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const cookieStore = await cookies();
    const defaultCompanyId = cookieStore.get('craze_selected_company')?.value || 'CRAZE';
    
    const body = await req.json();
    let { companyId = defaultCompanyId, description, startDate, endDate, fileName, fileBase64, fileUrl, attachments } = body;

    if (!fileName && attachments && attachments.length > 0) {
      fileName = attachments[0].fileName;
    }

    if (!description || !startDate || !endDate) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const updateData: any = {
      companyId,
      description,
      startDate: new Date(startDate),
      endDate: new Date(endDate)
    };

    // We no longer save base64 files in the DB
    
    if (fileUrl && fileName) {
      updateData.fileName = fileName;
      updateData.fileUrl = fileUrl;
    }
    
    // Always update attachments if provided
    if (attachments !== undefined) {
      updateData.attachments = attachments;
    }

    const policy = await prisma.customerContract.update({
      where: { id: parseInt(id) },
      data: updateData
    });

    await logAction('Contract updated', `Contract updated/renewed: ${policy.description}`, companyId);

    return NextResponse.json({
      id: policy.id,
      description: policy.description,
      startDate: policy.startDate,
      endDate: policy.endDate,
      fileName: policy.fileName
    });
  } catch (error: any) {
    console.error('Error updating contract:', error);
    return NextResponse.json({ error: 'Failed to update contract' }, { status: 500 });
  }
}
