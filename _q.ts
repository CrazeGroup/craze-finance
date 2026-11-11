import { getBcContext, bcFetchAll, odataUrl } from './src/lib/bcClient';
(async () => {
  const ctx = await getBcContext('Craze Iberia SL');
  const rows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/Bank_Account_Ledger_Entries_Excel`, { $filter: `Posting_Date ge 2026-09-01`, $select: 'Entry_No,Bank_Account_No,Posting_Date,Document_No,Description,Amount,Bal_Account_Type,Bal_Account_No,Reversed' }), ctx.token);
  console.log(rows.length); for (const r of rows.slice(0, 80)) console.log(r.Bank_Account_No, r.Posting_Date, r.Document_No, r.Description, r.Amount, r.Bal_Account_Type, r.Bal_Account_No, r.Reversed);
})().catch(e => console.error('ERR', e.message));
