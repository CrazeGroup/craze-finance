import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAccessToken } from '@/lib/bcSync';
import { bcFetchAll, getBcContext, odataUrl } from '@/lib/bcClient';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Diagnóstico temporal de Commercial Analysis: empresas de BC y filas de ejemplo de cada fuente
export async function GET(req: Request) {
  const company = new URL(req.url).searchParams.get('company') || 'CRAZE';
  const config = await prisma.businessCentralConfig.findUnique({ where: { id: 1 } });
  const token = await getAccessToken(config!.tenantId!, config!.clientId!, config!.clientSecret!);
  const root = `https://api.businesscentral.dynamics.com/v2.0/${config!.tenantId}/${config!.environment}`;
  const companies = ((await (await fetch(`${root}/api/v2.0/companies`, { headers: { Authorization: `Bearer ${token}` } })).json()).value || []).map((c: any) => c.name);
  const ctx = await getBcContext(company);
  const sample = async (name: string, url: string) => {
    try { const rows = await bcFetchAll(url, ctx.token); return [name, { n: rows.length, rows: rows.slice(0, 2) }]; }
    catch (e: any) { return [name, { error: String(e.message).substring(0, 200) }]; }
  };
  const y = new Date().getFullYear();
  const out = Object.fromEntries(await Promise.all([
    sample('lm', odataUrl(`${ctx.customApiBase}/documentsLMComponents`, { $filter: `postingDate ge ${y}-09-01 and postingDate le ${y}-09-03`, $top: '3' })),
    sample('salesLines', odataUrl(`${ctx.odataCompanyBase}/Sales_Lines_Excel`, { $top: '3', $filter: `Document_Type ne 'Invoice'` })),
    sample('budgetItems', odataUrl(`${ctx.customApiBase}/budgetItems`, { $top: '2' })),
    sample('budgetUnits', odataUrl(`${ctx.customApiBase}/budgetUnits`, { $top: '2' })),
    sample('forecastItems', odataUrl(`${ctx.customApiBase}/forecastItems`, { $top: '2' })),
    sample('sellOuts', odataUrl(`${ctx.odataCompanyBase}/SellOuts_CRZ`, { $top: '2' })),
    sample('sellInB2C', odataUrl(`${ctx.odataCompanyBase}/SellIn_B2C`, { $top: '2' })),
  ]));
  return NextResponse.json({ companies, company: ctx.companyName, ...out });
}
