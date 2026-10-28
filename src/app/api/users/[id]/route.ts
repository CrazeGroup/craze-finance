import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';
import bcrypt from 'bcryptjs';

// Update user
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const userId = parseInt(id);
    const { username, password, permissions, ssoOnly } = await req.json();

    const updateData: any = {};
    if (username) updateData.username = username;
    if (password) updateData.passwordHash = await bcrypt.hash(password, 10);
    else if (ssoOnly) updateData.passwordHash = ''; // quitar la contraseña: solo Microsoft
    if (permissions) updateData.permissions = JSON.stringify(permissions);

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        username: true,
        permissions: true,
      }
    });

    await logAction('Editar Usuario', `Usuario: ${user.username}`);
    return NextResponse.json(user);
  } catch (error) {
    console.error('Error updating user:', error);
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

// Delete user
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const userId = parseInt(id);

    // Prevent deleting the main admin (id 1) just in case
    if (userId === 1) {
      return NextResponse.json({ error: 'Cannot delete the primary admin' }, { status: 400 });
    }

    const user = await prisma.user.delete({
      where: { id: userId },
    });

    await logAction('Eliminar Usuario', `Usuario eliminado con ID: ${userId} (${user.username})`);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting user:', error);
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
