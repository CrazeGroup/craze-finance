import type { Metadata } from "next";
import { Inter } from 'next/font/google';
import "./globals.css";
import Sidebar from '@/components/Sidebar';
import { getSession, AUTH_ENABLED } from '@/lib/auth';
import { CompanyProvider } from '@/contexts/CompanyContext';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Craze Finanzas',
  description: 'Gestión y optimización financiera para Craze',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getSession();
  const permissions = session?.permissions ? JSON.parse(session.permissions) : [];
  const username = session?.username || '';

  return (
    <html lang="es">
      <body className={`${inter.className} flex h-screen bg-slate-50 text-slate-900 overflow-hidden`}>
        <CompanyProvider>
          {/* Sidebar */}
          <Sidebar permissions={permissions} username={username} authEnabled={AUTH_ENABLED} />

          {/* Main Content */}
          <main className="flex-1 overflow-auto bg-transparent">
            {children}
          </main>
        </CompanyProvider>
      </body>
    </html>
  );
}
