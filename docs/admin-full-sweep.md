# Admin Full Sweep — U21 Browser Verification

Date: 2026-05-23
Driver: agent-browser 0.27.0 + curl
Backend: newsroom dev server (in-memory adapters: db, storage, cache, mediaStore, apiKeyStore, jobs) on 127.0.0.1:8787
Admin: Vite dev on 127.0.0.1:5173

## Pages exercised in the browser

| Route | Heading | Form interaction | Result |
|---|---|---|---|
| `/login` | Login | Token entry + localStorage seed | ✅ |
| `/content/articles` | "CONTENT" / `articles` | Created `Final sweep test` article | ✅ persisted |
| `/settings/health` | "SYSTEM" / `Health` | Read 8 subsystems, all OK | ✅ table renders |
| `/settings/audit-log` | "Audit Log" | Filters (collection, operation, dates, limit) on `useForm` | ✅ |
| `/settings/webhooks` | "Webhooks" | Created `Test webhook` → httpbin.org via `useForm` | ✅ persisted |
| `/settings/api-keys` | "API Keys" | Created `Editor key v2` via `useForm` | ✅ persisted |
| `/settings/sessions` | "Sessions" | Read | ✅ renders |
| `/settings/content-types` | "Content Types" (form) | Switched between authors/articles | ✅ |
| `/settings/content-types/visualizer` | "CONTENT TYPES" / `Schema` | Created `tags` collection via dialog | ✅ live mutation |
| `/settings/i18n` | "i18n" | Renders | ✅ |
| `/organization/settings` | "Organization" | Read default org | ✅ |
| `/organization/members` | "Members" | Read (empty list) | ✅ |
| `/organization/invitations` | "Invitations" | Renders | ✅ |

## Backend integrations exercised end-to-end via curl

| Plan | Endpoint | Test | Result |
|---|---|---|---|
| 005 Content CRUD | `POST /api/articles` | Created "Preview Test" | ✅ 200 |
| 016 Draft/publish | `POST /api/articles/:id/publish` | Status flipped to published | ✅ |
| 016 Preview tokens | `POST /api/preview-tokens` | 64-char hex token + previewUrl + expiresAt | ✅ |
| 009 API keys | `POST /cms/settings/api-keys` | Returned one-time secret `cms_live_…` | ✅ |
| 009 API key auth | `GET /api/articles` with `Authorization: Bearer cms_live_…` | 200 | ✅ |
| 015 Webhooks | `POST /cms/settings/webhooks` then publish triggers delivery | `content.published` delivered to httpbin.org with HTTP 200 | ✅ |
| 014 Audit log | `GET /cms/audit-log` after operations | Entries with diff + opaque base64 cursor | ✅ |
| 005 Media presign | `POST /api/media/presign` | Returned uploadId + key + uploadUrl + expiresAt | ✅ |
| 008 Content-type builder | `POST /cms/content-types` | File written to disk + in-memory mutation reflected via `GET /cms/schema` | ✅ |
| 018 Health | `GET /cms/health` | 8 subsystems all `ok`, latency reported | ✅ |
| 006 GraphQL | `POST /graphql` | Verified in U14 functional report | ✅ |
| 012 OpenAPI | `GET /cms/openapi.json` | Spec served with ETag caching | ✅ |

## Bugs fixed by this sweep

1. **`api_key_store_not_configured`** when posting from the redesigned form — newsroom dev-server didn't wire `apiKeyStore`. Added `MemoryApiKeyStore`.
2. **Media presign / preview tokens / cache** all 404'd in the old dev-server because `storage`, `cache`, and `mediaStore` were missing. Wired `createMemoryStorage()`, `createMemoryCache()`, `MemoryMediaStore`.

After these fixes every integration that runs without third-party services is functional in the newsroom dev server.

## Forms migrated to TanStack `useForm` (U19)

- `apps/admin/src/components/views/WebhooksView.tsx` — name + url + events + secret + enabled, real-time validators
- `apps/admin/src/components/views/ApiKeysView.tsx` — name + userId + roles + enabled
- `apps/admin/src/components/views/AuditView.tsx` — collection, operation, actorId, from, to, limit
- `apps/admin/src/components/visualizer/AddCollectionDialog.tsx` — already on `useForm`
- `apps/admin/src/components/visualizer/RelationConnectionDialog.tsx` — cardinality popover, also `useForm`

The original `*InputFromForm(FormData)` helpers stay exported (tests still consume them).

## TanStack idiomaticity improvements (U15 + U18)

- `QueryClient` now created at `main.tsx` and passed to `createAdminRouter({ queryClient })` as Router context — no more module-level singleton
- `RouterProvider` no longer wraps a sibling `QueryClientProvider`; both lift to `main.tsx`
- Centralised query key factory at `apps/admin/src/lib/query-keys.ts`
- `AdminApp.tsx` reduced from 2,780 → 103 lines (pure barrel re-exports); each view is now its own file in `apps/admin/src/components/views/`

## Design language (U16 + U20)

Applied editorial composition to the visualizer, Content view, and Health view:
- Eyebrow + h1 + subtitle header rhythm
- Single indigo accent on slate neutrals (`--hcms-*` variables in `admin-shell.css`)
- Status pills with status-dot prefix
- Monospace tabular labels for kinds and latencies
- AA-contrast labels (#475569 minimum on white)
- No card stacks — the page IS the page

## Screenshots

- `21-final-state.png` — visualizer with 4 collections, 2 edges (pre-restart)
- `22-content-redesigned.png` — Content view with editorial header
- `23-health-redesigned.png` — Health table with status pills
- `24-audit-redesigned.png` — Audit log filters on useForm
- `25-webhooks-redesigned.png` — Webhooks create on useForm
- `26-apikeys-redesigned.png` — API keys create on useForm
- `27-visualizer-final.png` — visualizer post-restart
- `28-new-collection-dialog.png` — Strapi-style "New collection" dialog
- `29-tags-created.png` — `tags` added live to canvas
- `30-article-saved.png` — Article saved through redesigned Content view
- `31-webhook-created.png` — Webhook persisted
- `32-apikey-created.png` — API key persisted (after MemoryApiKeyStore wiring)
- `33-final-hero.png` — final visualizer state

## Workspace health at end of sweep

- 22/22 packages typecheck clean
- 88/88 admin tests pass (all view tests still resolve via the AdminApp.tsx barrel)
- 115/115 core tests pass
- 41/41 schema tests pass
- ~290 total tests workspace-wide all green
