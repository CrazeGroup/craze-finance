# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Internal finance app for the Craze group: receivables and dunning, payables and approvals, cashflow forecasting, risk, inventory valuation, BWA reports, and insurance/contract storage. All data comes from **Microsoft Dynamics 365 Business Central (BC)**. Built with Next.js 16 App Router, React 19, Prisma 5 on PostgreSQL, and Tailwind 4. Deployed on Vercel. The UI text, route names and most comments/log messages are in **Spanish**; keep new user-facing strings in Spanish.

## Commands

```bash
npm run dev        # next dev + src/scripts/cron.ts (BC sync every 5 min) run concurrently
npm run build      # prisma generate && next build
npm run lint       # eslint (eslint-config-next)
npx prisma generate            # after editing prisma/schema.prisma
npx prisma db push             # sync schema to the DB (no migrations folder exists)
npx tsx src/scripts/<name>.ts  # run a one-off script (sync, debug, data fixes)
```

There is no test suite. The files in `src/scripts/` named `test*.ts` / `check*.ts` / `debug*.ts` are ad-hoc scripts that call BC or the DB directly. They are not tests.

Env vars: `DATABASE_URL`, `DIRECT_URL` (Postgres), `JWT_SECRET`, `GEMINI_API_KEY`, and the Vercel Blob token for uploads. BC credentials and SMTP settings are **not** env vars. They live in the DB (`BusinessCentralConfig` / `EmailConfig`, single row with `id = 1`) and are edited on `/settings`.

## Architecture

**Data flow: BC is the source of truth, Postgres is a cache with app-only fields on top.**
`src/lib/bcSync.ts` → `syncBusinessCentral(company?, step?)` pulls customers, open customer ledger entries (→ `Invoice`), vendors, open vendor ledger entries (→ `PurchaseInvoice`) and recurring purchase lines for each company. It runs from three places: the `cron.ts` loop in dev, `POST /api/sync-bc` (body `{company, step}`; the UI calls it one step at a time to stay under Vercel's 60s `maxDuration`), and scripts such as `runSync.ts`.
- It prefers the **custom BC API** `api/craze/integrations/v1.0` (salesperson, confirmed payment date and similar fields) and falls back to standard `api/v2.0` / `ODataV4` when that API isn't available. Field names differ between these sources, so the mapping code checks several candidates (`c.number || c.no`, and so on).
- Rows are upserted by `@@unique([bcId, companyId])`. Ledger entries that are no longer open in BC get `status: 'Closed'` and are not deleted. Status is computed at sync time (`Open`/`Overdue` from `dueDate`).
- Fields owned by the app (`cashflowDate`, `isArchived`, reminder counts, the approval fields on `PurchaseInvoice`, `noPayment`, `schedulePaymentDate`, and so on) must survive a re-sync. When you change the sync, don't overwrite them.

**Multi-company.** `companyId` is the BC company *name* string (`'CRAZE'`, `'Craze Iberia SL'`, …), not an ID. The UI keeps the selection in `CompanyContext` (`src/contexts/CompanyContext.tsx`), which writes both localStorage and a `craze_selected_company` cookie. API routes read that cookie (`cookies().get('craze_selected_company')`, defaulting to `'CRAZE'`) to scope their queries, so pages generally don't pass the company explicitly. `'ALL'` is a UI-only option. The company lists are hardcoded in `CompanyContext`, `bcSync.ts` and `settings/page.tsx`; keep them in sync. The sync matches on the BC company `name`, not its display name (e.g. `Craze UK` is displayed as "CRAZE Toys Ltd" in BC). Per-company letterhead/bank details live in `src/lib/reportBuilder.ts`.

**Auth.** Custom JWT (`jose`, HS256, 24h) in the `auth-token` cookie, issued by `/api/auth/login` against `User.passwordHash` (bcrypt). `src/middleware.ts` enforces module permissions on **UI routes only**. `User.permissions` is a JSON-string array (e.g. `["dashboard","cashflow","configuracion"]`), and the middleware maps routes to permission names (e.g. `/movimientos` → `movimientos_abiertos`, `/pagos` → `pagos_proveedor`). `/settings` needs `configuracion` or `admin`. API routes are not permission-checked. The middleware passes `x-user-*` headers through, and `getSession()` in `src/lib/auth.ts` reads the cookie server-side. When you add a new module page, add it to `protectedUiRoutes`/`permissionMap` and to the module list in `src/components/Sidebar.tsx`.

**Audit log.** Call `logAction(action, details?)` from `src/lib/logger.ts` in mutating API routes. It records the session user and the selected company in `ActionLog`, which is shown at `/settings/logs`.

**Pages are large client components.** Each module is a single `'use client'` `page.tsx` (cashflow is about 1.2k lines) that fetches from `/api/*` and holds its state locally. There is no shared data layer or component library beyond `Sidebar` and `CustomerCard`.

**Other integrations.**
- Dunning (`/recobros`): `reportBuilder.ts` builds the statement HTML, `/api/preview-report` renders it, the client turns it into a PDF with `html2pdf.js`, and `/api/send-email` / `/api/send-salesperson-email` send it with nodemailer using the SMTP config from the DB (falls back to Ethereal when none is set). Sent reminders are recorded in `Reminder`.
- Insurances and contracts: files are uploaded to Vercel Blob through `/api/upload` (a public route). `*/extract` routes use Gemini (`@google/generative-ai`, `gemini-flash-latest`) to pull out the dates and parties, and `*/bot` routes answer questions about the stored documents.
- Cashflow merges open invoices and purchase invoices (by `cashflowDate`/`confirmedPaymentDate`/`dueDate`), active `RecurringPayment`s, `CashflowManualEntry` rows, and per-company/currency starting balances (`CashflowConfig`).
- Payment-method codes such as `MARKANT` (factoring) change how invoices are handled in cashflow and dunning. Check recent commits before touching that logic.

**Reporting (`/reporting`).** Monthly management report (Operacional / Dirección tabs, month selector, ES/EN/DE, PDF via the browser print dialog with the print CSS in `globals.css`). It replicates a report built from BC exports and two Power BI files, but reads BC live:
- One route per block, `/api/reporting/<section>?month=YYYY-MM[&force=1]`, backed by `src/lib/reporting/*`. Heavy BC reads are cached in `ApiConfig` (`reporting:cache:*`, see `cache.ts`); `REPORTING_NO_CACHE=1` bypasses the DB for scripts.
- Inventory (`inventory.ts`): OData `ValueEntries` (a BC Query: no `$orderby`/`$apply`, fetched in parallel by `Entry_No` ranges), excluding entries without `Item_No`; matches page 80016 "Inventory Value CRZ". Value per location = location qty × item unit cost. The 2023 depreciation % per item is a fixed list (setting `depreciation2023`).
- Receivables/payables (`ledgers.ts`): custom API `custLedgerEntries` / `vendorLedgerEntries`. "Open at month end" = posted ≤ date and (open, or closed after the date); BC rejects `or` across fields, so it runs two queries. INTERGROUP is excluded from customer receivables; CHINA TRF confirmed = `scheduledPaymentDateBCT`.
- Provisions (`provisions.ts`): `General_Ledger_Entries_Excel`, `Document_No` starting with PROV on accounts with `provision = true` (custom `glAccounts`); original = first entry of the document, open = sum, only documents with open ≠ 0 (same as the Power BI).
- BWA (`bwa.ts`): custom `glEntriesUnion` + `mappingAccounts` + `bwas` (Formula lines sum other codes), GBP/CHF converted with `Currencies_Excel`, sign inverted. A company column includes its elimination entries; Intercompany = elimination entries; Consolidated = everything else.
- Cashflow (`cashflowReport.ts`) reuses `src/lib/cashflow.ts`, overdraft limit setting `overdraftLimit` (default −1 M€), 4-month horizon. Key points are generated by Gemini (`summary.ts`) from the figures the page already loaded.

**Royalties (`/royalties`).** `GET /api/royalties?from=&to=[&force=1]` → `src/lib/royalties.ts`, cached like reporting. It reads BC page/table 60000 "AIT Documents LM Components" through its OData web service. The service is found by name (`/lm_?components?|royalt/i`) unless setting `royaltiesService` sets it, and field names are matched against candidate lists. If BC fails, it falls back to the last "Documents LM Components" Excel uploaded for the company. The page parses that Excel, `POST /api/royalties/upload` stores it, and it lives in `ApiConfig` key `royalties:upload:<company>`. Lines with Main Item are dropped, and so are intercompany lines (`isIntercompany`: INTERGROUP customer, customer named "CRAZE …", customer dimension "Craze Intercompany", or VAT group INTERCOMPANY…). The LM Royalty Code is ignored. The code always comes from the item card (table 27) in company `CRAZE` (GmbH): the custom API `items`, or an OData page whose name starts with Item and has a `royalt*` field (setting `royaltiesItemService`), cached 6 h. An item with no card there takes its base item's code (letters stripped off the end, e.g. 48412MEILI → 48412), or else keeps its LM code. The LM provision is ignored too. Provision = turnover × % Domestic Royalty (% FOB Royalty when the shipment method is FOB, unless the code's % FOB is 0) from page 80007 "Royalties" in `CRAZE`, OData service `RoyaltiesCRZ` (setting `royaltiesRatesService`), cached 6 h. Contract dates are not applied, the same as in BC's LM. If RoyaltiesCRZ can't be read, the rates come from an uploaded "Royalties" Excel (the same upload button; it is recognised by its `% Domestic Royalty` column, key `royalties:rates-upload`). Without one, they come from the fixed table in `src/lib/royaltyRates.ts` (export of 08/10/2026). UK amounts are in GBP and Group AG amounts in CHF (`companyCurrency`). The page can show them in EUR using the `Currencies_Excel` rate of CRAZE (the same one the BWA uses). The rate is editable and the conversion is done client-side. A code missing from that table has no provision and is listed on the page. Licences a company may not sell are left out (`EXCLUDED_CODES`: BLUEY in UK). The rest is grouped by Royalty Code × bill-to country × item. Price = turnover ÷ qty and rate = provision ÷ turnover. The default period is the last calendar quarter.

Path alias: `@/*` → `src/*`. `src/lib/prisma.ts` exports the singleton client. Use it instead of `new PrismaClient()`, except in standalone scripts.
