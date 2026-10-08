import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { companyCurrency } from '@/lib/royalties';

// Payment Proposal: movimientos de proveedor (API custom vendorLedgerEntries) con los filtros fijos de la propuesta
// de pagos de BC: abiertos, No Payment = No, forma de pago TRANSFER y sin proveedores del grupo (CRAZE…),
// con vencimiento entre `from` y `to`. Aprobado para pago = % Payment Approval ≥ 100.

export const PAYMENT_METHOD = 'TRANSFER';
export const APPROVED_PCT = 100;

export type ProposalEntry = {
  entryNo: number; vendorNo: string; vendorName: string; docType: string; docNo: string; extDocNo: string;
  description: string; postingDate: string; dueDate: string;
  remaining: number; remainingLCY: number | null; currency: string;
  approvalPct: number; approvedUsers: string; pendingUsers: string;
};

const pick = (r: any, keys: string[]) => keys.map(k => r[k]).find(v => v !== undefined && v !== null);
const str = (v: any) => (v == null ? '' : String(v).trim());
const num = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const isTrue = (v: any) => v === true || v === 'true' || v === 'Yes' || v === 1;
const users = (v: any) => str(v).split('|').map(u => u.trim()).filter(Boolean);
const joinUsers = (list: string[]) => Array.from(new Set(list)).sort().join('|');
const realDate = (d: any) => { const s = str(d).substring(0, 10); return s && !s.startsWith('0001') ? s : ''; };

export async function paymentProposal(ctx: BcContext, company: string, from: string, to: string) {
  const rows = await bcFetchAll(odataUrl(`${ctx.customApiBase}/vendorLedgerEntries`, {
    $filter: `open eq true and paymentMethodCode eq '${PAYMENT_METHOD}' and dueDate ge ${from} and dueDate le ${to}`,
  }), ctx.token);
  const lcy = companyCurrency(company);
  const sample = rows[0] || {};
  const has = (keys: string[]) => keys.some(k => k in sample);
  const fields = {
    pendingUsers: has(['pendingUsersBCT', 'pendingUsers']),
    approvalUsers: has(['approvalUsersBCT', 'approvalUsers']),
    currency: has(['currencyCode']),
    remainingLCY: has(['remainingAmtLCY', 'remainingAmountLCY', 'remainingAmtLcy']),
  };

  const entries: ProposalEntry[] = rows
    .filter(r => !isTrue(pick(r, ['noPaymentBCT', 'noPayment'])) && str(r.onHold) !== 'NO PAGAR')
    .filter(r => !/^craze/i.test(str(r.vendorName)))
    .map(r => {
      const approved = users(pick(r, ['approvedUsersBCT', 'approvedUsers']));
      const pendingRaw = pick(r, ['pendingUsersBCT', 'pendingUsers']);
      // Sin campo de pendientes: los aprobadores que aún no han aprobado
      const pending = pendingRaw !== undefined
        ? users(pendingRaw)
        : users(pick(r, ['approvalUsersBCT', 'approvalUsers'])).filter(u => !approved.includes(u));
      const currency = str(r.currencyCode) || lcy;
      const remaining = num(r.remainingAmount);
      const lcyRaw = pick(r, ['remainingAmtLCY', 'remainingAmountLCY', 'remainingAmtLcy']);
      return {
        entryNo: num(r.entryNo), vendorNo: str(r.vendorNo), vendorName: str(r.vendorName),
        docType: str(r.documentType), docNo: str(r.documentNo), extDocNo: str(r.externalDocumentNo),
        description: str(r.description), postingDate: realDate(r.postingDate), dueDate: realDate(r.dueDate),
        remaining,
        remainingLCY: lcyRaw !== undefined ? num(lcyRaw) : currency === lcy ? remaining : null,
        currency,
        approvalPct: num(pick(r, ['paymentApprovalCRZ', 'percentagePaymentApproval'])),
        approvedUsers: joinUsers(approved),
        pendingUsers: joinUsers(pending),
      };
    })
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName) || a.dueDate.localeCompare(b.dueDate));

  return { company, from, to, lcy, fields, entries };
}
