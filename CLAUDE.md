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

**Reporting (`/reporting`).** Operacional and Dirección tabs over a multi-month selection (`?months=YYYY-MM,...`). Each section has its own route under `src/app/api/reporting/`; shared helpers live in `src/lib/reporting.ts` (periods, cartera, snapshots, config), `src/lib/bcClient.ts` (BC token/URLs, paged fetch) and `src/lib/cashflow.ts` (the same cashflow calculation the Cashflow page uses).
- The cartera (customers/vendors, MARKANT, CHINA INV, AMAZON/ALDI/LIDL) is computed live for the current month. Past months read `ReportingSnapshot`, which `/api/reporting/snapshot` writes once a day (Vercel cron in `vercel.json`, and `cron.ts` in dev). Months before snapshots started have no data.
- Inventory, CHINA TRF purchases and provisions are read live from BC. Inventory uses the ODataV4 web service for page 5802 "Value Entries" with `$apply` aggregation, falling back to aggregating the raw entries in the app. The service name and the provision G/L accounts are stored in `ApiConfig` (key `reporting`) and edited from the page's Configuración panel.
- `PurchaseInvoice.schedulePaymentDate` is BC's Scheduled Payment Date (`scheduledPaymentDateBCT`), which counts as the confirmed payment date. It is null when no date is scheduled; it does not fall back to the due date.

Path alias: `@/*` → `src/*`. `src/lib/prisma.ts` exports the singleton client. Use it instead of `new PrismaClient()`, except in standalone scripts.
