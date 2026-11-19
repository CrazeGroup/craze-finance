import type { Metadata } from "next";
import { Inter } from 'next/font/google';
import "./globals.css";
import Sidebar from '@/components/Sidebar';
import { getSession, AUTH_ENABLED } from '@/lib/auth';
import { CompanyProvider } from '@/contexts/CompanyContext';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { serverT } from '@/lib/i18nServer';

const inter = Inter({ subsets: ['latin'] });

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return {
    title: t('Craze Finance'),
    description: t('Financial management and optimisation for Craze'),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getSession();
  const permissions = session?.permissions ? JSON.parse(session.permissions) : [];
  const username = session?.username || '';

  return (
    <html lang="en">
      <body className={`${inter.className} flex h-screen bg-slate-50 text-slate-900 overflow-hidden`}>
        <CompanyProvider>
        <LanguageProvider>
          {/* Sidebar */}
          <Sidebar permissions={permissions} username={username} authEnabled={AUTH_ENABLED} />

          {/* Main Content */}
          <main className="flex-1 overflow-auto bg-transparent">
            {children}
          </main>
        </LanguageProvider>
        </CompanyProvider>
      </body>
    </html>
  );
}
