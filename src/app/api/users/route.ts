import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { logAction } from '@/lib/logger';
import bcrypt from 'bcryptjs';

// Get all users
export async function GET(req: Request) {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        permissions: true,
        createdAt: true,
        passwordHash: true,
      }
    });
    
    // Sin contraseña = solo puede entrar con Microsoft
    return NextResponse.json(users.map(({ passwordHash, ...u }) => ({ ...u, hasPassword: !!passwordHash })));
  } catch (error) {
    console.error('Error fetching users:', error);
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
  }
}

// Create a new user
export async function POST(req: Request) {
  try {
    const { username, password, permissions } = await req.json();

    // La contraseña es opcional: sin ella el usuario solo entra con Microsoft (su username es el correo)
    if (!username) {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }

    const existingUser = await prisma.user.findUnique({
      where: { username }
    });

    if (existingUser) {
      return NextResponse.json({ error: 'Username already exists' }, { status: 400 });
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : '';
    const permissionsString = JSON.stringify(permissions || []);

    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        permissions: permissionsString,
      },
      select: {
        id: true,
        username: true,
        permissions: true,
      }
    });

    await logAction('Crear Usuario', `Usuario: ${username}`);
    return NextResponse.json(user);
  } catch (error) {
    console.error('Error creating user:', error);
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
  }
}
