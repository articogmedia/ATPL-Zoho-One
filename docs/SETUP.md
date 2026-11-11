# Setup guide: connecting the portal to ATPL's Zoho CRM

Estimated time: 1–2 hours for someone with Zoho admin access. Do this in a **Zoho sandbox first** if the plan allows.

## 1. Staff sign-in client (Server-based application)

1. Open the API Console for ATPL's data centre (India: https://api-console.zoho.in).
2. **Add Client → Server-based Applications.**
   - Homepage URL: your portal URL.
   - Authorized Redirect URI: `https://<your-domain>/api/auth/zoho/callback` (also add `http://localhost:3000/api/auth/zoho/callback` for local testing).
3. Put its Client ID / Secret in `ZOHO_LOGIN_CLIENT_ID` / `ZOHO_LOGIN_CLIENT_SECRET`.
   This client only identifies *who is signing in* (scope `AaaServer.profile.READ`). It never touches CRM data.

## 2. CRM data access (Self Client, one-time)

Use a **dedicated CRM admin user** (e.g. `portal@…`) as the integration identity.

### Using the Zoho sandbox

Sandbox access requires Zoho CRM Enterprise or above. Set `ZOHO_SANDBOX=true` to use
the sandbox CRM API host (`https://sandbox.zohoapis.<dc>`); OAuth accounts URLs remain selected by `ZOHO_DC`.
The refresh token must be generated for the SANDBOX org; a live-org token causes `DOMAIN_TOKEN_MISMATCH`.
The custom
fields in step 3 must be created in the sandbox too. If sandbox calls return
authorization errors, a separate Self Client may be needed for the sandbox.

1. In the API Console add a **Self Client**. Put its Client ID / Secret in `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET`.
2. Open its **Generate Code** tab. Scope (comma-separated):
   `ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.modules.leads.ALL,ZohoCRM.modules.quotes.ALL,ZohoCRM.modules.invoices.ALL,ZohoCRM.modules.tasks.ALL,ZohoCRM.modules.calls.ALL,ZohoCRM.modules.events.ALL,ZohoCRM.modules.notes.ALL,ZohoCRM.modules.products.READ,ZohoCRM.modules.products.CREATE,ZohoCRM.modules.custom.ALL,ZohoCRM.users.READ,ZohoCRM.org.READ,ZohoCRM.settings.fields.READ,ZohoCRM.settings.modules.READ`
   Time duration 10 minutes → Generate → copy the code.
3. Exchange it before it expires:
   ```bash
   curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
     -d grant_type=authorization_code -d client_id=<SELF_CLIENT_ID> -d client_secret=<SELF_CLIENT_SECRET> -d code=<CODE>
   ```
4. Save the returned `refresh_token` as `ZOHO_REFRESH_TOKEN`. Treat it like a password.
   Refresh tokens keep the scopes granted when they were created. Lead create
   requires `ZohoCRM.modules.leads.CREATE` (included in
   `ZohoCRM.modules.ALL` or `ZohoCRM.modules.leads.ALL`), quote creation requires
   `ZohoCRM.modules.quotes.CREATE`, and the create flow reads module metadata
   using `ZohoCRM.settings.ALL` or the narrower `ZohoCRM.settings.fields.READ`.
   Manager-created products require `ZohoCRM.modules.products.CREATE` in addition
   to `ZohoCRM.modules.products.READ`. After adding this scope, generate a new
   authorization code and exchange it for a new refresh token; existing refresh
   tokens do not gain scopes when refreshed.
   Invoice creation and listing require `ZohoCRM.modules.invoices.ALL`. Add this
   scope and generate a new authorization code and refresh token; an existing
   refresh token does not gain permissions when refreshed.
   If CRM reports `OAUTH_SCOPE_MISMATCH`, generate a new authorization code with
   these scopes and replace the saved refresh token; refreshing an old token
   will not add permissions.

### Quotation PDF storage and sharing

In the Vercel Dashboard, open **Storage → Create Blob store**, then connect the
store to this project and redeploy. Vercel adds `BLOB_READ_WRITE_TOKEN`; add the
same value to local `.env.local` for development. Saving a quotation renders its
PDF once and uploads it under a random, unguessable filename. The URL is kept in
the shared Upstash cache and reused when the saved quotation is opened or shared;
older saved quotations get a PDF the first time they are opened. Keep this token
server-side; it is never sent to the browser. If storage is unavailable, the
quotation is still saved and the UI reports that its PDF could not be stored.

### Invoices

The portal creates invoices in **Zoho CRM's Invoices module** (not Zoho Books).
Before enabling conversion, create these custom fields in the Invoices module:

| API name | Type | Purpose |
| --- | --- | --- |
| `ATPL_Invoice_No` | Single line | Financial-year invoice number |
| `Customer_GSTIN` | Single line | Customer GSTIN snapshot |
| `ATPL_Source_Quote_ID` | Single line | Prevent duplicate conversion of a quote |
| `ATPL_Invoice_Snapshot` | Multi-line (large text) | Saved line items, GST rates, charges, and customer details |

Invoice creation requires an existing Zoho Account lookup. Link the quote's
`Account_Name`, or populate the Leads custom field `ATPL_Account_ID` with the
linked Zoho Account record ID. The portal does not create an Account during
conversion. Each invoice line must also reference an existing Zoho Product.
Invoice PDFs are stored in the configured Vercel Blob store; invoice email links
point to that stored PDF. Invoice numbers use the shared Upstash Redis `INCR`
sequence, scoped by Indian financial year, so both Upstash variables must be
configured for production.

### Environment variables

Set `DATA_SOURCE`, `AUTH_MODE`, `SESSION_SECRET`, `ALLOW_DEMO_LOGIN`, `ZOHO_DC`, `ZOHO_SANDBOX`,
`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, and
`ZOHO_QUEUE_OWNER_ID`. For Zoho sign-in also set
`ZOHO_LOGIN_CLIENT_ID`, `ZOHO_LOGIN_CLIENT_SECRET`, and `ZOHO_LOGIN_REDIRECT_URI`.
`ZOHO_DC` selects both the CRM API and OAuth accounts hosts (for example `in` uses
`zohoapis.in` and `accounts.zoho.in`). Optional `ZOHO_API_BASE_URL`,
`ZOHO_API_DOMAIN`, and `ZOHO_ACCOUNTS_URL` overrides must use HTTPS and match that
data centre; mismatches fail environment validation instead of silently sending
credentials or requests to another Zoho region.
`ZOHO_ROLE_OVERRIDES` is optional. `ZOHO_CRM_WEB_BASE` is optional and enables
the **Open in Zoho** link after lead create/assignment. `ZOHO_WEBHOOK_SECRET` is
optional and protects the Zoho Products cache-invalidation webhook.

For production Vercel deployments, configure `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` from a private Upstash Redis database. They share the
Zoho access token, refresh lock, and final list caches across serverless instances.
The access token is stored with a short expiry and is never logged or sent to the
browser. Both variables are required in production; CRM and cache operations fail
explicitly rather than falling back to per-instance-only state if Redis is missing
or unavailable. Keep the Upstash token server-only; it is also used by login
rate limiting.

The Hobby-compatible Vercel configuration does not schedule a Cron Job.
`/api/warm` remains available and is also called by the login page to warm the
shared Zoho token when a user opens the portal.
The signed-in app also refreshes warm caches on foreground, at most once every
five minutes. If a deployment needs warmth between active sessions, an external
uptime monitor can issue a GET request to `https://<portal-host>/api/warm` every
five minutes; no authentication is required for this read-only endpoint.

### Refresh products from Zoho

Set a long, random `ZOHO_WEBHOOK_SECRET` in the deployment environment and redeploy.
In Zoho CRM, open **Setup → Automation → Workflow Rules → Products**, create a rule
that runs on product creation or edit, and configure a webhook action to send a
`POST` request to `https://<portal-host>/api/webhooks/zoho-products` with the
header `x-zoho-webhook-secret: <same ZOHO_WEBHOOK_SECRET>`. The endpoint accepts
only that shared-secret header and invalidates the product cache; the portal
re-fetches product data on the next product-list request. Managers can also use
**Refresh products** in the quotation product picker.

For static portal login, set `ATPL_RESHMA_PASSWORD`, `ATPL_PAVAN_PASSWORD`, and
`ATPL_SAIKIRAN_PASSWORD`. The static users in `src/lib/auth/users.ts` use the
matching active CRM user ids. The static login
uses the same signed session and server-side role checks as Zoho login.
To enable the Calling Team static login, set `ATPL_CALLING_USERNAME` and
`ATPL_CALLING_PASSWORD`; optionally set `ATPL_CALLING_NAME`,
`ATPL_CALLING_EMAIL`, and `ATPL_CALLING_ZOHO_USER_ID`. The Calling Team only
sees Fresh Leads and Callback and may assign a lead to an active Sales Executive.
`NOT_RESPONSIVE_ATTEMPTS` defaults to 3 consecutive No Answer/Busy attempts.
Connected and Call Back Later reset the streak; Wrong Number is recorded as the
latest outcome but does not increment or reset the streak.
After a user's first successful login, their password is migrated to a salted
scrypt hash in Upstash Redis; subsequent logins use the stored hash. Password
storage and reset rate limits require `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` in production.
Reset email delivery is intentionally disabled until an email provider is
selected and configured in `src/lib/email.ts`. Reset requests still return a
generic response. Reset links are single-use and expire after 30 minutes;
Managers can use **Reset password for user** on Home as an administrative
fallback. A successful reset invalidates that user's existing portal sessions.
Quotation email is configured separately: set `EMAIL_PROVIDER=resend`,
`EMAIL_FROM` to a verified sender address, and `RESEND_API_KEY` to enable the
Resend adapter in `src/lib/email.ts`. Until configured, email sending is disabled.
Quotation emails include the stored PDF link and are limited to 10 sends per
user per hour and 3 sends per quotation per hour; production rate limits use
the shared Upstash Redis instance.
Optional explicit Zoho user mappings are `ATPL_RESHMA_ZOHO_USER_ID`,
`ATPL_PAVAN_ZOHO_USER_ID`, and `ATPL_SAIKIRAN_ZOHO_USER_ID`. When set, these
are resolved before portal email/name matching. If unset, the portal resolves
the CRM user from `ATPL_*_EMAIL`, exact name, or first name.
`ALLOW_DEMO_LOGIN=true` is required to show the sandbox demo-user buttons.

Company and offer text can be overridden with the non-secret
`NEXT_PUBLIC_ATPL_COMPANY_*` and `NEXT_PUBLIC_ATPL_OFFER_*` variables in
`.env.example`. The prefix is intentional: quotation preview renders in the
browser, so these values must be public and must never contain credentials.

Managers can check the live configuration at `/api/admin/diagnostics`; it reports
role mappings, queue-owner resolution, picklists, custom fields, and the active
sandbox/production host without returning tokens.

## 3. Create the custom fields (Setup → Customization → Modules and Fields)

| Module | Field label → API name | Type |
|---|---|---|
| Quotes | Offer No → `Offer_No` | Single line |
| Quotes | Lead → `Lead_Ref` | Lookup → Leads |
| Tasks | Is Site Visit → `Is_Site_Visit` | Checkbox |
| Tasks | Visit Time → `Visit_Time` | Single line (HH:mm) |
| Tasks | Next Action → `Next_Action` | Single line |
| Tasks | Follow Up Date → `Follow_Up_Date` | Date |
| Tasks | Task Type → `Task_Type` | Single line (or pick list) |
| Leads | Lost Reason → `Lost_Reason` | Pick list (use the values below) |
| Calls | Call Result → `Call_Result` | Pick list (use the values below) |
| Calls | Call Start Time → `Call_Start_Time` | Date/time |

Different API names? Change them in `src/lib/zoho/fields.ts` — nothing else.

## 4. Pick-list values

- **Leads → Lead Status:** Fresh Lead, Attempted to Contact, Callback in Future, Contacted, Assigned to Sales, Junk Lead, Site Visit Scheduled, Quotation Sent, Won, Lost Lead.
- **Leads → Lead Source:** Meta Ads, Google Ads, Direct Call, Walk-in, Referral, Website, Other. Portal sources are mapped to configured Zoho values; if a source is absent, the portal logs a warning and uses the configured `Other` value.
- **Leads → Lost Reason:** Price too high, Chose competitor, Project postponed, Budget unavailable, Product not suitable, No response, Other.
- **Calls → Call Result:** Connected, No Answer, Busy, Call Back Later, Wrong Number.
- Meta/Google lead forms keep feeding Zoho natively (plan §P2). Map their source to the values above and set new-lead default status to **Fresh Lead**.

## 5. Users and roles

Give each staff member a Zoho CRM user whose **Role or Profile name** is one of: `Sales Executive`, `Calling Team`,
`Manager` (also `Administrator`, `CEO`, `Sales Manager` → Manager). Edit `ROLE_BY_ZOHO_NAME` in `fields.ts` to match ATPL's real names.
Set `ZOHO_QUEUE_OWNER_ID` to the CRM user id that should own un-assigned leads (e.g. the calling-team lead); new
leads from ad forms should be owned by that user (Setup → Automation → Assignment Rules).

## 6. Deploy

- Recommended: Vercel or any Node 20+ host with HTTPS. Set the env vars from `.env.example` in the host's dashboard.
- Production values: `DATA_SOURCE=zoho`, `AUTH_MODE=zoho`, `ZOHO_DC=in`, a fresh 48-char `SESSION_SECRET`,
  `ZOHO_LOGIN_REDIRECT_URI=https://<domain>/api/auth/zoho/callback`, plus both credential pairs (data + sign-in).
- Never commit `.env*`. Rotate the client secret if it was ever shared in chat/email.

## 7. Acceptance checklist (run in sandbox, then production)

1. Sign in as each role; confirm the home screen shows only allowed actions (Calling Team: 1, Executive: 3, Manager: 4).
2. Add a lead as Calling Team → appears under **Fresh Leads to Call** and in Zoho with status *Fresh Lead*.
3. Assign it to an executive → leaves the Fresh tab, remains under **All Leads**; Owner changed in Zoho; a Note was added.
4. Sign in as that executive → sees only their leads; cannot see others (try opening another lead id in devtools: must be refused).
5. Schedule a site visit from the lead card → Task appears in Zoho; shows in **My Work & Site Visits**; Start / Complete / Reschedule update the Task.
6. Create a quotation: choose a customer, then a product → price and available default GST rate come from Zoho; confirm per-line rates (0%, 5%, 12%, 18%, 28%, or custom) and any extra charges/GST; preview saves a Draft quote with line-item tax, adjustment, grouped GST, and matching Grand Total; download/share the PDF before the lead advances to `Quotation Sent`.
   In **Saved quotations**, Edit updates the existing quote and PDF, preserving its offer number and appending `/R1`, `/R2`, etc. Executives can edit only their own quotes; only Managers can edit Sent or Won quotes.
7. Manager → Performance: numbers match a manual count for the same period.
8. Deactivate a test user in Zoho → within ~5 minutes they are bounced to login.
9. Submit a test Meta and Google lead form → appear in Fresh Leads with the right source label.
10. Kill the network / use a wrong token → users see a friendly error, no stack traces or secrets.
11. Open `/api/admin/diagnostics` as a Manager and confirm the queue owner resolves and all expected executives are mapped.
12. Mobile smoke (390x844): add a lead, confirm it appears in All Leads, assign it, log a call, schedule a site visit, create a quote, and confirm the lead status advances to `Quotation Sent`.
13. Test the supplied `docs/238 - OFFER.xlsx` layout in the PDF preview; confirm `NNN/YY-YY` offer numbers and server-side Zoho prices.

14. UI regression: verify at 390x844 and 1366x768 that navigation, cards, bottom sheets, forms, tables/cards, and A4 print preview remain usable.
15. Verify keyboard focus, accessible labels, status contrast, and logout/back-navigation behaviour after a session ends.

## Open business decisions

### GST inclusion in historical offer templates

Keep the portal's existing per-line GST calculation; do not change totals based on these legacy examples:

- `docs/238 - OFFER.xlsx`: Part A is described as GST included at Rs. 438,000. Part B is Rs. 35,500 with GST 18% extra, but the displayed Rs. 473,500 total is Part A plus Part B and excludes Part B GST.
- `docs/236 - OFFER - R1.xlsx` (Samsung sheet): Part A is Rs. 387,600 plus Rs. 69,768 GST. Part B is Rs. 649,626 with GST extra, but the displayed Rs. 1,106,994 total includes Part A GST and excludes Part B GST.

Today the portal calculates GST at each quote line's rate, adds GST on extra charges when specified, and adds all of that GST to the grand total for both Part A and Part B. It has no GST-included mode. These two source templates therefore do not define one consistent tax-inclusion policy; confirm a new business rule before changing the portal calculation.

## Remaining risks

- The bundled Playwright quotation test uses mock CRM data. Live Zoho write, PDF download, and WhatsApp sharing still require manual verification in a sandbox with a dedicated test record; Vercel environment values and hosted logs must be inspected by an authorized operator.
- Zoho custom Task fields and user metadata can change independently of the portal; run `/api/admin/diagnostics` before acceptance testing.
- Browser-close/session restoration behaviour differs across mobile browsers, so test on the actual target Android/iOS browser versions.
