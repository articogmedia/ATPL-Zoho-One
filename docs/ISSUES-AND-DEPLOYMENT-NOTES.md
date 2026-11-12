# ATPL Portal — issue diagnosis and deployment checklist

## What the reported screens indicate

- **Quotation PDF sharing:** the application requires `BLOB_READ_WRITE_TOKEN` to publish a PDF URL that can be opened by WhatsApp/email recipients. Add a Vercel Blob store in the same Vercel project and configure its read/write token in Production and Preview as needed. Redeploy after changing environment variables. PDF download can work without public Blob sharing; WhatsApp/email sharing cannot.
- **Invoice conversion (`INVOICE_ACCOUNT_REQUIRED`):** automatic Account resolution needs a company or customer name on the lead. With a name present, the portal searches Zoho Accounts by exact name and then phone, creates an Account if no match exists, and saves its ID to `ATPL_Account_ID`. The OAuth token must include `ZohoCRM.modules.accounts.ALL`.
- **Mark Won failure:** the portal writes `Lead_Status = Won` to Zoho. If Zoho rejects the value, verify that `Won` exists and is active in the Leads module's Lead Status picklist and that the connected OAuth token has Leads update permission. Use the Vercel function log and the reference ID displayed to identify the exact Zoho response; do not infer the cause from the toast alone.
- **My Work & Site Visits loading:** the route waits for Zoho Tasks, users and (for sales executives) supporting performance data, with a 12-second server deadline. A skeleton is expected while this request is pending. If it remains after the deadline, inspect the Vercel function log for `[page] visits ... load failed`, check Zoho API latency/scopes, and check the configured site-visit module API name. Do not treat a captured loading skeleton by itself as proof of an infinite client-side loop.
- **Reset password:** this is a manager-only control for setting a temporary password for one of the portal's static users. It signs out that user's existing sessions. It is not a password reset for Zoho CRM accounts.

## New Product catalogue page

The source project did not contain a standalone Products route; products were only loaded and selected inside quotation creation. A manager-only `/products` page has been added. It lists the Zoho CRM catalogue, supports search, refreshes from Zoho, and adds a product through the existing validated server action. It does not create a second product database or bypass Zoho as the system of record.

## Before deploying

1. Set the required production environment variables in Vercel, including `DATA_SOURCE=zoho`, the correct Zoho OAuth credentials/scopes, `BLOB_READ_WRITE_TOKEN` for external PDF sharing, and the existing shared cache configuration.
2. Confirm the Zoho user/token has access to Leads (read/update), Accounts (read/create/update), Products (read/create), Quotes, Invoices, Tasks, and any configured custom Site Visits module required by the enabled workflows.
3. Confirm the Leads `Lead_Status` picklist includes every status written by the portal, including `Won` and `Lost Lead`.
4. Ensure each lead being invoiced has a company or customer name and each invoice line maps to a Zoho Product.
5. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` in CI or locally with a complete dependency install before promoting the deployment.
6. Test Preview first with a non-production Zoho Sandbox. Promote to Production only after quotation PDF download/share, Mark Won, invoice conversion, product creation, and visits loading have been verified.
