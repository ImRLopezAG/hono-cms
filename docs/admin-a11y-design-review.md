# Admin SPA Accessibility & Visual Review

**Date:** 2026-05-23
**Scope:** Hono CMS admin SPA at `http://127.0.0.1:5173/`
**Method:** Live browser audit via `agent-browser` (Chrome/CDP), automated DOM analysis (heading hierarchy, label association, accessible names, computed contrast against sRGB-resolved colors), focus-ring spot checks, manual review of screenshots.
**Standards:** WCAG 2.1 AA, Vercel Web Interface Guidelines.
**Screenshots:** `/Users/imrlopez/dev/monorepo/cms/docs/screenshots/a11y/01-…16-…png` (+ 17 webhook-error capture).
**Status:** READ-ONLY findings — no source files were modified.

> **Routes audited (15/15):** `/login`, `/content`, `/content/authors`, `/content/articles`, `/media`, `/settings/health`, `/settings/audit-log`, `/settings/webhooks`, `/settings/api-keys`, `/settings/sessions`, `/settings/content-types`, `/settings/content-types/visualizer`, `/settings/i18n`, `/organization/settings`, `/organization/members`, `/organization/invitations`.

---

## Summary

| Severity | Count |
|---|---|
| **P0 (broken / blocking)** | **2** |
| **P1 (WCAG AA violation)** | **11** |
| **P2 (UX inconsistency)** | **7** |
| **P3 (polish)** | **4** |

The two most consequential findings are systemic: **every single page has two `<h1>` elements** (the app shell hard-codes "Content Operations" plus each page renders its own), and **the app has no live-region / toast infrastructure at all** — neither validation errors nor success messages are announced to assistive technologies. Fixing those two issues alone removes ~half of the P1 findings.

---

## Per-View Findings

### 1. `/login`

Screenshot: `01-login.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P1 | Page is reachable when authenticated and renders behind the global app shell (sidebar + global h1 still visible). User can navigate away mid-login. | Render `/login` on a bare layout (no sidebar / no global h1) — split route into a separate root segment or use a layout flag. |
| P1 | No `role="status"` / `aria-live="polite"` region for login errors. Invalid credentials produce no SR-announced feedback. | Add a `<div role="alert" aria-live="assertive">` for the error slot under the form. |
| P1 | Three text inputs (`Email`, `Password`, `API token`) lack `aria-describedby` linking to help/error text. | Add `aria-describedby` to each input and wire it to a sibling helper / error node. |
| P2 | The page's actual h1 is `<h2>Login`. Heading hierarchy on the route is `h1 "Content Operations"` (shell) → `h2 "Login"`. | When login renders, the page-level title (Login) should be the h1; remove the shell h1 entirely (see cross-cutting #1). |
| P2 | No "Forgot password?" / "Need an account?" affordance, no submit-disabled state, no loading spinner during auth. | Add inline progress indicator and a footer link slot. |

### 2. `/content` and `/content/$collectionName`

Screenshots: `02-content.png`, `03-content-authors.png`, `04-content-articles.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>` per page: shell renders "Content Operations" + page renders "authors"/"articles". | Cross-cutting fix #1. |
| P1 | The content list is a **div with role attributes**, not a `<table>`. Result: sort-buttons live in `[role="columnheader"]` but the row-select checkbox has no `aria-label` (snapshot shows `checkbox "Select visible records"` only because base-ui labels the *header* checkbox; row-level checkboxes lack names). | Either migrate to a real `<table>`/`<thead>` with `<th scope="col">`, or ensure every interactive cell has `aria-label` ("Select row 3", "Select all visible"). |
| P1 | Sort buttons in column headers have no `aria-sort` reflected on the columnheader; users can't tell which column is currently sorted by SR. | Add `aria-sort="ascending"` / `descending` / `none` to the `[role="columnheader"]` wrapping each sort button, and update on toggle. |
| P1 | The inline "New record" panel re-renders unconditionally next to the table, with its own `<h2>` and form fields, but is not announced when triggered by clicking "New record" — clicking the button does not move focus into the form or fire any SR-visible state change. | Move focus to the first field of the panel when it opens (existing pattern) and wrap the panel in `aria-live="polite"` or use a proper Dialog if the right-rail form is modal. |
| P1 | Form field `<textarea>` rich-text editor (Tiptap) has no accessible name. Toolbar buttons (Bold/Italic/Heading/…) have visible names but no `aria-pressed` to indicate active state. | Add `aria-label="Body"` (or label) to the editor `[contenteditable]`. Wire `aria-pressed` to mark toolbar state. |
| P1 | "ApiKey" field rendered as a plain textbox with no copy / show-hide affordance, no `type="password"` or `autocomplete="off"`. | Treat secrets as masked inputs by default. |
| P2 | The tabs `authors 3 fields` / `articles 6 fields` are styled as tabs but lack `role="tablist"` / `aria-controls` on the panel — verifiable by snapshot (`tab` role but no panel association). | Wire `aria-controls` from each tab to the records region's id. |
| P2 | Loading state: opening `/content/articles` shows no skeleton — the table snaps in. `hasLoading: false` confirmed. | Add a `<tbody role="status" aria-busy="true">` skeleton during initial fetch. |
| P3 | "UPDATEDAT down" reads in the SR as a single token (no space, no narration of "sort descending"). | Use `aria-label="Updated at, sorted descending"` on the sort button. |

### 3. `/media`

Screenshot: `05-media.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s ("Content Operations" + "Media library"). | Cross-cutting #1. |
| P2 | "No asset selected" empty-state IS present (h2) — but is the only feedback for an unselected detail pane. No images render in the index list (in this dataset). The grid lacks a true empty state ("Upload your first asset" CTA). | Add an empty list state with an upload CTA. |
| P2 | Search input has `aria-label="Search media"` (good) but the wrapping `<input type="search">` has no `aria-describedby` for the "filename, URL, metadata" hint. | Bind the existing hint via `aria-describedby`. |
| P3 | "No asset selected" is `<h2>` — semantically a heading, but visually a centered placeholder. Consider `<div role="status">` instead so heading hierarchy isn't polluted by a placeholder. | Drop the h2; use `<p role="status">`. |

### 4. `/settings/health`

Screenshot: `06-health.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s. | Cross-cutting #1. |
| P1 | Sidebar group label `SYSTEM` is 10px / 600 weight / `oklch(0.552 0.016 285.938)` (~`#94a3b8`) on white. Contrast ratio ~2.5 — **fails AA** (4.5 for small text). | Use `slate-500`/`oklch(0.45 …)` or darker; OR raise to ≥14px and 700 weight. Same applies to all sidebar group labels (`WORKSPACE`, `SYSTEM`, `CONSOLE`). |
| P1 | The `Console` and the page subtitle "Schema-driven editing, deployment health" appear in `oklch(0.552 …)` on white — ratio ~2.9. | Use the muted-foreground token at ≥4.5:1 (e.g., `#475569`/slate-600). |
| P2 | Health table has 5 columns but no `<caption>` / `aria-label`. | `<table aria-label="System checks">` or add a `<caption class="sr-only">`. |
| P2 | "Refresh" button gives no visible loading feedback after click. | Add `aria-busy="true"` + spinner on the button. |

### 5. `/settings/audit-log`

Screenshot: `07-audit-log.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s. | Cross-cutting #1. |
| **P1** | **Three filter inputs (`collection`, `documentId`, `actorId`) have only a `placeholder` — no `<label>`, no `aria-label`.** Placeholders disappear on focus and are NOT accessible names. | Add `<label class="sr-only">` or `aria-label` to each. |
| P1 | No `aria-live` region for results count / state. After filtering, SR users don't get feedback that results changed. | Wrap the result count in `aria-live="polite"`. |
| P1 | No empty state when zero events match the filter — the table area just collapses to nothing. | Render "No audit events match these filters." |
| P2 | Filter form has no `<form>` element / no Submit button; filtering happens on blur (presumably). Keyboard users get no clear "Apply" affordance. | Wrap fields in `<form>` with a visible Apply button. |
| P3 | `datetime-local` inputs have `aria-label="Audit from"` / `"Audit to"` — good. Page-size input has `aria-label="Audit page size"` — good. Consistent labels would be nice on the text filters too. |  |

### 6. `/settings/webhooks`

Screenshots: `08-webhooks.png`, `17-webhooks-create-empty.png` (validation state)

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s, plus a *third* page-local `<h2>Webhooks` repeating the page title under the page h1. | Drop the duplicate `<h2>Webhooks` heading. |
| **P0** | **Clicking "Create" with an empty form yields the text "Required" twice in the DOM but no `role="alert"` / `aria-live` region. Screen-reader users hear nothing.** | Add `role="alert"` to the field-error span, OR a single live region under the form. |
| P1 | "Events" hint text "Comma-separated list (e.g. content.published, media.uploaded)" is 11px slate-400 on white — fails AA (ratio ~2.5). | Use a darker muted-foreground (#475569 / slate-600) and bind via `aria-describedby`. |
| P1 | Secret field has no show/hide, no `type="password"`, no copy affordance. | Mask by default; provide eye-toggle. |
| P2 | Two competing `<h2>` titles ("Webhooks" list, "New webhook" form) — the existing-webhook list header duplicates the page h1. | Use just the page h1 + an "Add" CTA. |

### 7. `/settings/api-keys`

Screenshot: `09-api-keys.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s + duplicate `<h2>API Keys` under the page title. | Same as webhooks — drop the inner h2. |
| P1 | "Comma-separated list (e.g. editor, admin)" — same low-contrast hint pattern (slate-400 / 11px). | Same fix as webhooks. |
| P1 | No `role="alert"` on validation errors (same submit-empty test pattern). | Same as webhooks. |
| P1 | Newly-generated API key value (once shown) is presumably copy-pasteable only — verify it has a "Copy to clipboard" button with `aria-label="Copy API key"` and a `role="status"` confirmation. (Could not verify in this pass — no key was created.) | Verify and ensure the one-time secret reveal has accessible "Copy" + "Done" announcement. |

### 8. `/settings/sessions`

Screenshot: `10-sessions.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s. | Cross-cutting #1. |
| P1 | Sessions `<table>` has 5 `<th>` with **no `scope="col"`** — SR row-traversal is degraded. No `<caption>` and no `aria-label`. | Add `aria-label="Active sessions"` to the table, add `scope="col"` to each `<th>`. |
| P1 | No empty state; if no other sessions exist, table just shows zero rows. | "No other active sessions" empty state. |
| P2 | Revoke action — assumed to be destructive — needs a `<confirm>` dialog with `role="alertdialog"` and explicit "Revoke session" / "Cancel" buttons. Could not verify; no revoke was triggered. | Verify confirmation dialog semantics. |

### 9. `/settings/content-types` (form editor)

Screenshot: `11-content-types.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P1 | h1 mismatch: this route has **no page `<h1>`** — only the shell's "Content Operations" + an `<h2>Content Types` and `<h2>New content type`. The page can't be discovered as "Content Types" via heading navigation. | Add `<h1>Content Types`. |
| P1 | One live region detected (`liveRegions: 1`) — good — but the field-row 1 "Create new collection with 1 field." is **invisible** (ratio 1.00, identical fg/bg `rgb(112,112,123)`). It's effectively hidden text — visible-on-hover state stuck off, or a CSS regression. | Investigate the "fields summary" text — it currently has equal fg/bg colors. |
| P1 | The collection-name input is required (2 required fields detected) but no visible `*` indicator and no `aria-required="true"` confirmed on inputs without `required`. | Mark required fields visually AND via `aria-required`. |
| P2 | Form lacks an inline "Add field" repeater that announces additions; new-field rows likely insert without `aria-live` feedback. | Wrap the field list in `aria-live="polite"`. |
| P3 | Visual density is high — the dual-pane (list + form) on a single page makes the heading hierarchy hard to scan. | Consider tabbed sub-navigation or split route (list → edit). |

### 10. `/settings/content-types/visualizer`

Screenshot: `12-visualizer.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s ("Content Operations" + "Schema"). | Cross-cutting #1. |
| **P1** | **Three collection nodes are `<div role="group" tabindex="0">` with NO `aria-label`** — SR users hear "group" with no name. (The edge group does have an aria-label.) | `aria-label="Collection: articles, 5 fields"` on each node. |
| P1 | Zoom In / Zoom Out / Fit View buttons are accessible by name, but there is no live announcement of the resulting zoom level. | `aria-live="polite"` zoom-level status. |
| P1 | The visualizer is mouse-pan/drag heavy. Verify keyboard-only users can pan and select nodes — currently the only keyboard affordance is tabbing through nodes. No arrow-key panning. | Add keyboard pan/zoom shortcuts and document them. |
| P2 | "← Form editor" link uses Unicode arrow as the only navigation cue — fine, but consider `aria-label="Back to form editor"`. | Add aria-label. |
| P2 | Node icons + small caps ("REQ", "Aa", "T", "#") are decorative — verify they are `aria-hidden="true"` (otherwise SR users hear "REQ" without context). | Mark icons `aria-hidden="true"`; ensure semantics live on the parent. |

### 11. `/settings/i18n`

Screenshot: `13-i18n.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s. | Cross-cutting #1. |
| **P0** | **Page is functionally empty** — both "Backfill missing translations" and "Refresh" are `disabled`, and no body content renders beyond two `<h2>` cards. Looks broken/half-built. | Confirm whether this is "no locales configured" empty state or a real bug. If empty, render a clear "Configure your first locale" CTA. |
| P1 | The disabled buttons give no explanation of *why* they're disabled. | `aria-describedby` → "Configure locales to enable" hint. |

### 12. `/organization/settings`

Screenshot: `14-org-settings.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s. | Cross-cutting #1. |
| P1 | Three required-marked fields (`requiredFields: 2`) — visible asterisks present, but no `aria-required`. | Set `aria-required="true"` on the inputs. |
| P1 | Two `<h2>` headings — `Organization` and `Organization settings` — read as duplicate page titles. | Drop one or differentiate. |
| P2 | "Save" / submit feedback: no `role="status"` toast on save. | Add toast or inline `role="status"`. |

### 13. `/organization/members`

Screenshot: `15-members.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| **P0** | **Page is functionally empty** — no body content rendered below the h1. No member list, no "Invite member" CTA, no empty state. Looks broken. | Render the member list OR an empty state ("No members yet — invite your first teammate."). |
| P0 | Two `<h1>`s. | Cross-cutting #1. |

### 14. `/organization/invitations`

Screenshot: `16-invitations.png`

| Severity | Issue | Suggested fix |
|---|---|---|
| P0 | Two `<h1>`s + two `<h2>` ("Invitations" + "Invite member") — the `<h2>Invitations` is a duplicate of the page h1. | Drop redundant h2. |
| P1 | Two required fields lack `aria-required`. | Add. |
| P1 | No `role="alert"` on submit errors; no `role="status"` on successful invite. | Cross-cutting #2. |
| P2 | Empty state IS present (heuristic `hasEmptyState: true`) — good. |  |

---

## Cross-Cutting Issues

These hit ≥3 routes each and dominate the impact.

### Cross-cut #1 — App-shell hard-codes an `<h1>"Content Operations"` (P0, hits 14/15 routes)

Every authenticated route renders two `<h1>` elements. WCAG 2.1 best practice (and HTML5 spec guidance) is exactly one h1 per page. SR users using "h1" rotor navigation always land on the generic "Content Operations" first, masking the real page title. The shell h1 also defeats `document.title` semantics: visiting `/media` should let SR announce "Media library", not "Content Operations". **Fix:** convert the shell title to a visually-styled `<p>` or `<div>` (or render in a `<header>` with a class that looks like a heading), and let the page-level h1 own the document heading.

### Cross-cut #2 — Zero live-region infrastructure (P0/P1, every interactive route)

There are no `[aria-live]`, `[role="status"]`, `[role="alert"]`, sonner, react-hot-toast, or radix Toast containers anywhere in the DOM. Validation errors ("Required" on webhooks/api-keys) render visually but are completely silent to assistive tech. Successful actions (save record, create webhook, generate key, invite member) have no documented confirmation pattern either. **Fix:** install a single toast layer (sonner or radix-ui Toast) mounted in the root, with `role="status"` for success and `role="alert"` for errors. Wire every mutation success/failure through it.

### Cross-cut #3 — Hint text fails AA contrast (P1, hits ≥6 routes)

Every "helper text" below an input (e.g., "Comma-separated list…") and every sidebar group label (`WORKSPACE`, `SYSTEM`, `CONSOLE`) uses `oklch(0.552 0.016 285.938)` (≈ `#94a3b8` / slate-400) at 10–12px on white. Measured contrast ~2.5–2.9 — fails AA (4.5 required for small text). **Fix:** raise to `oklch(0.45 …)` / `#475569` (slate-600) which gives ~7:1; or restrict slate-400 to ≥18px text.

### Cross-cut #4 — Form inputs lack programmatic descriptions (P1, every form route)

`fieldsWithoutDescribedBy` is non-zero on every form route (3 on audit-log, 4 on content-types, 5 on webhooks, 4 on api-keys, 3 on org-settings, 2 on invitations). Help / error text exists in the DOM but is not linked to the input via `aria-describedby`. **Fix:** add `aria-describedby="<id-of-helper>"` to every input that has a sibling helper or error message.

### Cross-cut #5 — Duplicate `<h2>` titles repeat the page `<h1>` (P2, hits 5 routes)

Webhooks, API keys, Org settings, Invitations, and Content Operations all render an `<h2>` whose text duplicates the page `<h1>` (e.g., `<h1>Webhooks` + `<h2>Webhooks`). Hurts SR heading navigation. **Fix:** drop the redundant `<h2>` and use a visually-styled `<div>` to keep the layout boundary.

### Cross-cut #6 — Tables miss `scope="col"` and `<caption>` (P2, hits 3+ routes)

Real `<table>` elements (sessions, health) lack `<caption>` / `aria-label` and their `<th>` cells lack `scope="col"`. The data tables that are NOT real tables (content list) are even worse — they use divs with role attributes but inconsistent header/row association. **Fix:** prefer real tables; always add `<caption class="sr-only">` and `scope="col"`.

### Cross-cut #7 — Empty states are inconsistent (P2, hits 4 routes)

`/organization/members`, `/settings/i18n`, the media grid, and the audit-log filtered-empty case all render zero content with no explanatory text. **Fix:** standardise an `<EmptyState>` component (icon + title + description + CTA) used everywhere.

### Cross-cut #8 — Focus rings are inconsistent (P3, all routes)

Buttons get a 3px solid outline (good). Icon buttons get a 2px solid outline (good). Sidebar links get the **browser-default 1px / alpha-50% outline** because they have no app-level focus-visible styling. Keyboard-only sidebar users get a barely-visible focus indicator. **Fix:** add `:focus-visible` styles to all `<a>` in `nav` matching the button focus treatment.

### Cross-cut #9 — Search inputs have `aria-label` but no `aria-describedby` for hint text (P3, hits 2 routes)

`/media` and `/content/<collection>` search boxes have aria-labels (good) but unlinked hint text. Minor.

---

## Priority Ranking

### P0 — Broken or blocking
1. **App-shell hard-coded "Content Operations" h1** duplicates on every page (14/15 routes).
2. **No live-region / toast layer** — validation errors and success messages are silent to AT.
3. **`/organization/members` renders nothing** below the h1 — looks broken.
4. **`/settings/i18n` renders nothing actionable** — all controls disabled with no explanation.
5. **`/settings/webhooks` validation errors are silent** to screen readers (text appears but no `role="alert"`).

### P1 — WCAG AA violations
6. **`/settings/audit-log` filter inputs labeled only by placeholder** (collection, documentId, actorId).
7. **Hint text uses slate-400 on white** at 10–12px — fails AA contrast (≥6 routes).
8. **Sidebar group labels (WORKSPACE/SYSTEM/CONSOLE) fail AA contrast.**
9. **Visualizer collection nodes are `tabindex=0` groups with no `aria-label`.**
10. **`/content/$collection` list-row checkboxes have no `aria-label`** ("Select row N").
11. **Tables miss `scope="col"` and `<caption>`/`aria-label`** (sessions, health).
12. **Sort buttons miss `aria-sort` reflection** on column headers.
13. **Form fields miss `aria-describedby` linking to helper/error text** (every form route).
14. **Rich-text editor textarea has no accessible name.**
15. **Required fields lack `aria-required="true"`** (content-types, org-settings, invitations).
16. **Secret/API-key inputs are not masked** (no `type="password"`, no copy affordance).

### P2 — UX inconsistency
17. Login renders behind the global app shell.
18. Duplicate `<h2>` titles under page `<h1>` (webhooks, api-keys, org-settings, invitations).
19. Empty states inconsistent or missing (members, i18n, media grid, audit filtered).
20. Tabs lack `aria-controls` wiring on content list.
21. Filter forms have no submit button or explicit "Apply" affordance (audit-log).
22. Loading states absent — no skeletons during fetch.
23. Health / org-settings save actions have no visible "saving…" / success state.

### P3 — Polish
24. Sidebar link focus ring is the browser default 1px; buttons get a richer 3px ring — inconsistent.
25. Sort buttons read awkwardly to SR ("UPDATEDAT down").
26. Decorative node icons in visualizer should be `aria-hidden`.
27. "No asset selected" placeholder is an `<h2>` — semantically over-strong for a placeholder.

---

## Top 10 Fixes (impact-to-effort)

| # | Fix | Impact | Effort | ROI |
|---|---|---|---|---|
| 1 | **Remove the global "Content Operations" h1 from the app shell** (turn it into a styled `<p>` / `<div>`). | Fixes 14/15 routes at once; restores SR heading navigation. | XS (1 line + style). | ★★★★★ |
| 2 | **Install a single toast/live-region layer** (sonner or radix Toast) and route mutation success/failure through it. | Fixes every form route's silent-success/error problem; baseline WCAG win. | S (1 file + a few call-sites). | ★★★★★ |
| 3 | **Replace slate-400 hint text with slate-600** (`oklch(0.45 …)`) and add an `aria-describedby` link from inputs to their hints in the same pass. | Fixes 6+ routes; resolves both contrast and field-description issues. | S (token swap + a `<HelperText id>` component). | ★★★★★ |
| 4 | **Add `aria-label` to the three placeholder-only audit-log filter inputs** (and audit other inputs for the same anti-pattern). | Fixes a hard AA failure on a key route. | XS. | ★★★★★ |
| 5 | **Add `aria-label="Collection: {name}, {n} fields"` to visualizer collection nodes.** | Makes visualizer SR-usable. | XS. | ★★★★ |
| 6 | **Decide whether `/organization/members` is empty by design or broken** — render either the list or an empty state. | Removes a P0 broken-looking page. | S (depends on missing data layer). | ★★★★ |
| 7 | **Drop the duplicate `<h2>` page titles** under the page h1 on webhooks, api-keys, org-settings, invitations. | Cleans up heading hierarchy on 4 pages. | XS. | ★★★★ |
| 8 | **Add `scope="col"` to every `<th>` and `<caption class="sr-only">` to every `<table>`.** | Fixes SR navigation in sessions, health. | XS. | ★★★★ |
| 9 | **Add row-checkbox `aria-label`s on the content list** ("Select all visible" exists; "Select row N" missing). | Restores SR usability for bulk actions. | S. | ★★★ |
| 10 | **Match sidebar link focus rings to the button focus ring** (2-3px solid ring on `:focus-visible`). | Closes the inconsistent-focus-treatment gap; improves keyboard wayfinding. | XS (1 utility class in the sidebar). | ★★★ |

---

## Methodology Notes

- Audit JSON for each route is preserved at `/tmp/a11y-results.jsonl` (not checked into the repo).
- Contrast was measured by resolving every `color` and ancestor `background-color` through a 1×1 canvas (which normalises modern `oklch()` / `lab()` syntax into sRGB), then computing WCAG 2.1 relative luminance and the 4.5:1 / 3:1 thresholds.
- Heading hierarchy, label association, accessible names, live regions, and table semantics were checked programmatically against the live DOM after `networkidle`.
- Focus rings were inspected by `el.focus()` + `getComputedStyle().outline` / `boxShadow`.
- No source files were modified. All screenshots saved under `docs/screenshots/a11y/`.
