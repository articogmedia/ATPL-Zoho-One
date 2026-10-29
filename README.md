# ATPL Sales Portal (Next.js + Zoho CRM)

Staff-facing portal for Air Trendz Pvt Ltd: **Manage Leads**, **Create Quotation**, **My Work & Site Visits**
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
| Login | "Sign in with Zoho"; only active CRM users with a recognised role get in. No passwords stored. |
| Authorization | 3 layers: middleware → page guard → server-action check. Executives can only read/modify **their own** leads, quotes and visits; only Manager/Calling Team can assign; only Managers see Performance. |
| Revoked users | Role is re-read from the CRM user list on every request (5-min cache), so deactivating someone in Zoho cuts access quickly. |
| Prices | Taken from the Zoho Products catalogue **on the server**; the browser only sends product id + quantity. |
| API limits | In-memory TTL cache + in-flight de-duplication; token cached until expiry; 401 auto-refresh; 429 surfaced clearly. |
| Input safety | Every action validates with zod (lengths, formats, enums, quantity limits). |
| Secrets/config | Validated at startup (`lib/env.ts`); demo login is blocked in production with live data. |
| Dates | Business dates use India time (IST), not the server's timezone. |

## How the Lovable screens map to Zoho

| Portal concept | Zoho CRM |
|---|---|
| Lead | Leads module (Source → `Lead_Source`, Status → `Lead_Status`, remarks → `Description`) |
| Fresh Lead / Assigned | Lead **Owner**: owner is a Sales Executive ⇒ assigned; otherwise ⇒ in the fresh queue |
| Update history | Notes on the lead (one note per update) |
| Product catalogue | Products module (`Product_Name`, `Unit_Price`, `Usage_Unit`) |
| Quotation | Quotes module + `Quoted_Items` subform; custom `Offer_No` and `Lead_Ref` fields |
| Work / site visit | Tasks module; custom `Is_Site_Visit`, `Visit_Time`, `Next_Action`, `Follow_Up_Date`, `Task_Type` |
| Roles | Zoho role/profile name → Manager / Sales Executive / Calling Team (`src/lib/zoho/fields.ts`) |

All ATPL-specific Zoho names are in **one file**: `src/lib/zoho/fields.ts`.

## Project layout

```
src/app/                 routes (login, (app)/home|leads|quotations|visits|performance), api/auth/zoho/*
src/app/actions/         server actions: auth.ts, crm.ts (all writes + permission checks)
src/lib/domain.ts        pure rules + types (shared by server, client and tests)
src/lib/crm/             repository interface, mock repository + sample data
src/lib/zoho/            client (OAuth, retry, paging), mappers (pure), repository, fields (config)
src/lib/auth/            session, guards, demo-login switch
src/test/                vitest unit tests
```

## Known limits (be upfront with the client)

- Reads the latest `ZOHO_MAX_LEADS` (default 1000) leads. Beyond that, add server-side search (Zoho search API).
- The cache is per server instance. If you run several instances, move it to Redis/Upstash.
- "Download PDF" uses the browser print dialog (matches the Lovable build). A pixel-exact Excel-template PDF
  needs a Zoho quote template or a server-side PDF step — a separate, scoped task.
- GST is shown as Rs 0 until the GST/invoicing scope is confirmed (plan §12).
- Staff names are used as identifiers on screen, so full names of staff in Zoho must be unique.
- Zoho field/payload names in `src/lib/zoho/` follow the CRM v6 API but were written without access to ATPL's
  org. Run the **acceptance checklist in docs/SETUP.md §7** against a Zoho sandbox before go-live.
