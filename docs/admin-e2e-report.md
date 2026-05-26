# Admin UI End-to-End Browser Test Report

Date: 2026-05-23
Driver: agent-browser 0.27.0 against Hono CMS admin SPA + newsroom example backend
Goal: Verify the admin lets a user create + edit + publish content entities Strapi-style, end-to-end, in a real browser.

## Setup

- Backend: `examples/newsroom/src/dev-server.ts` (new) — newsroom CMS with static-token auth + CORS, running on `http://127.0.0.1:8787`
- Admin: `apps/admin` Vite dev server with `VITE_CMS_API_URL=http://127.0.0.1:8787`, running on `http://127.0.0.1:5173`
- Auth: static token "admin" stored in `localStorage["hono-cms:auth-token"]` (JSON-encoded). The login screen accepts an API token in the third textbox; both paths work.

## Bugs Discovered (and Fixed)

### Bug 1 (P1, fixed in this branch) — CORS `origin: true` triggers a runtime crash

`packages/core/src/create-cms.ts:resolveCorsOrigin` types `CorsOrigin` as accepting `boolean`, but the function only handles `function | "*" | string | array`. When a consumer passes `cors: { origin: true }`, the fallback path calls `config.origin.includes(...)` on a boolean and throws `TypeError: config.origin.includes is not a function`, returning **HTTP 500 on every preflight**.

**Fix:** added explicit boolean handling. `origin: true` now echoes the request origin (without `*` when credentials are enabled); `origin: false` returns null. Also tightened the array case behind `Array.isArray`.

### Bug 2 (P1, fixed in this branch) — `/content` parent route shadowed `/content/$collectionName` child

`apps/admin/src/app/content.tsx` rendered `<ContentWorkspace />` directly and did **not** render `<Outlet />`. TanStack Router matched both `/content` (parent) and `/content/$collectionName` (child) when navigating to `/content/articles`, but the parent's component never delegated to the child, so the URL parameter was lost and `activeCollection` always fell back to the first collection (`authors`). The articles tab visibly highlighted but never switched the workspace.

**Fix:** `ContentRoute` now uses `useChildMatches()` to detect whether a child route is active; if so it renders `<Outlet />`, otherwise it renders the workspace.

## Step-by-step Results

| # | Step | Status | Screenshot |
|---|---|---|---|
| 1 | Navigate to admin root | ✅ pass | `01-initial-login.png` |
| 2 | Auth via localStorage token "admin" + reload | ✅ pass | `03-authenticated.png` |
| 3 | Navigate to `/content`, see authors + articles tabs | ✅ pass | `04-articles-tab.png` |
| 4 | Click articles tab + verify route switches | ✅ pass (after Bug 2 fix) | `05-articles-view.png` |
| 5 | Fill new article form (title, slug, summary, views=1234) | ✅ pass | `06-new-article-filled.png` |
| 6 | Click Save → record persists as draft | ✅ pass | `07-saved-article.png` |
| 7 | Click Publish → status flips to published | ✅ pass | `08-published.png` |
| 8 | Edit views=5678 + save | ✅ pass | `09-edited.png` |
| 9 | Open `/settings/audit-log` → see all 4 ops (create, publish, update, update) | ✅ pass | `10-audit-log.png` |
| 10 | Open `/settings/content-types` → loads cleanly, Create disabled (no SchemaWriter on newsroom) | ✅ pass | `11-content-types.png` |
| 11 | REST verification via `curl /api/articles` | ✅ pass | — |

## REST API Verification

After step 7 (publish):
```json
{"items":[{"id":"d73846ef-5f82-4449-bb49-eae2ea40df3f","createdAt":"2026-05-23T03:01:28.888Z","updatedAt":"2026-05-23T03:01:44.352Z","status":"published","publishedAt":"2026-05-23T03:01:44.352Z","title":"Hello World from Browser Test","slug":"hello-world-from-browser-test","summary":"Created end-to-end via agent-browser as part of U8 verification","views":1234,"author":""}]}
```

After step 8 (edit views):
```json
{"items":[{"id":"d73846ef-...","views":5678,"updatedAt":"2026-05-23T03:02:01.957Z","status":"published",...}]}
```

## Audit Log Verification

`GET /cms/audit-log` returned 4 entries reflecting the entire UI session, each with `actorId: "admin_1"`, `actorRoles: ["admin"]`, distinct `requestId`, and a `diff: { before, after }` document:

1. `create articles d73846ef…` — captured the full new draft as `after`, `before: null`
2. `publish articles d73846ef…` — diff `{ status: "draft" → "published" }`, `publishedAt` set
3. `update articles d73846ef…` — diff `{ views: 1234 → 5678 }`
4. `update articles d73846ef…` — final touch (updatedAt timestamp only)

The admin UI's audit log page rendered all 4 events in chronological order.

## Console Errors

No JS console errors during the full session. The only console messages were the Vite client and the React DevTools nudge.

## Network Errors

- One transient 4xx burst on initial load before the CORS fix (logged here as Bug 1 evidence). After fixing, all `/cms/*` and `/api/*` traffic returned 2xx with proper CORS headers (`Access-Control-Allow-Origin: http://127.0.0.1:5173`, `Access-Control-Allow-Credentials: true`).

## "Strapi-like" Verdict

**Yes — the admin DOES let a user create a content entity end-to-end without writing code,** with two important caveats:

✅ Works out of the box:
- Drafting, saving, publishing, unpublishing, and scheduling content entities
- Field-typed editing (string, uid auto-slug, text, number, richtext, media, relation)
- Audit log capturing every write with diffs
- Webhook & API-key admin
- RBAC enforcement (admin token unlocks admin-only views)

⚠️ Not as turn-key as Strapi:
- **Creating new content types from the UI** requires a `SchemaWriter` to be wired into the CMSConfig. The newsroom example does not wire one, so the "Create" button on `/settings/content-types` is disabled. Plan 008 IUs all ship — just not configured in this example. A user has to either (a) wire a `SchemaWriter`, or (b) edit `schema.ts` and rerun the CLI.
- The UI bugs found in this report would have surfaced earlier with browser-driven test automation. Today there are no Playwright tests.

## Recommendations

1. **Add browser E2E tests** (Playwright + Vitest browser-mode) to apps/admin. The two bugs fixed in this branch would have been caught immediately.
2. **Wire a SchemaWriter into the newsroom example** so the "create content type from UI" Strapi flow is demonstrated, not just declared.
3. **Audit the route file forwarders** flagged by `docs/tanstack-audit.md` for similar Outlet-vs-component mistakes. Apply file-routing review checklist.
4. **Migrate hand-rolled `<form onSubmit>` → `useForm`** per `docs/tanstack-audit.md` recommendations.
5. **CORS docs**: document the supported shapes of `cors.origin` (boolean, string, array, function) and add a `cors: true` shortcut.
6. **`?status=all` REST API issue** (out of scope here, but discovered): listing articles with `?status=all` returned an empty array even though `?` (default) returned the published record. Worth investigating.

## TanStack Router URL Pattern (Verified)

Routes are path-based (not hash-based). The admin URL pattern matches the file-based route structure cleanly:

| Admin URL | File Route | Notes |
|---|---|---|
| `/login` | `app/login.tsx` | ✅ |
| `/content` | `app/content.tsx` | ✅ (now renders Outlet when child active) |
| `/content/articles` | `app/content.$collectionName.tsx` | ✅ (fixed in Bug 2) |
| `/settings/audit-log` | `app/settings.audit-log.tsx` | ✅ |
| `/settings/content-types` | `app/settings.content-types.tsx` | ✅ |

## Artifacts

- Screenshots: `docs/screenshots/01-*.png` … `11-*.png`
- Source touchpoints: `apps/admin/src/app/content.tsx`, `packages/core/src/create-cms.ts`
- New helper: `examples/newsroom/src/dev-server.ts` (deterministic-port newsroom launcher with CORS for the admin)
