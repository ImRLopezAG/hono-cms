# Handoff — Admin Rebuild + Cross-Runtime E2E

**Date:** 2026-05-23
**Status:** Active. Multi-session work. Read this first if you pick this up cold.

## North Star

Build production-grade headless CMS in the spirit of `docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md`:

- `createCMS(config)` is **infra-as-code**. Any host that can receive a Web `Request` and return a `Response` must serve the CMS unchanged — Node, Cloudflare Workers, Vercel Edge, Next.js App Router, Next.js page handlers, TanStack Start, Bun, Deno, Hono standalone, any future runtime.
- Admin must be **Strapi-grade**: a real database/content workspace, not a card grid. The schema editor must feel like **chartdb** — drag-on-canvas, draw-relations.
- Stack constraints from `AGENTS.md`:
  - `@tanstack/{query,router,table,virtual,form,pacer,store|jotai,hotkeys}`
  - `nuqs`, `date-fns`, shadcn/ui components
  - **No** bare-`<form>` + `FormData` plumbing. Every form on `useForm`.
  - **No** module-level `QueryClient`. Provider lives at root and routes consume via context.

## Reference Repos (locally cloned, depth=1)

- `/Users/imrlopez/dev/monorepo/cms/.references/chartdb/` — db-diagram builder. Mine `src/pages/editor-page/canvas/` for our visualizer.
- `/Users/imrlopez/dev/monorepo/cms/.references/strapi/` — full Strapi admin. Mine `packages/core/admin/admin/src/` for view structure (Content Manager, Media Library, Settings, etc.). **Do not copy code**; redo each view in our TanStack stack.

## What's Done (do not redo)

| Area | Status | Evidence |
|---|---|---|
| Core P1 closures (G-1, G-2, G-3) | done | `packages/core/src/content/{ai-provider,drizzle-translation-store}.ts`, `packages/core/src/audit/drizzle-audit-store.ts` |
| createCMS live mutation on content-type build | done | `packages/core/src/create-cms.ts` |
| Newsroom example with full memory adapter stack + SchemaWriter | done | `examples/newsroom/src/dev-server.ts` |
| AdminApp.tsx decomposed | done | 2,780 → 103 lines, 18 view files in `apps/admin/src/components/views/` |
| QueryClient in main.tsx + router context | done | `apps/admin/src/{main.tsx,router.tsx,lib/query-client.ts,lib/query-keys.ts}` |
| useForm migrated for: add-collection, relation-popover, webhooks, api-keys, audit-filters | done | `apps/admin/src/components/{visualizer/*,views/{Webhooks,ApiKeys,Audit}View.tsx}` |
| Schema visualizer (xyflow + dagre) | done — basic version | `apps/admin/src/components/visualizer/` |
| Cross-package typecheck + unit tests | green | 22/22 packages, ~290 tests |
| Newsroom E2E via agent-browser (Node) | done | `docs/admin-full-sweep.md` |
| Editorial pass on Content / Health / Visualizer | done | `apps/admin/src/components/views/admin-shell.css` + visualizer.css |

## What's NOT Done (the work this handoff is about)

### Track A — Cross-runtime E2E (real dev servers, not just typecheck)

Goal: prove `createCMS` is truly runtime-agnostic.

- [ ] **A1. Next.js E2E** — boot `examples/next-app` with `next dev`, wrap `createCMS` in `app/api/cms/[...route]/route.ts`. Drive the admin against it via agent-browser. Verify: content CRUD, draft/publish, webhook delivery, audit log, content-type live mutation. Replace the current typecheck-only `next-app` test.
- [ ] **A2. Cloudflare Worker E2E** — `wrangler dev` against `examples/cloudflare-worker`. Use Miniflare's bindings for D1 + R2 in-memory. Same admin sweep.
- [ ] **A3. Vercel Edge E2E** — `vercel dev` or local edge runner. Same sweep.
- [ ] **A4. TanStack Start example** — new `examples/tanstack-start/`. Boot via `vinxi dev`. Same sweep. Adds Start as a first-class runtime.
- [ ] **A5. Bun standalone example** — new `examples/bun-server/` with `Bun.serve({ fetch: cms.fetch })`. Same sweep.
- [ ] **A6. Cross-runtime matrix doc** — `docs/cross-runtime-matrix.md`: view × runtime × test status. Updated from each E2E pass.

### Track B — Plan-by-plan real verification via `/ce-code-review`

Goal: don't ship false-positive completion. Each plan in `docs/plans/2026-05-16-NNN-feat-*-plan.md` gets a fresh review against the live code.

- [ ] **B1. Plan 001 — Monorepo foundation** review
- [ ] **B2. Plan 002 — Core library** review
- [ ] **B3. Plan 003 — DB adapter interface** review
- [ ] **B4. Plan 004 — Auth integration** review
- [ ] **B5. Plan 005 — Schema system** review
- [ ] **B6. Plan 006 — Content API + RBAC** review
- [ ] **B7. Plan 007 — Admin SPA** review (will be largely superseded by Track C)
- [ ] **B8. Plan 008 — Storage adapters** review
- [ ] **B9. Plan 009 — Cache layer** review
- [ ] **B10. Plan 010 — Jobs/crons** review
- [ ] **B11. Plan 011 — CLI tooling** review
- [ ] **B12. Plan 012 — OpenAPI + Scalar** review
- [ ] **B13. Plan 013 — AI i18n** review
- [ ] **B14. Plan 014 — Audit log** review
- [ ] **B15. Plan 015 — Webhooks** review
- [ ] **B16. Plan 016 — Draft/publish state machine** review
- [ ] **B17. Plan 017 — Relations + SDK types** review
- [ ] **B18. Plan 018 — Health checks** review

For each: spawn `/ce-code-review` on the plan's IU-cited files, list real bugs, fix them.

### Track C — Admin rebuild (Strapi UX + chartdb visualizer)

Goal: replace the current 13 admin views with a coherent Strapi-clone built on the TanStack stack from `AGENTS.md`.

- [ ] **C1. Design system extraction** — pull `tokens.css` + Tailwind theme from chartdb + Strapi visual language. Inter Variable + JetBrains Mono. Slate neutrals + indigo accent. No new card stacking.
- [ ] **C2. Shell rebuild** — sidebar (Strapi-style: Content Manager / Media / Settings groups with nested sections), top-bar (workspace switcher + search), main outlet. All routes file-based via TanStack Router with `loaders` (not just forwarders).
- [ ] **C3. Content Manager rebuild** — left rail of collections (Strapi pattern), table view with TanStack Table + Virtual + filtering via `nuqs`, side editor or full-page editor per record. Replace current `ContentWorkspace.tsx`.
- [ ] **C4. Schema Builder = chartdb-clone** — full `xyflow` canvas with: drag-create collection, click-to-edit field inline, drag-to-create relation with cardinality popover (already partial), context-menu, minimap, area grouping (chartdb has area-nodes for grouping collections). Replace current `VisualizerCanvas.tsx`.
- [ ] **C5. Media library** — virtual grid via TanStack Virtual, upload via existing `/api/media/presign`. Replace current `MediaView.tsx`.
- [ ] **C6. Settings shell** — Strapi-style nested settings sidebar: General / Webhooks / API Tokens / Roles / Users / Audit Log / i18n / Single Sign-On. Each section is its own route file.
- [ ] **C7. Roles & permissions UI** — Strapi has a powerful matrix editor (per-collection × per-operation × per-field). Build it on TanStack Table + Form + Store/jotai.
- [ ] **C8. Internationalization UI** — locale switcher in top bar, per-record locale panel, backfill modal. Strapi has this; redo on our stack.
- [ ] **C9. Command palette** — kbar/`cmdk` driven, jumps between collections + records + settings. Use `@tanstack/react-hotkeys` for global shortcuts.
- [ ] **C10. Visual design pass** — use `frontend-design` + `web-design-guidelines` + `ce-frontend-design` skills end-to-end on every view. Capture screenshots before/after.

### Track D — Provider integrations / docs

- [ ] **D1. Document `createCMS` as IaC** — clarify in docs that the CMS is a Web `Request → Response` library; provider docs (Next, Tanstack Start, Hono, Bun, CF, Vercel, ElysiaJS-as-host) each show a 5-line snippet.
- [ ] **D2. ElysiaJS host adapter** — Elysia is a Bun-native framework with its own Request/Response handling. Verify our `createCMS(req).fetch` works as a downstream handler in an Elysia app. New `examples/elysia-host/`.

## Styling rule (added 2026-05-23 by user)

**Use Tailwind CSS utilities for all NEW component styling.** The admin already has Tailwind 4 (`@tailwindcss/vite` 4.3.0) + `tailwind-merge` + shadcn's `cn()` helper at `apps/admin/src/lib/utils.ts`. Tokens from `apps/admin/src/styles/tokens.css` are available as CSS vars and can be referenced via Tailwind's arbitrary value syntax `bg-[color:var(--color-surface)]`. Do not hand-roll new `.css` rule blocks for component styling — use class composition instead. Existing `visualizer.css` and `admin-shell.css` stay as-is (back-compat aliases) but new work flows through utilities.

## Skills to use

- `frontend-design` — when building any new visual component
- `web-design-guidelines` — review every redesigned page
- `ce-frontend-design` — second-pass design verification with screenshots
- `ce-code-review` — for Track B (per-plan review)
- `ce-work` — to execute the implementation tracks
- `agent-browser` — for every E2E pass
- `handoff` — to compact this doc forward when context fills again
- `caveman` — keep responses terse

## Reference paths quick-jump

- chartdb canvas: `.references/chartdb/src/pages/editor-page/canvas/canvas.tsx` (~1900 lines)
- chartdb table node: `.references/chartdb/src/pages/editor-page/canvas/table-node/table-node.tsx`
- chartdb relationship edge: `.references/chartdb/src/pages/editor-page/canvas/relationship-edge/relationship-edge.tsx`
- chartdb domain types: `.references/chartdb/src/lib/domain/{diagram,db-table,db-field,db-relationship}.ts`
- Strapi admin root: `.references/strapi/packages/core/admin/admin/src/StrapiApp.tsx`
- Strapi Content Manager: `.references/strapi/packages/core/content-manager/admin/src/`
- Strapi Settings: `.references/strapi/packages/core/admin/admin/src/pages/Settings/`
- Strapi Permissions matrix: `.references/strapi/packages/core/admin/admin/src/components/Permissions/`

## Bug register (real bugs surfaced; fixed but worth knowing)

1. `CorsOrigin: boolean` was typed but unhandled in `resolveCorsOrigin` → 500 on preflight. **Fixed.**
2. `/content` and `/settings/content-types` parent routes rendered child component directly instead of `<Outlet />` → child routes shadowed. **Fixed.**
3. `POST /cms/content-types` wrote file but didn't mutate `config.collections` → visualizer + REST showed stale schema. **Fixed.**
4. `MemoryAuditStore` cursor was raw id, not base64 opaque → leaked internal id. **Fixed.**
5. Newsroom dev-server missing storage/cache/mediaStore/apiKeyStore → media presign + preview tokens + api-keys all 404. **Fixed.**

## Don't-cut-corners checklist for each track

Before marking any Track A item complete:
- [ ] `bun --filter @hono-cms/example-<runtime> typecheck` exit 0
- [ ] Live dev server boots and `curl /cms/health/live` returns 200
- [ ] agent-browser drives full Strapi-style entity creation flow (create collection → create record → publish → REST verify) against THIS runtime, screenshots saved to `docs/screenshots/`
- [ ] Webhook delivers successfully to httpbin.org during the run
- [ ] Audit log records all writes
- [ ] Console errors checked: zero
- [ ] Network failures checked: zero 4xx/5xx
- [ ] Updated `docs/cross-runtime-matrix.md`

Before marking any Track C item complete:
- [ ] Built with TanStack packages from `AGENTS.md`, not hand-rolled
- [ ] All forms via `useForm` with real validators
- [ ] Page has eyebrow + h1 + subtitle hierarchy
- [ ] No card-inside-card layout
- [ ] AA contrast on all text labels
- [ ] At least one motion budget item (entrance, hover, or transition)
- [ ] `web-design-guidelines` review pass before marking done
- [ ] agent-browser screenshot saved

## How to resume after compaction

1. Read this file in full.
2. `TaskList` to see current state.
3. Pick the next un-blocked task by ID order.
4. If servers need to be running: `cd examples/newsroom && PORT=8787 bun src/dev-server.ts &` and `cd apps/admin && VITE_CMS_API_URL=http://127.0.0.1:8787 bun --bun vite --host 127.0.0.1 --port 5173 &`.
5. Auth token: `localStorage["hono-cms:auth-token"] = '"admin"'` (JSON-encoded).
