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

For Zoho CRM sandbox testing, set the optional `ZOHO_API_BASE_URL` to the sandbox API host
(for example, `https://crmsandbox.zoho.in`). When it is not set, the portal uses the
production CRM API host selected by `ZOHO_DC`. OAuth accounts URLs remain selected by
`ZOHO_DC`; sandbox credentials and OAuth clients should be created in the corresponding
Zoho API Console.

1. In the API Console add a **Self Client**. Put its Client ID / Secret in `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET`.
2. Open its **Generate Code** tab. Scope (comma-separated):
   `ZohoCRM.modules.leads.ALL,ZohoCRM.modules.quotes.ALL,ZohoCRM.modules.tasks.ALL,ZohoCRM.modules.notes.ALL,ZohoCRM.modules.products.READ,ZohoCRM.users.READ`
   Time duration 10 minutes → Generate → copy the code.
3. Exchange it before it expires:
   ```bash
   curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
     -d grant_type=authorization_code -d client_id=<SELF_CLIENT_ID> -d client_secret=<SELF_CLIENT_SECRET> -d code=<CODE>
   ```
4. Save the returned `refresh_token` as `ZOHO_REFRESH_TOKEN`. Treat it like a password.

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

Different API names? Change them in `src/lib/zoho/fields.ts` — nothing else.

## 4. Pick-list values

- **Leads → Lead Status:** Fresh Lead, Attempted to Contact, Callback in Future, Contacted, Site Visit Scheduled, Quotation Sent, Won, Lost.
- **Leads → Lead Source:** Meta Ads, Google Ads, Direct Call (other values such as "Facebook" are folded in automatically).
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
6. Create a quotation: choose a product → price equals the Zoho `Unit_Price`; Save → Quote exists in Zoho with line items and correct Grand Total; offer number increments.
7. Manager → Performance: numbers match a manual count for the same period.
8. Deactivate a test user in Zoho → within ~5 minutes they are bounced to login.
9. Submit a test Meta and Google lead form → appear in Fresh Leads with the right source label.
10. Kill the network / use a wrong token → users see a friendly error, no stack traces or secrets.
