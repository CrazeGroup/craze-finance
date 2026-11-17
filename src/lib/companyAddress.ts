import { getBcContext, bcFetchAll } from './bcClient';
import { cached, HOUR } from './reporting/cache';

// Razón social y dirección fiscal de la empresa, de BC (v2 companyInformation), para el PDF y la firma de los
// recordatorios. Caché 24 h; si BC falla, null (se usan los datos fijos de reportBuilder).
const COUNTRY: Record<string, string> = { DE: 'Germany', GB: 'United Kingdom', CH: 'Switzerland', ES: 'Spain' };
export type CompanyAddress = { name: string; line1: string; line2: string; postalCode: string; city: string; country: string; vat: string };

export async function companyAddress(company: string): Promise<CompanyAddress | null> {
  try {
    return await cached(`companyAddress:${company}`, 24 * HOUR, async () => {
      const ctx = await getBcContext(company);
      const [r] = await bcFetchAll(`${ctx.apiBase}/companyInformation`, ctx.token);
      if (!r) throw new Error('sin companyInformation');
      const s = (v: any) => String(v ?? '').trim();
      return {
        name: s(r.displayName), line1: s(r.addressLine1), line2: s(r.addressLine2),
        postalCode: s(r.postalCode).replace(/[^\w -]/g, ''), city: s(r.city),
        country: COUNTRY[s(r.country)] || s(r.country), vat: s(r.taxRegistrationNumber),
      };
    });
  } catch {
    return null;
  }
}

export const addressLines = (a: CompanyAddress) => [[a.line1, a.line2].filter(Boolean).join(', '), `${a.postalCode} ${a.city}`.trim(), a.country].filter(Boolean);
