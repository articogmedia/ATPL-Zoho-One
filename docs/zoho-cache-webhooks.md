# Zoho CRM cache refresh webhooks

The portal exposes `POST https://<portal-host>/api/webhooks/zoho-records`. Configure the request to send:

- Header: `x-zoho-webhook-secret: <ZOHO_WEBHOOK_SECRET>`
- Body: `{"module":"Leads"}` (use the module API name shown below)
- Content type: `application/json`

Set `ZOHO_WEBHOOK_SECRET` in the Vercel project to a long, randomly generated secret. Use the same value in every webhook, keep it out of the URL and workflow body, and never add it to logs or source control. The endpoint accepts only `Leads`, `Quotes`, `Invoices`, `Tasks`, and `Products`; it returns `401` for an invalid secret and `400` for an unsupported module.

## Workflow rules

In Zoho CRM, create a workflow rule for each module below. Select **On a record action**, then configure the rule for record creation and edit. If the Zoho workflow UI supports deletion for the module, add deletion as a trigger too. Some CRM editions do not offer delete as a workflow action; in that case, use a supported Zoho function/automation on deletion or rely on the portal’s manual Refresh button.

Add a webhook action using the portal URL, custom secret header, and the matching JSON body:

| Module API name | Trigger | JSON body |
| --- | --- | --- |
| `Leads` | Create, edit, and delete when available | `{"module":"Leads"}` |
| `Quotes` | Create, edit, and delete when available | `{"module":"Quotes"}` |
| `Invoices` | Create, edit, and delete when available | `{"module":"Invoices"}` |
| `Tasks` | Create, edit, and delete when available | `{"module":"Tasks"}` |

Use the **module API name**, not its singular label. For example, Zoho's Quotes module is sent as `Quotes`.
