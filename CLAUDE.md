# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

"Craze Finanzas" is an internal finance app for the Craze group of companies (Next.js 16 App Router, React 19, Tailwind 4, Prisma 5 on PostgreSQL). It mirrors data from Microsoft Dynamics 365 Business Central (BC) into Postgres and layers finance workflows on top: customer credit risk (`riesgos`), dunning/collection emails (`recobros`), open ledger entries (`movimientos`), vendor payment approval (`pagos`), cashflow forecasting, inventory valuation, BWA reports, and insurance/contract document management with AI extraction.

The UI, user-facing strings, log messages, and many comments are in **Spanish**. Keep new user-facing text in Spanish.

## Commands

```bash
npm run dev      # runs `next dev` AND src/scripts/cron.ts (BC sync every 5 min) via concurrently
npm run build    # prisma generate && next build
npm run lint     # eslint
npx tsc --noEmit # type-check (src/scripts is excluded from tsconfig)

npx prisma generate          # after editing prisma/schema.prisma
npx prisma db push           # sync schema to the DB (no migrations directory exists)
npx tsx src/scripts/<name>.ts  # run a one-off/debug script (e.g. runSync.ts, checkDb.ts)
```

There is no test suite. Files named `src/scripts/test*.ts` / `check*.ts` / `debug*.ts` are ad-hoc manual scripts that hit BC or the DB directly, not automated tests.

## Environment

Required env vars: `DATABASE_URL`, `DIRECT_URL` (Postgres, see `prisma/schema.prisma`), `JWT_SECRET`, `GEMINI_API_KEY`, `AZURE_AD_TENANT_ID`/`AZURE_AD_CLIENT_ID`/`AZURE_AD_CLIENT_SECRET` (Microsoft SSO; optional `APP_URL` to fix the redirect origin), and optionally `SMTP_HOST/PORT/USER/PASS/FROM`. BC credentials and SMTP settings are primarily stored **in the database** (`BusinessCentralConfig`, `EmailConfig`, singleton rows with `id = 1`), edited from `/settings`. `prisma/dev.db` is a leftover SQLite file; the active datasource is Postgres. Deployment target is Vercel (`maxDuration = 60` on slow routes; `@vercel/blob` for uploads).

## Architecture

### Multi-company scoping
Nearly every table has a `companyId` column holding the **exact BC company name** (e.g. `'CRAZE'`, `'Craze Iberia SL'`), not a UUID. The selected company lives in `CompanyContext` (`src/contexts/CompanyContext.tsx`), persisted to localStorage **and** a `craze_selected_company` cookie. API routes read that cookie (`cookies().get('craze_selected_company')`, default `'CRAZE'`) rather than taking a query param. The `'ALL'` option exists in the UI but most routes don't aggregate across companies. When creating records, pages fall back to `'CRAZE'` if `'ALL'` is selected.

The company list is hard-coded in several places and they are **not consistent**: `COMPANIES` in `CompanyContext.tsx` has `'Craze UK'`, while `targetCompanyNames` in `src/lib/bcSync.ts` and `src/app/settings/page.tsx` have `'Craze Toys'`. Company-specific behavior (currencies, report templates) is keyed on these name strings (see `cashflow/page.tsx`, `lib/reportBuilder.ts`).

### Business Central sync (`src/lib/bcSync.ts`)
`syncBusinessCentral(company?, step)` is the core ETL. It gets an Entra ID client-credentials token, lists BC companies, then for each target company syncs in steps: `customers`, `invoices`, `vendors`, `vendorInvoices`, `recurring` (or `all`). It uses a mix of the standard BC API v2.0, ODataV4, and a **custom BC extension API** (`api/craze/integrations/v1.0`) for salesperson and approval fields. Records are upserted by the composite unique `(bcId, companyId)`. It diffs against existing DB rows and writes in parallel chunks (`chunkedUpdate`). OData paging has an 8s per-page timeout to stay under Vercel limits. `src/lib/salespeopleMap.json` is a fallback code-to-name map for salespeople.

Sync is triggered by `POST /api/sync-bc` (body `{ company?, step? }`; the UI calls it step-by-step to avoid timeouts) and locally by `src/scripts/cron.ts`.

BC-synced fields are overwritten on each sync. Local-only workflow state lives in separate columns that the sync must preserve: e.g. `Invoice.cashflowDate`, `confirmedPaymentDate`, `isArchived`, reminder counters, and `PurchaseInvoice` approval fields (`approvedUsers`, `rejectedUsers`, `noPayment`, `schedulePaymentDate`, …). `RecurringPayment` rows come from BC but are activated and configured by users in Cashflow.

### Auth and permissions
Custom JWT auth (`jose`, HS256, 24h) in an `auth-token` cookie; users and bcrypt hashes are in the `User` table. Login is either username/password (`/api/auth/login`) or Microsoft Entra ID SSO (`/api/auth/microsoft/{login,callback}`, OIDC code flow + PKCE, `src/lib/microsoftAuth.ts`). SSO only admits existing users whose `username` equals their Microsoft email (case-insensitive) and issues the same `auth-token` cookie. `src/middleware.ts` guards all non-public routes. `User.permissions` is a **JSON-encoded string array** of module names (`dashboard`, `riesgos`, `recobros`, `movimientos_abiertos`, `pagos_proveedor`, `cashflow`, `configuracion`/`admin`). The middleware maps URL roots to permission names, blocks UI routes only (API routes are not permission-checked), and forwards `x-user-id`, `x-user-username`, `x-user-permissions` headers. `layout.tsx` reads the session server-side to render the `Sidebar` by permission. When adding a new module page, update the middleware's `protectedUiRoutes`/`permissionMap` and the Sidebar.

### Other patterns
- Data access: import the singleton `prisma` from `@/lib/prisma`. Business logic is often computed inside route handlers (e.g. risk classification in `api/customers/route.ts` is recomputed from open invoices on every GET, not read from stored columns).
- Audit trail: call `logAction(action, details?)` from `@/lib/logger` for user-visible mutations; it records to `ActionLog` (viewable at `/settings/logs`).
- Pages are large single-file client components (`'use client'`) that fetch from `/api/*`. There is little shared component or state abstraction.
- Emails: `nodemailer` with SMTP config from `EmailConfig`; collection reports are HTML built by `lib/reportBuilder.ts` (preview at `/api/preview-report`).
- AI: insurances and contracts use Google Gemini (`@google/generative-ai`) for PDF text extraction (`*/extract`) and Q&A chat (`*/bot`).
