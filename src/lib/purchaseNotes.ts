import prisma from '@/lib/prisma';
import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { cached, readSetting } from '@/lib/reporting/cache';

// Notas de facturas/abonos de compra: las "Notes" del FactBox de BC son Record Links de tipo Note (tabla 2000000068,
// texto en un BLOB). No están en la API estándar ni en OData: se leen de la API custom (entidad recordLinks, o la que
// fije la setting purchaseNotesEntity). Solo cuentan las de facturas/abonos de compra: Purchase Header (38, tipo
// Invoice/Credit Memo), Purch. Inv. Header (122) y Purch. Cr. Memo Hdr. (124).
// Qué notas se han leído lo guarda la app en ApiConfig notes:read:<empresa> ({ linkId: { by, at } }).

export type PurchaseNote = {
  linkId: string; tableNo: number; docType: 'invoice' | 'credit'; posted: boolean;
  documentNo: string; vendorNo: string; vendorName: string;
  created: string; userId: string; toUserId: string; text: string;
  read?: { by: string; at: string } | null;
};
export class NotesNotPublished extends Error {}

const s = (v: any) => (v == null ? '' : String(v).trim());
const pick = (r: any, ...keys: string[]) => { for (const k of keys) if (r[k] != null && r[k] !== '') return r[k]; return ''; };

// "Purch. Inv. Header: CRZ-PI26-05637" / "Purchase Header: Invoice,CRZ-PI26-00012"
function fromRecordId(recordId: string) {
  const [table, keys = ''] = recordId.split(/:\s*/, 2);
  const parts = keys.split(',').map(x => x.trim());
  return { table: table.toLowerCase(), docTypeKey: parts.length > 1 ? parts[0] : '', no: parts[parts.length - 1] || '' };
}

function classify(tableNo: number, recordId: string, docTypeField: string): Pick<PurchaseNote, 'docType' | 'posted'> | null {
  const r = fromRecordId(recordId);
  const t = tableNo || (/purch\. inv\. header/.test(r.table) ? 122 : /purch\. cr\. memo hdr/.test(r.table) ? 124 : /^purchase header$/.test(r.table) ? 38 : 0);
  if (t === 122) return { docType: 'invoice', posted: true };
  if (t === 124) return { docType: 'credit', posted: true };
  if (t === 38) {
    const type = (docTypeField || r.docTypeKey).toLowerCase();
    if (/credit/.test(type)) return { docType: 'credit', posted: false };
    if (/invoice/.test(type)) return { docType: 'invoice', posted: false };
  }
  return null;
}

async function fetchNotes(ctx: BcContext): Promise<PurchaseNote[]> {
  const entity = await readSetting('purchaseNotesEntity', 'recordLinks');
  let rows: any[];
  try {
    rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/${entity}`, {}), ctx.token);
  } catch (e: any) {
    if (/404|not found|BadRequest_ResourceNotFound|No HTTP resource/i.test(e.message || '')) {
      throw new NotesNotPublished(`La API custom de BC no publica la entidad "${entity}" (Record Links / Notes).`);
    }
    throw e;
  }
  const out: PurchaseNote[] = [];
  for (const r of rows) {
    const type = s(pick(r, 'type', 'linkType'));
    if (type && !/note/i.test(type)) continue;
    const recordId = s(pick(r, 'recordIdText', 'recordId', 'recordID'));
    const kind = classify(Number(pick(r, 'tableNo', 'tableId')) || 0, recordId, s(pick(r, 'documentType')));
    if (!kind) continue;
    const company = s(r.company);
    if (company && company.toLowerCase() !== ctx.companyName.toLowerCase()) continue;
    out.push({
      linkId: s(pick(r, 'linkId', 'linkID', 'id')), tableNo: Number(pick(r, 'tableNo', 'tableId')) || 0, ...kind,
      documentNo: s(pick(r, 'documentNo', 'no')) || fromRecordId(recordId).no,
      vendorNo: s(pick(r, 'vendorNo', 'buyFromVendorNo')), vendorName: s(pick(r, 'vendorName', 'buyFromVendorName')),
      created: s(pick(r, 'created', 'createdAt')), userId: s(pick(r, 'userId', 'createdBy')), toUserId: s(pick(r, 'toUserId')),
      text: s(pick(r, 'noteText', 'note', 'description')),
    });
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

const readKey = (company: string) => `notes:read:${company}`;
type ReadMap = Record<string, { by: string; at: string }>;

export async function readMap(company: string): Promise<ReadMap> {
  const row = await prisma.apiConfig.findUnique({ where: { key: readKey(company) } });
  try { return JSON.parse(row?.config || '{}'); } catch { return {}; }
}

export async function setRead(company: string, linkIds: string[], read: boolean, by: string) {
  const map = await readMap(company);
  const at = new Date().toISOString();
  for (const id of linkIds) { if (read) map[id] = { by, at }; else delete map[id]; }
  const config = JSON.stringify(map);
  await prisma.apiConfig.upsert({ where: { key: readKey(company) }, update: { config }, create: { key: readKey(company), url: '', config } });
}

// Notas (guardadas 10 min; force = leer BC ahora) con su estado de lectura
export async function purchaseNotes(ctx: BcContext, force = false) {
  const notes = await cached(`notes:purchase:${ctx.companyName}`, 10 * 60 * 1000, () => fetchNotes(ctx), force);
  const read = await readMap(ctx.companyName);
  return notes.map(n => ({ ...n, read: read[n.linkId] || null }));
}
