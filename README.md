# ATPL Sales Portal (Next.js + Zoho CRM)

Staff-facing portal for Air Trendz Pvt Ltd: **Manage Leads**, **Create Quotation**, **Invoices**, **My Work & Site Visits**
and a manager **Performance** dashboard. Zoho CRM stays the system of record; this app is a thin, secured
front end over the Zoho CRM API (Option 3 in the ATPL CRM plan).

## Run it in 2 minutes (demo mode, no Zoho needed)

```bash
npm install
cp .env.example .env.local     # then set SESSION_SECRET to a random 32+ char string
npm run dev                    # http://localhost:3000  -> pick a demo user
npm test                       # unit tests
npm run typecheck && npm run lint && npm run build
```

## Go live on Zoho

Follow **[docs/SETUP.md](docs/SETUP.md)** (Zoho API console, refresh token, custom fields, roles, deployment).
Then set `DATA_SOURCE=zoho` and `AUTH_MODE=zoho`.

## Architecture

```
Browser (React client components: tabs, forms, preview)
   │  server actions (zod-validated, role-checked)          Server Components read data directly
   ▼
Next.js server  ──►  lib/auth   signed httpOnly session cookie, role guards, middleware
                ──►  lib/crm    CrmRepository interface  ─┬─ mock.ts   (demo / tests)
                                                          └─ zoho/     (live CRM)
                ──►  lib/domain pure business rules (visibility, tabs, KPIs, offer numbers) – unit-tested
                                   │
                                   ▼  OAuth tokens live only here
                              Zoho CRM API v6
```

| Concern | How it is handled |
|---|---|
| Zoho credentials | Server-only (`server-only` import guard). Never sent to the browser. |
| Login | Zoho sign-in accepts active CRM users with a recognised role. Static portal passwords are migrated to salted scrypt hashes in Upstash Redis after first successful sign-in; reset links are single-use and expire after 30 minutes. |
| Authorization | 3 layers: middleware → page guard → server-action check. Executives can only read/modify **their own** leads, quotes, invoices and visits; only Manager/Calling Team can assign; only Managers see Performance. |
| Revoked users | Role is re-read from the CRM user list on every request (5-min cache), so deactivating someone in Zoho cuts access quickly. |
| Prices and GST | Prices and available product GST rates come from Zoho on the server. Quote lines support 0%, 5%, 12%, 18%, 28%, or a custom rate; optional extra charges can have their own GST rate. |
| API limits | Upstash-backed shared TTL cache + in-flight de-duplication; token shared until expiry; 401 auto-refresh; 429 surfaced clearly. |
| Input safety | Every action validates with zod (lengths, formats, enums, quantity limits). |
| Secrets/config | Validated at startup (`lib/env.ts`); demo login is blocked in production with live data. |
| Dates | Business dates use India time (IST), not the server's timezone. |

## How the Lovable screens map to Zoho

| Portal concept | Zoho CRM |
|---|---|
| Lead | Leads module (email → standard `Email`; Source → `Lead_Source`, Status → `Lead_Status`, remarks → `Description`) |
| Fresh Lead / Assigned | Lead **Owner**: owner is a Sales Executive ⇒ assigned; otherwise ⇒ in the fresh queue |
| Update history | Notes on the lead (one note per update) |
| Product catalogue | Products module (`Product_Name`, `Product_Code`, `Unit_Price`, `Usage_Unit`, `Tax`); Managers can add products from the quotation picker |
| Quotation | Quotes module + `Quoted_Items` subform; custom `Offer_No` and `Lead_Ref` fields; stored PDF links can be emailed through the configured provider |
| Invoice | Zoho CRM Invoices module; custom invoice number, source-quote, GSTIN and full snapshot fields; financial-year sequence is shared through Upstash |
| Work / site visit | Tasks module; custom `Is_Site_Visit`, `Visit_Time`, `Next_Action`, `Follow_Up_Date`, `Task_Type` |
| Roles | Zoho role/profile name → Manager / Sales Executive / Calling Team (`src/lib/zoho/fields.ts`); optional static Calling Team access is configured with `ATPL_CALLING_*` |

All ATPL-specific Zoho names are in **one file**: `src/lib/zoho/fields.ts`.

## Project layout

```
src/app/                 routes (login, (app)/home|leads|quotations|invoices|visits|performance), api/auth/zoho/*
src/app/actions/         server actions: auth.ts, crm.ts (all writes + permission checks)
src/lib/domain.ts        pure rules + types (shared by server, client and tests)
src/lib/crm/             repository interface, mock repository + sample data
src/lib/zoho/            client (OAuth, retry, paging), mappers (pure), repository, fields (config)
src/lib/auth/            session, guards, demo-login switch
src/test/                vitest unit tests
```

## Known limits (be upfront with the client)

- Reads up to `ZOHO_MAX_LEADS` leads (default 5000), paging through Zoho's 200-record pages. Set it to the org's expected lead count (maximum 5000).
- Production cache and Zoho token state require Upstash Redis (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`); requests fail explicitly rather than silently falling back to instance-local state.
- Quotation PDFs are rendered server-side and stored in Vercel Blob when a quote is saved. The saved URL is
  reused for later views and shares; a pixel-exact Excel-template PDF still needs a Zoho quote template or
  separate layout work.
- GST is not zero by default: new quotation lines use the product's Zoho tax rate when available, otherwise the configured 18% default. GST is calculated per line and grouped by rate; optional extra charges can carry a separate GST rate. Confirm the configured rates and Zoho tax setup in a sandbox before invoicing.
- Calling Team access uses `ATPL_CALLING_USERNAME`, `ATPL_CALLING_PASSWORD`, and the optional name/email/Zoho ID overrides. No Answer/Busy calls count consecutively toward `NOT_RESPONSIVE_ATTEMPTS` (default 3); Connected and Call Back Later reset the count, while Wrong Number does not affect it.
- Company text and quotation terms are configurable through the non-secret `NEXT_PUBLIC_ATPL_*` variables in `.env.example`; browser and server previews use the same values.
- Staff names are used as identifiers on screen, so full names of staff in Zoho must be unique.
- Zoho field/payload names in `src/lib/zoho/` follow the CRM v6 API but were written without access to ATPL's
  org. Run the **acceptance checklist in docs/SETUP.md §7** against a Zoho sandbox before go-live.
