# UI Audit — Before

## Scope and method

Captured the login page and the Home, Leads, Quotations, Visits, and Performance pages at 360, 390, 430, 768, 1024, and 1440 CSS pixels using Playwright in the demo account. Also inspected the mobile Add Lead and filter sheets, the saved-quotations drawer, and a saved-quote preview. Viewport captures and measured layout data are in [`ui-audit/before/`](./ui-audit/before/).

The route screenshots use `{page}-{width}.png`; the login screenshots use `login-{width}.png`. `measurements.json` records viewport/document widths, visible controls, target sizes, input font sizes, and page errors. No document-level horizontal overflow was measured at any of the 30 authenticated page/viewport combinations.

Severity: **High** blocks a core task or content; **Medium** materially degrades usability/accessibility; **Low** is a polish issue or needs automated verification.

## Alignment/overflow

| Page | Viewport | Problem | Severity |
|---|---:|---|---|
| Leads | 360–430 | The stage-filter pills extend past the visible row and are clipped at the right edge; the search placeholder is also cut off at 360. There is no clear scroll affordance. | Medium |
| Quotations — saved preview | 360–430 | The offer document is compressed to the viewport width: its dense table headings wrap and the document text is difficult to read at the rendered size. | Medium |
| Performance | 768 | The executive performance table remains a wide table; the rightmost conversion column is clipped instead of being visible or exposed through an obvious horizontal-scroll affordance. | Medium |
| Home, Leads, Quotations, Visits, Performance | 360–430 | The fixed bottom navigation overlays page content near the viewport bottom; content has insufficient clearance from the bar. | Medium |

## Spacing inconsistencies

No consistent high- or medium-severity spacing defect was observed in the page-level captures. Mobile cards and form fields generally use consistent inset spacing. **Low:** header branding and action areas become crowded at the narrowest width.

## Typography

| Page | Viewport | Problem | Severity |
|---|---:|---|---|
| Quotations — saved preview | 360–430 | Bill/ship details, offer metadata, and table content become very small when the full document is scaled down to fit a phone. | Medium |
| Login, Leads, Visits | 360–430 | Supporting labels and metadata are frequently rendered smaller than the 16px mobile body-text target, making dense information harder to scan. | Medium |

## Color/contrast

| Page | Viewport | Problem | Severity |
|---|---:|---|---|
| Login, Leads, Visits, Performance | All | Muted blue-gray helper text and small metadata on pale surfaces appear low contrast. Visual inspection is not a WCAG measurement; verify these text/surface pairs with axe during quality gates. | Low |

## Tap targets

| Page | Viewport | Problem | Severity |
|---|---:|---|---|
| Leads | 768–1440 | Row action icon buttons measure 36×36px, below the requested 44px minimum. | Medium |
| Leads | 360–430 | Telephone links measure about 112×20px; increase their vertical hit area without changing the displayed number. | Medium |

## States (loading/empty/error/disabled)

No persistent page-level error overlay or broken empty state was observed in the production-like captures. Seed data populated the main lists; empty and failed-network states were not force-injected in this audit. The saved-quotation drawer briefly displayed its loading message before the seeded list appeared; its loading state should be checked for a skeleton and retry behavior during Stage 1/quality gates.

## Modal/drawer behavior

| Page | Viewport | Problem | Severity |
|---|---:|---|---|
| Leads — filters | 390 | Pressing Escape leaves the filter sheet open; it requires the close control or applying filters. | Medium |
| Quotations — saved drawer | 390 | The drawer uses the full mobile viewport and its last row approaches the bottom edge; verify safe-area clearance and scroll access alongside the fixed navigation. | Low |

The Add Lead sheet has visible field labels and a visible focus ring in the captured state. See [`leads-add-modal-390.png`](./ui-audit/before/leads-add-modal-390.png) and [`leads-filters-390.png`](./ui-audit/before/leads-filters-390.png).

## Forms

No high- or medium-severity form-layout issue was observed on the login or Add Lead captures: fields are full width on mobile, labels are visible, and the focused field has a visible outline. Empty/invalid submission and keyboard-open states were not exercised in this visual pass.

## Tables to cards

| Page | Viewport | Problem | Severity |
|---|---:|---|---|
| Performance | 768 | The executive table has not transitioned to cards at this width and its final column is clipped. At 360–430, the executive data is presented as readable cards. | Medium |

## Navigation

| Page | Viewport | Problem | Severity |
|---|---:|---|---|
| All authenticated pages | 360–430 | The bottom tab bar is fixed over scrolling content without enough bottom clearance. | Medium |

## Performance jank

No persistent visual jank was apparent in the demo page captures. This stage did not run Lighthouse, measure CLS, or profile interaction latency; those remain Stage 5 checks.

## Screenshots

The required page/viewport matrix is captured in [`ui-audit/before/`](./ui-audit/before/), including:

- `login-{360,390,430,768,1024,1440}.png`
- `{home,leads,quotations,visits,performance}-{360,390,430,768,1024,1440}.png`

Additional mobile captures include [`quotations-saved-drawer-390.png`](./ui-audit/before/quotations-saved-drawer-390.png), [`quotation-preview-390.png`](./ui-audit/before/quotation-preview-390.png), and [`quotation-preview-1440.png`](./ui-audit/before/quotation-preview-1440.png).

## After summary

Pending Stage 1. No application code was changed during this audit.
