---
title: "feat: Admin SPA — React + TanStack + Jotai + Hono RPC Client"
date: 2026-05-16
plan: "007"
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#5 Decoupled Static Admin SPA", "#3 UI-Generated Schema"]
---

# feat: Admin SPA — React + TanStack + Jotai + Hono RPC Client

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 3
**Research inputs used:** skill review, framework docs, architecture review, performance review, security review

### Key Improvements

1. Add explicit shadcn preset-based scaffolding with your requested CLI command.
2. Tie virtualization to server-driven pagination, cache eviction, and stable focus/selection state.
3. Surface missing auth-loss, autosave, and schema-builder failure flows before implementation.

## Summary

The `@hono-cms/admin-spa` is the entire developer-facing and editor-facing UX for the CMS. It is a Vite-built React 18 TypeScript SPA deployed independently to Cloudflare Pages, Vercel Static, or any CDN — no admin code ever enters the API worker bundle. It communicates with the CMS API exclusively through the Hono RPC typed `hc` client, giving every API call full end-to-end TypeScript type safety without code generation. Because better-auth only ships server API endpoints and no auth UI, the admin SPA owns and builds every auth page — login, register, forgot-password, magic-link, email-OTP, 2FA setup, and 2FA verify.

The stack is chosen for precision, not convenience: TanStack Router for file-based type-safe routing, TanStack Query for server state around `hc` calls, TanStack Table for schema-derived column definitions, TanStack Form for schema-driven form rendering (no hand-written JSX per content type), TanStack Virtual for O(1)-cost lists regardless of row count, TanStack HotKeys for type-safe keyboard shortcuts, TanStack Pacer for debounced auto-save and throttled live-search, and Jotai for atomic UI state that does not trigger re-render waterfalls. This plan is Plan 007 of 18 — it covers only `apps/admin/`; the API (`packages/core`), auth integration (`packages/auth`), and schema primitives (`packages/schema`) are covered in earlier plans and are consumed here as type-only imports.

---

## Problem Frame

Strapi's admin panel is bundled into the same Node.js process as the API — it cannot be deployed independently, edge-cached, or maintained separately. The bundle contributes to the Worker size limit and every admin change requires a full API redeploy. The new CMS admin must:

1. Deploy to a CDN independently of the API worker, enabling separate deployment cadences and free edge caching.
2. Be fully type-safe against the API with zero codegen — one `import type` gives the admin full IDE support for every route.
3. Render forms for any content type without hand-written form JSX — the schema drives the form, not vice versa.
4. Handle 10-row and 10,000-row content lists with identical code.
5. Own all auth pages, since better-auth ships only backend endpoints.

---

## Scope Boundaries

### In scope
- `apps/admin/` — complete Vite SPA application
- All auth pages (login, register, forgot-password, magic-link, verify-email, 2FA setup, 2FA verify)
- Organization management pages (org settings, members, invitations)
- Content list and edit pages (schema-derived, covers any collection)
- Media library (`/media`, `/media/:id`)
- Content-Type Builder UI (dev-only editing, prod read-only)
- Settings pages: API keys, webhooks, audit log, health, i18n
- Jotai atom definitions and Provider setup
- Vitest test configuration and component test patterns

### Deferred to Follow-Up Work
- Real-time collaboration / live presence on edit forms (SSE/WebSocket — not Workers default; tracked separately)
- Rich text editor plugin ecosystem (Tiptap extension marketplace) — base Tiptap integration is in-scope; extensions are follow-up
- Admin UI theming / white-label (design token system) — post-MVP
- Mobile-responsive admin layout — progressive enhancement pass after desktop-first build
- E2E Playwright tests — separate plan; this plan covers component and integration tests only

### Outside this product's identity
- The CMS API implementation (`packages/core`, `packages/auth`, `packages/schema`) — consumed here, not built here
- Public-facing frontend frameworks or starter templates — separate packages
- Native mobile admin app — not planned

---

## Key Technical Decisions

### 1. Independent SPA Deployment (not bundled with API)

The admin SPA is a static artifact. Deployed to Cloudflare Pages or Vercel Static, it is served from the CDN edge with aggressive cache headers (`Cache-Control: public, max-age=31536000, immutable` on hashed assets). Benefits:

- **No bundle size limit**: Cloudflare Workers have a 10 MB compressed bundle limit. The admin SPA including TanStack, Tiptap, and all other dependencies would exceed this for any non-trivial CMS. Independent deployment removes the limit entirely.
- **Independent deployment cadence**: Admin UI updates deploy without touching the API worker and without invalidating worker caches.
- **CDN edge delivery**: Static JS/CSS is served from hundreds of PoPs at < 20ms globally, regardless of where the API worker runs.
- **Zero security surface in the API**: The admin bundle contains no server-side logic, no DB credentials, no internal API details beyond what the public `CMSApp` type declares.

The tradeoff is CORS configuration between the SPA origin and the API origin (covered in U1 and U2).

### 2. TanStack Form for Schema-Derived Forms

TanStack Form is headless — it manages form state, validation, dirty tracking, and submission without imposing any rendering. This makes it the only viable choice for schema-derived forms where the field list is determined at runtime from a `CollectionDefinition`. Alternatives:

- **React Hook Form**: Controller-based API works well for static forms; dynamic field arrays require `useFieldArray` which is more complex to drive from an external schema definition. Validation integration with Zod works but is wired via a resolver adapter rather than natively.
- **Formik**: Aging API with known performance issues for large forms; no native TypeScript-first design.
- **TanStack Form**: Native TypeScript-first. `field.state`, `field.handleChange`, and `form.handleSubmit` are fully typed from the schema. `form.setFieldValue` is typed against the value shape. Validation accepts a Zod schema directly — the same Zod object the API already uses for collection field validation can be passed to the form without adaptation. Field registration is dynamic — a `fields.map()` over the `CollectionDefinition.fields` array produces a fully type-safe set of registered fields.

### 3. Jotai for UI State

Jotai atoms are the right primitive for the admin's UI concerns:

- **No re-render waterfalls**: Each atom has isolated subscribers. `selectedItemsAtom` changing does not re-render the sidebar. Zustand stores and React Context both propagate to all subscribers on every update — at admin scale (sidebar + table + toolbar all mounted) this causes visible jank.
- **No Redux overhead**: Redux Toolkit requires action types, reducers, selectors, and slice files for what is fundamentally transient UI state (is the sidebar expanded? what's selected?). Jotai atoms are defined in one line.
- **Derived atoms are trivial**: `unsavedChangesAtom` can be derived from the form's dirty state without additional wiring. `mediaPickerStateAtom` can be a complex object atom with a simple `atom({ open: false, fieldId: null, resolve: null })` definition.
- **Provider is opt-in**: Jotai's default store works without a Provider at the root; the explicit Provider in `main.tsx` is a best practice for testability — tests can inject a fresh store per test.

### 4. TanStack Virtual for Content Lists

TanStack Virtual renders only the DOM nodes visible in the viewport. For a content list with 10,000 rows, TanStack Table + Virtual renders roughly 20–30 `<tr>` elements regardless of total row count. This is not an optimization applied after the fact — it is the default rendering strategy. Benefits:

- A 10-row list and a 10,000-row list use identical component code with zero branching.
- Scroll performance is constant regardless of dataset size.
- Memory usage is bounded by viewport height, not total row count.
- Media gallery grid virtualization handles thousands of assets with the same code path.

### 5. CORS Setup Between SPA and API

The admin SPA and API are separate origins. The API worker must be configured to allow cross-origin requests from the admin SPA's CDN origin. This is handled in `packages/core` (the CMS API, covered in an earlier plan) but the admin SPA must communicate its expected behavior:

- The `hc` client sends requests with `Content-Type: application/json` and `Authorization: Bearer <token>` — both are non-simple headers triggering CORS preflight.
- The API must respond to `OPTIONS` preflight requests on all `/api/*` routes.
- `Access-Control-Allow-Origin` must be set to the admin SPA's exact origin (not `*`) when `Authorization` is present — credentials mode requires a specific origin.
- `Access-Control-Allow-Credentials: true` is required for session cookies if cookie-based sessions are used alongside bearer tokens.
- The admin SPA's `VITE_CMS_API_URL` env var determines the API origin at build time; the API's `CORS_ALLOWED_ORIGINS` env var must include the SPA's CDN URL.

Configuration lives in the API (`packages/core`), but the admin's `src/lib/client.ts` must use `credentials: 'include'` mode on the fetch options passed to `hc`.

### 6. shadcn Preset-Based Project Creation

The admin SPA should be created with the current shadcn CLI rather than hand-rolling primitive UI components. The implementation pass should initialize the project with the selected shadcn preset, commit the resulting `components.json`, and then import the full shadcn component set before domain-specific CMS components are built.

Required project-creation flow:

```bash
cd apps/admin
bunx --bun shadcn@latest init --preset b1YnRGLPH --base base --template vite --pointer
bunx shadcn@latest add all
```

Current shadcn documentation also shows the full component import command as:

```bash
bunx shadcn@latest add --all
```

Use `bunx shadcn@latest add all` as the requested project convention when the current CLI accepts it. If the CLI requires the documented flag form, use `bunx shadcn@latest add --all` and record that substitution in the implementation notes. Commit `components.json` and keep its aliases aligned with the app's `src` tree. All shadcn primitives should live under `apps/admin/src/components/ui`; CMS-specific composition belongs in feature folders such as `components/content`, `components/media`, `components/ct-builder`, and `components/layout`.

---

## Research Insights

**Best Practices:**
- Use TanStack Router file-based routing and route-level search validation rather than component-local query parsing.
- Consider an OpenAPI-generated client as the long-term public transport contract, while keeping Hono RPC valuable for same-workspace/internal consumers.
- Prefer httpOnly cookie sessions for the browser admin by default and avoid persistent bearer tokens unless explicitly required.

**Performance Considerations:**
- Pair row virtualization with server-driven pagination and query-cache eviction so the browser does not accumulate every page.
- Plan for column virtualization or progressive column collapse on very wide collection schemas.
- Keep selection, focus, and edit state keyed by stable record ID outside the virtual window.

**Edge Cases:**
- Define what happens when auth or permissions are lost during autosave, route transitions, or long-lived edit sessions.
- Add destructive-diff preview, migration failure, and rollback UX for the Content-Type Builder instead of saving directly into file/migration flows.

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Component and Data Flow

```
CDN (Cloudflare Pages / Vercel Static)
  └── apps/admin/dist/          ← static build artifact

Browser loads index.html
  └── main.tsx
       ├── JotaiProvider         ← wraps entire tree
       ├── QueryClientProvider   ← TanStack Query global client
       └── RouterProvider        ← TanStack Router (file-based)
            ├── __root.tsx        ← global layout, auth guard
            ├── _auth/            ← unauthenticated layout (login, register, etc.)
            │    ├── login.tsx
            │    ├── register.tsx
            │    ├── forgot-password.tsx
            │    ├── magic-link.tsx
            │    ├── verify-email.tsx
            │    └── 2fa/
            │         ├── setup.tsx
            │         └── verify.tsx
            └── _app/             ← authenticated layout (sidebar + content area)
                 ├── $collection/
                 │    ├── index.tsx       → CollectionListView
                 │    ├── new.tsx         → CollectionEditForm (new)
                 │    └── $id.tsx         → CollectionEditForm (edit)
                 ├── media/
                 │    ├── index.tsx       → MediaLibrary
                 │    └── $id.tsx         → MediaDetail
                 ├── org/
                 │    ├── manage.tsx
                 │    ├── members.tsx
                 │    └── invitations.tsx
                 └── settings/
                      ├── api-keys.tsx
                      ├── content-types/
                      │    ├── index.tsx  → CTBuilderList (read-only prod / editable dev)
                      │    └── $name.tsx  → CTBuilderDetail
                      ├── webhooks.tsx
                      ├── audit-log.tsx
                      ├── health.tsx
                      └── i18n.tsx
```

### Data Layer Flow

```
Component
  → useQuery(queryKey, () => client.api.articles.$get(...))
      ↓
  TanStack Query (cache, stale-while-revalidate, background refetch)
      ↓
  hc<CMSApp>(VITE_CMS_API_URL)
      ↓
  fetch() [with Authorization header, credentials: 'include']
      ↓
  CMS API Worker / Vercel Function
```

### Schema-Derived Form Flow

```
CollectionDefinition.fields  →  TanStack Form (dynamic field registration)
                                   ↓
                              FieldRenderer (maps type → component):
                              'string'      → <TextInput>
                              'richtext'    → <RichTextEditor> (Tiptap)
                              'media'       → <MediaPicker> (opens modal)
                              'relation'    → <RelationCombobox> (virtual scroll)
                              'enumeration' → <Select>
                              'boolean'     → <Checkbox>
                              'number'      → <NumberInput>
                              'date'        → <DatePicker>
                                   ↓
                              TanStack Pacer (debounce 500ms)
                                   ↓
                              auto-save → client.api[collection].$patch({ id, body })
```

---

## Output Structure

```
apps/admin/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── .env.example
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx                        ← app entry point
    ├── routeTree.gen.ts                ← auto-generated by TanStack Router
    ├── lib/
    │   ├── client.ts                   ← hc<CMSApp> singleton
    │   ├── auth-client.ts              ← createAuthClient from better-auth
    │   └── query-client.ts             ← QueryClient configuration
    ├── store/
    │   └── atoms.ts                    ← all Jotai atom definitions
    ├── routes/
    │   ├── __root.tsx                  ← root route + layout
    │   ├── _auth.tsx                   ← unauthenticated layout route
    │   ├── _auth/
    │   │   ├── login.tsx
    │   │   ├── register.tsx
    │   │   ├── forgot-password.tsx
    │   │   ├── magic-link.tsx
    │   │   ├── verify-email.tsx
    │   │   └── 2fa/
    │   │       ├── setup.tsx
    │   │       └── verify.tsx
    │   ├── _app.tsx                    ← authenticated layout route (sidebar)
    │   ├── _app/
    │   │   ├── index.tsx               ← dashboard / redirect
    │   │   ├── $collection.tsx         ← layout for collection routes
    │   │   ├── $collection/
    │   │   │   ├── index.tsx           ← CollectionListView
    │   │   │   ├── new.tsx             ← CollectionEditForm (new)
    │   │   │   └── $id.tsx             ← CollectionEditForm (edit)
    │   │   ├── media.tsx
    │   │   ├── media/
    │   │   │   ├── index.tsx
    │   │   │   └── $id.tsx
    │   │   ├── org/
    │   │   │   ├── manage.tsx
    │   │   │   ├── members.tsx
    │   │   │   └── invitations.tsx
    │   │   └── settings/
    │   │       ├── api-keys.tsx
    │   │       ├── content-types.tsx
    │   │       ├── content-types/
    │   │       │   ├── index.tsx
    │   │       │   └── $name.tsx
    │   │       ├── webhooks.tsx
    │   │       ├── audit-log.tsx
    │   │       ├── health.tsx
    │   │       └── i18n.tsx
    ├── components/
    │   ├── layout/
    │   │   ├── Sidebar.tsx
    │   │   ├── TopBar.tsx
    │   │   └── CommandPalette.tsx
    │   ├── content/
    │   │   ├── CollectionListView.tsx
    │   │   ├── CollectionEditForm.tsx
    │   │   └── FieldRenderer.tsx
    │   ├── media/
    │   │   ├── MediaLibrary.tsx
    │   │   ├── MediaGrid.tsx
    │   │   └── MediaPickerModal.tsx
    │   ├── ct-builder/
    │   │   ├── CollectionTypeBuilder.tsx
    │   │   ├── FieldConfigurator.tsx
    │   │   └── RelationConfigurator.tsx
    │   └── ui/                         ← shadcn primitives added by CLI
    │       ├── button.tsx
    │       ├── input.tsx
    │       ├── select.tsx
    │       ├── dialog.tsx
    │       └── ...
    └── __tests__/
        ├── auth/
        ├── content/
        ├── media/
        └── ct-builder/
```

---

## Implementation Units

### U1. Admin SPA Scaffold

**Goal:** Stand up the complete Vite + React 18 + TypeScript application skeleton — build config, entry HTML, root component, TanStack Router file-based routing, environment variable wiring, and test infrastructure — such that `vite dev`, `vite build`, `vite preview`, and `vitest` all run successfully against an empty route tree.

**Requirements:**
- Vite build produces a single static artifact in `dist/` suitable for CDN deployment (no server-side rendering)
- shadcn project initialization runs with the selected preset before app-specific components are authored
- `components.json` is committed and points shadcn aliases at the admin app's `src/` tree
- The full shadcn primitive set is added with `bunx shadcn@latest add all` or the documented equivalent `bunx shadcn@latest add --all`
- TanStack Router's file-based routing code-gen (`@tanstack/router-plugin/vite`) reads `src/app/` and produces `src/routeTree.gen.ts`
- `VITE_CMS_API_URL` is the single required environment variable; all others have defaults
- `vitest.config.ts` uses `jsdom` environment for component tests
- `tsconfig.json` is strict; `paths` alias `~/*` to `src/*`

**Dependencies:** None

**Files:**
- `apps/admin/package.json`
- `apps/admin/vite.config.ts`
- `apps/admin/vitest.config.ts`
- `apps/admin/tsconfig.json`
- `apps/admin/components.json`
- `apps/admin/index.html`
- `apps/admin/.env.example`
- `apps/admin/src/main.tsx`
- `apps/admin/src/app/__root.tsx`
- `apps/admin/src/app/_auth.tsx`
- `apps/admin/src/app/_app.tsx`
- `apps/admin/src/routeTree.gen.ts` (auto-generated; committed)
- `apps/admin/__tests__/scaffold.test.tsx`

**Approach:**

Scaffold the UI substrate first:

```bash
cd apps/admin
bunx --bun shadcn@latest init --preset b1YnRGLPH --base base --template vite --pointer
bunx shadcn@latest add all
```

If the current CLI rejects `add all`, use the documented equivalent:

```bash
bunx shadcn@latest add --all
```

After initialization, verify `components.json` uses the same `~/*` alias as `vite.config.ts` and `tsconfig.json`, and that primitives are generated under `src/components/ui`. Domain components must compose these primitives rather than fork or duplicate button, input, select, dialog, table, toast, sheet, command, tabs, dropdown, popover, and form controls.

`package.json` scripts:
- `dev`: `vite`
- `build`: `tsc --noEmit && vite build`
- `preview`: `vite preview`
- `test`: `vitest run`
- `test:watch`: `vitest`
- `typecheck`: `tsc --noEmit`

Key `vite.config.ts` decisions:
- Plugin: `@tanstack/router-plugin/vite` with `routesDirectory: 'src/app'` and `generatedRouteTree: 'src/routeTree.gen.ts'`
- Plugin: `@vitejs/plugin-react` (Babel-based for Fast Refresh; not SWC — SWC has TanStack Router plugin compatibility gaps)
- `build.outDir`: `dist`
- `build.rollupOptions.output.manualChunks`: split vendor (react + react-dom), tanstack, and app chunks to maximize CDN cache efficiency
- `resolve.alias`: `~` → `src/`
- `define`: `import.meta.env.VITE_CMS_API_URL` validated at startup — throw at module load if unset in production

`index.html`: standard Vite entry; `<div id="root">` mount point; `<title>@hono-cms Admin</title>`; no SSR concerns.

`src/main.tsx` wraps the application in three providers in order: `JotaiProvider` (outermost, for atom store isolation in tests), `QueryClientProvider`, `RouterProvider`. The router is created with `createRouter({ routeTree })` from the auto-generated tree.

`src/app/__root.tsx` is the root route. Its `beforeLoad` checks the session (via the better-auth client `getSession`). If unauthenticated and the current route is not under `_auth/`, it redirects to `/login`. Uses TanStack Router's `redirect()` throw pattern.

`src/app/_auth.tsx` defines the unauthenticated layout (centered card, CMS logo). If an authenticated user lands on any `_auth` route, redirect to `/`.

`src/app/_app.tsx` defines the authenticated shell layout: sidebar (collapsible, driven by `sidebarExpandedAtom`), top bar, `<Outlet />`.

`vitest.config.ts` decisions:
- `environment: 'jsdom'`
- `globals: true` (avoids per-file describe/it imports)
- `setupFiles: ['src/__tests__/setup.ts']` — configures `@testing-library/jest-dom` matchers
- `resolve.alias` mirrors `vite.config.ts`

**Test scenarios:**
- `main.tsx` renders without throwing when `VITE_CMS_API_URL` is set in test env
- `__root.tsx` `beforeLoad`: unauthenticated user navigating to `/articles` is redirected to `/login`
- `__root.tsx` `beforeLoad`: authenticated user navigating to `/articles` is not redirected
- `_auth.tsx`: authenticated user navigating to `/login` is redirected to `/`
- `_app.tsx`: renders sidebar and outlet when authenticated
- `vite build` produces `dist/index.html` and hashed JS/CSS bundles (verify in CI script, not a Vitest test)

**Verification:** `pnpm --filter @hono-cms/admin-spa dev` starts with no errors. `pnpm --filter @hono-cms/admin-spa build` produces `dist/`. `pnpm --filter @hono-cms/admin-spa test` passes the scaffold tests. `pnpm --filter @hono-cms/admin-spa typecheck` exits 0.
take this as example
```ts
export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		devtools(),
		nitro({ rollupConfig: { external: [/^@sentry\//] } }),
		tailwindcss(),
		tanstackStart({
			router: {
				routesDirectory: 'app',
				routeFileIgnorePattern: 'components|utils|styles|__tests__|hooks|lib|stores',
			},
			// rsc: {
			// 	enabled: true,
			// },
		}),
		// rsc({

		// }),
		viteReact(),

	],
	build: {
		rolldownOptions: {
			output: {
				advancedChunks: {
					groups: [
						{
							name: 'vendor-react',
							test: /node_modules\/(react|react-dom)\//,
						},
						{
							name: 'vendor-tanstack',
							test: /node_modules\/@tanstack\/(react-router|react-virtual|table|pacer|hot-keys)\//,
						}
					],
				},
			},
		},
	},
})
```
---

### U2. Hono RPC Client Setup

**Goal:** Establish the typed `hc<CMSApp>()` client singleton, the global TanStack Query `QueryClient`, and the query-wrapping pattern so that every component in the app can make fully-typed, cached API calls without re-instantiating the client.

**Requirements:**
- The `CMSApp` type must come from `@hono-cms/core` as a type-only import — no server code enters the browser bundle
- `hc()` is instantiated once and exported as a module-level singleton
- `QueryClient` is configured with appropriate stale time, retry behavior, and global error handling
- No request is made without the `Authorization` header (or session cookie) — the client must include credentials

**Dependencies:** U1

**Files:**
- `apps/admin/src/lib/client.ts`
- `apps/admin/src/lib/auth-client.ts`
- `apps/admin/src/lib/query-client.ts`
- `apps/admin/__tests__/lib/client.test.ts`

**Approach:**

**Type-only import pattern:**

`packages/core` exports the Hono app as a TypeScript type. The key is `export type { CMSApp }` from the core package's entry point — only the type, never the runtime value. The admin `src/lib/client.ts` does:

```ts
// Directional — not copy-paste specification
import type { CMSApp } from '@hono-cms/core'
import { hc } from 'hono/client'
```

The `import type` keyword ensures TypeScript strips this import entirely before Vite bundles the output. No Hono server code, no Drizzle ORM, no better-auth server code enters the browser bundle. This is verifiable: `vite build --analyze` (via `rollup-plugin-visualizer`) must show no `@hono-cms/core` runtime code in the bundle.

The `hc<CMSApp>()` call returns a typed proxy. Every method call on it — `client.api.articles.$get(...)`, `client.api.auth.login.$post(...)` — is inferred from `CMSApp`'s route tree. Return types of `await response.json()` are also inferred.

**Singleton pattern in `src/lib/client.ts`:**

The client is instantiated once using `import.meta.env.VITE_CMS_API_URL` as the base URL. The `fetch` option of `hc()` accepts a custom fetcher — the admin passes a wrapper that attaches the `Authorization: Bearer <token>` header from the better-auth session before every request. The token is retrieved synchronously from the auth client's in-memory session cache (not from `localStorage` on every call — the auth client caches the session object internally).

`credentials: 'include'` is passed in the fetch options to support session cookies alongside bearer tokens.

**`src/lib/query-client.ts` decisions:**

- `defaultOptions.queries.staleTime`: `30_000` (30 seconds) — content list data is fresh enough for 30s; no need for immediate background refetch on every focus
- `defaultOptions.queries.retry`: `(failureCount, error) => failureCount < 2 && !isAuthError(error)` — retry at most twice; never retry 401/403 (auth errors should surface immediately, not spin)
- `defaultOptions.queries.refetchOnWindowFocus`: `true` — admin users switching tabs should see fresh data
- `defaultOptions.mutations.onError`: global error handler posts to a toast atom (Jotai) so every failed mutation surfaces a notification without per-mutation error handling
- `defaultOptions.queries.networkMode`: `'offlineFirst'` — TanStack Query serves stale cache when offline; Pacer queues saves (see U4)

**`src/lib/auth-client.ts`:**

The better-auth frontend client is created with `createAuthClient({ baseURL: import.meta.env.VITE_CMS_API_URL })`. This gives the admin access to `authClient.signIn.email()`, `authClient.signIn.magicLink()`, `authClient.signUp.email()`, `authClient.twoFactor.getTotp()`, `authClient.session.get()`, etc. The auth client manages its own session state and token storage (httpOnly cookie via the API, or memory depending on better-auth config).

**Query factory pattern:**

Rather than constructing query options inline per component, define query factory functions in `src/lib/queries/`:
- `collectionQueries.list(collection, params)` returns `{ queryKey, queryFn }` for use in `useQuery` or `queryClient.prefetchQuery`
- `collectionQueries.detail(collection, id)` returns the same
- This centralizes cache invalidation — `queryClient.invalidateQueries({ queryKey: collectionQueries.list(collection).queryKey })` works from anywhere

**Test scenarios:**
- `client.ts`: the exported `client` object is defined when `VITE_CMS_API_URL` is set
- `client.ts`: the fetcher wrapper attaches `Authorization: Bearer <token>` to requests when a session token is present
- `client.ts`: no runtime import from `@hono-cms/core` appears in the bundle (verifiable via bundle analysis; documented as a build verification step)
- `query-client.ts`: queries with 401 response do not retry (isAuthError returns true; retry function returns false)
- `query-client.ts`: queries with 500 response retry up to 2 times
- `auth-client.ts`: `createAuthClient` is instantiated with the correct base URL from env

**Verification:** `pnpm --filter @hono-cms/admin-spa build && pnpm --filter @hono-cms/admin-spa test` passes. Bundle analysis shows `@hono-cms/core` produces zero runtime bytes in the output. TypeScript `tsc --noEmit` exits 0 — all `client.api.*` calls in the codebase are correctly typed.

---

### U3. Auth Pages

**Goal:** Implement all authentication and session management pages: login (email+password and magic link), register, forgot-password, magic-link landing, email-OTP verification, 2FA setup (TOTP QR code display), 2FA verify, and session management (logout, active sessions list). TanStack Router `beforeLoad` guards on the authenticated layout prevent unauthenticated access.

**Requirements:**
- All auth flows call the better-auth client (`authClient.*`) — never the `hc` CMS content client
- All forms use TanStack Form for field state, validation, and submission
- Route guards redirect unauthenticated users to `/login` and authenticated users away from `/login` to `/`
- 2FA setup renders a QR code using a lightweight QR code library (not a server-rendered image)
- Magic link and email-OTP flows handle the token/code from URL search params
- Active sessions list shows all sessions from the better-auth API, with per-session revocation

**Dependencies:** U1, U2

**Files:**
- `apps/admin/src/app/_auth/login.tsx`
- `apps/admin/src/app/_auth/register.tsx`
- `apps/admin/src/app/_auth/forgot-password.tsx`
- `apps/admin/src/app/_auth/magic-link.tsx`
- `apps/admin/src/app/_auth/verify-email.tsx`
- `apps/admin/src/app/_auth/2fa/setup.tsx`
- `apps/admin/src/app/_auth/2fa/verify.tsx`
- `apps/admin/src/app/_app/settings/sessions.tsx`
- `apps/admin/__tests__/auth/login.test.tsx`
- `apps/admin/__tests__/auth/register.test.tsx`
- `apps/admin/__tests__/auth/2fa.test.tsx`
- `apps/admin/__tests__/auth/route-guards.test.tsx`

**Approach:**

**TanStack Router auth guards:**

The `_app.tsx` route's `beforeLoad` function is the single gatekeeper for all authenticated routes. Pattern:

```ts
// Directional — not implementation specification
beforeLoad: async ({ context }) => {
  const session = await context.authClient.session.get()
  if (!session) throw redirect({ to: '/login' })
  return { session }
}
```

The `context` is threaded through the router — `authClient` is injected at router creation time in `main.tsx` as `router.context`. All child routes inherit `{ session }` from the parent `beforeLoad` return value.

The `_auth.tsx` route's `beforeLoad` does the inverse: if `session` exists, redirect to `/`.

**Login page:**

Two tabs or toggle: email+password and magic link. TanStack Form with two field definitions: `email` (Zod `z.string().email()`) and `password` (Zod `z.string().min(8)`). On submit, calls `authClient.signIn.email({ email, password })`. On success, navigates to `/`. On 2FA required response (better-auth returns a specific response indicating 2FA is pending), navigates to `/2fa/verify` with the session token in router state.

Magic link tab: single `email` field. Calls `authClient.signIn.magicLink({ email })`. Shows a confirmation message — no redirect until the user clicks the link in their email.

**Register page:**

Fields: `name`, `email`, `password`, `confirmPassword`. Zod schema with `.refine()` for password match. Calls `authClient.signUp.email({ name, email, password })`. On success navigates to `/verify-email` with a message that a verification email has been sent.

**Forgot-password page:**

Single `email` field. Calls `authClient.forgetPassword({ email })`. Shows confirmation. No redirect.

**Magic-link landing page:**

On mount, reads `?token=` from the URL search params (typed by TanStack Router's `validateSearch`). Calls `authClient.magicLink.verify({ token })`. On success redirects to `/`. On failure shows an error with a link back to `/login`.

**Email OTP verification:**

Reads `?token=` or shows a 6-digit OTP input field. Calls `authClient.emailVerification.verifyEmail({ token })` or `authClient.emailOtp.verifyEmail({ email, otp })`. On success redirects to `/`.

**2FA setup:**

Calls `authClient.twoFactor.getTotpUri()` to get the TOTP URI. Renders the URI as a QR code using `qrcode.react` (lightweight, zero-dependency React QR component). Shows the TOTP secret as a copyable string for manual entry in authenticator apps. User enters a 6-digit code to verify setup. Calls `authClient.twoFactor.verifyTotp({ code })`. On success shows the backup codes list (returned by better-auth) with a download button. Redirects to `/` after backup codes are acknowledged.

**2FA verify:**

Shown after login when 2FA is required. Single 6-digit OTP input with auto-submit on 6th digit. Calls `authClient.twoFactor.verifyOtp({ code })`. On success redirects to `/`.

**Session management (`/settings/sessions`):**

`useQuery` fetching `authClient.session.listSessions()`. Renders a table: device, created, last active, current (highlight). Per-row "Revoke" button calls `authClient.session.revokeSession({ token })` with an optimistic update removing the row. "Revoke all other sessions" button calls `authClient.session.revokeOtherSessions()`.

**Logout:**

Available in the sidebar user menu. Calls `authClient.signOut()`. On success, navigate to `/login`. Clears all TanStack Query cache (`queryClient.clear()`).

**Test scenarios:**
- Login form: submitting with invalid email shows validation error inline (not server error)
- Login form: submitting with valid credentials calls `authClient.signIn.email` with correct args
- Login form: server 401 response surfaces an error message without crashing
- Login form: successful login navigates to `/`
- Login form: 2FA-required response navigates to `/2fa/verify`
- Register form: password mismatch shows "Passwords do not match" error
- Register form: valid submission calls `authClient.signUp.email`
- Magic-link landing: missing `?token` search param shows an error, does not call `verifyEmail`
- Magic-link landing: valid token calls `verifyEmail` and redirects on success
- 2FA setup: QR code renders when `getTotpUri` returns a valid URI
- 2FA setup: entering a valid 6-digit code calls `verifyTotp`
- 2FA setup: backup codes display after successful TOTP verification
- 2FA verify: auto-submits on 6th digit entry
- Route guard: unauthenticated `GET /articles` redirects to `/login`
- Route guard: authenticated `GET /login` redirects to `/`
- Sessions page: renders session list; clicking Revoke removes the row optimistically

**Verification:** All auth test files pass. Manual flow: fresh browser → `/articles` → redirected to `/login` → sign in → redirected to `/articles`. 2FA setup generates a scannable QR code in dev (verified by visual inspection against an authenticator app).

---

### U4. Schema-Derived Content Forms

**Goal:** Implement `CollectionEditForm` — a component that renders a complete, validated, auto-saving content edit form for any collection by reading its `CollectionDefinition` at runtime. No form JSX is written per collection. Adding a field to a collection definition automatically adds it to the form.

**Requirements:**
- Field definitions come from `CollectionDefinition.fields` (from `@hono-cms/schema`)
- Each field type maps to a specific input component (FieldRenderer)
- Validation uses the Zod schema from the collection definition — the same schema the API validates against
- Auto-save triggers 500ms after the last keystroke via TanStack Pacer debounce
- `Ctrl+S` triggers immediate save via TanStack HotKeys
- `Ctrl+Shift+P` triggers publish via TanStack HotKeys
- `unsavedChangesAtom` is set to `true` when the form is dirty; navigation is blocked until saved or discarded
- `media` fields open the `MediaPickerModal` (implemented in U6)
- `relation` fields render an async combobox with TanStack Virtual scroll for large relation sets

**Dependencies:** U1, U2, U3, U8

**Files:**
- `apps/admin/src/components/content/CollectionEditForm.tsx`
- `apps/admin/src/components/content/FieldRenderer.tsx`
- `apps/admin/src/components/content/fields/TextField.tsx`
- `apps/admin/src/components/content/fields/RichTextField.tsx`
- `apps/admin/src/components/content/fields/MediaField.tsx`
- `apps/admin/src/components/content/fields/RelationField.tsx`
- `apps/admin/src/components/content/fields/EnumerationField.tsx`
- `apps/admin/src/components/content/fields/BooleanField.tsx`
- `apps/admin/src/components/content/fields/NumberField.tsx`
- `apps/admin/src/components/content/fields/DateField.tsx`
- `apps/admin/src/app/_app/$collection/new.tsx`
- `apps/admin/src/app/_app/$collection/$id.tsx`
- `apps/admin/__tests__/content/CollectionEditForm.test.tsx`
- `apps/admin/__tests__/content/FieldRenderer.test.tsx`

**Approach:**

**`CollectionEditForm` component structure:**

Props: `{ collection: CollectionDefinition; documentId?: string }`. When `documentId` is present, loads the existing document via `useQuery`. When absent, starts with empty defaults.

TanStack Form is initialized with `useForm({ defaultValues, onSubmit })` where `defaultValues` is derived from the document data (or empty defaults for new documents). The Zod schema for the form is assembled from the collection's field definitions — each field contributes its Zod type to a `z.object({})` composed at render time.

Field registration loops over `collection.fields`:

```ts
// Directional — not implementation specification
collection.fields.map((fieldDef) => (
  <form.Field
    key={fieldDef.name}
    name={fieldDef.name}
    validators={{ onChange: fieldDef.zodSchema }}
  >
    {(field) => <FieldRenderer fieldDef={fieldDef} field={field} />}
  </form.Field>
))
```

**`FieldRenderer` dispatch table:**

A plain object map from `FieldDefinition['type']` to a React component. Not a switch statement — a dispatch table is easier to extend and test. Unknown types render a disabled text input with a "Unsupported field type" label so new field types degrade gracefully.

| Field type | Component | Notes |
|---|---|---|
| `string` | `TextField` | Standard `<input type="text">` |
| `text` (long text) | `TextField` | `<textarea>` |
| `richtext` | `RichTextField` | Tiptap editor (StarterKit + custom extensions) |
| `integer`, `float`, `decimal` | `NumberField` | `<input type="number">` with step |
| `boolean` | `BooleanField` | `<input type="checkbox">` or toggle |
| `date`, `datetime` | `DateField` | Native `<input type="date/datetime-local">` |
| `enumeration` | `EnumerationField` | `<Select>` with options from `fieldDef.enum` |
| `media` | `MediaField` | Thumbnail + "Change" button → opens `MediaPickerModal` |
| `relation` | `RelationField` | Async combobox with TanStack Virtual for large sets |
| `json` | `JsonField` | `<textarea>` with JSON validation |
| `uid` | `UidField` | Auto-generated from sibling field; readonly with regenerate button |

**`RichTextField` (Tiptap):**

Use Tiptap with `@tiptap/starter-kit` (bold, italic, headings, lists, code blocks, blockquote). Store content as JSON (Tiptap's `editor.getJSON()`) in the form field value — not HTML. Serialize to HTML only for display. Tiptap is the only rich text editor with a headless React API that integrates cleanly with TanStack Form's controlled value model.

**`RelationField` (async combobox with virtual scroll):**

Renders a search input + dropdown list. On user typing, debounces (TanStack Pacer, 300ms) and calls `client.api[relationTargetCollection].$get({ query: { filters: { [labelField]: { $contains: search } }, pagination: { limit: 50 } } })`. Results are rendered in a dropdown using `useVirtualizer` from `@tanstack/react-virtual` — handles returning 50 results without visible scroll jank. Selected items are stored as IDs in the form field.

**Auto-save with TanStack Pacer:**

```ts
// Directional — not implementation specification
const debouncedSave = usePacer(
  () => form.handleSubmit(),
  { type: 'debounce', wait: 500 }
)

// Subscribe to form state changes
form.store.subscribe(() => {
  if (form.state.isDirty) debouncedSave()
})
```

Auto-save fires `PATCH` (update) or `POST` (create) against the CMS API. On successful auto-save, a transient "Saved" indicator appears in the top bar for 2 seconds then fades. `unsavedChangesAtom` is set to `false` after successful save.

**TanStack HotKeys:**

```ts
// Directional — not implementation specification
useHotkeys([
  ['mod+s', (e) => { e.preventDefault(); form.handleSubmit() }],
  ['mod+shift+p', (e) => { e.preventDefault(); handlePublish() }],
])
```

`mod` resolves to `Ctrl` on Windows/Linux and `Cmd` on macOS (TanStack HotKeys handles this automatically).

**Navigation block for unsaved changes:**

TanStack Router's `router.subscribe('onBeforeLoad', ...)` is used to intercept navigation when `unsavedChangesAtom` is `true`. A confirmation modal asks "You have unsaved changes. Leave anyway?" If the user confirms, the atom is reset and navigation proceeds. This prevents the silent data-loss that occurs with browser tab switching during editing.

**Publish flow:**

`handlePublish()` calls `client.api[collection].publish.$post({ param: { id } })`. On success, invalidates the detail query and shows a "Published" toast.

**Draft status indicator:**

The top bar shows `DRAFT` or `PUBLISHED` based on `document.status`. The publish button is disabled for already-published documents unless the form is dirty (implying pending changes to re-publish).

**Test scenarios:**
- `CollectionEditForm`: renders a text input for each `string` field in the collection definition
- `CollectionEditForm`: renders a Tiptap editor for each `richtext` field
- `CollectionEditForm`: renders a select with correct options for each `enumeration` field
- `CollectionEditForm`: submitting with a required field empty shows a validation error inline
- `CollectionEditForm`: submitting with all valid fields calls the API mutation
- `CollectionEditForm`: auto-save fires 500ms after the last input change (mock Pacer, assert call count)
- `CollectionEditForm`: `Ctrl+S` fires `form.handleSubmit()` immediately (mock hotkey event)
- `CollectionEditForm`: `Ctrl+Shift+P` calls the publish mutation
- `CollectionEditForm`: dirty form sets `unsavedChangesAtom` to `true`
- `CollectionEditForm`: successful save sets `unsavedChangesAtom` to `false`
- `CollectionEditForm`: navigating away with dirty form triggers a confirmation modal
- `FieldRenderer`: unknown field type renders a disabled fallback input
- `RelationField`: typing in the combobox debounces and calls the relation collection API
- `MediaField`: clicking "Change" opens `MediaPickerModal`

**Verification:** Navigate to `/$collection/new` in dev, see a fully rendered form with one input per field defined in the test collection. Change a field, wait 500ms, confirm the PATCH request fires in DevTools. Press `Ctrl+S`, confirm the request fires immediately. Press `Ctrl+Shift+P`, confirm the document status changes to `published` in the top bar.

---

### U5. Content List Views

**Goal:** Implement `CollectionListView` — a schema-driven content list with sortable and filterable columns, bulk actions, pagination, and optimistic updates on delete and publish. Handles 10k+ rows via TanStack Virtual without code changes.

**Requirements:**
- Column definitions derive from `CollectionDefinition.fields` — columns are not hand-written per collection
- TanStack Table provides sorting, filtering, and row selection state
- TanStack Virtual provides windowed row rendering inside the table body
- Bulk actions: publish, unpublish, delete (operate on `selectedItemsAtom`)
- TanStack Query fetches data with cursor or offset pagination; optimistic updates on delete/publish
- URL search params store current filters and sort state (typed by TanStack Router)

**Dependencies:** U1, U2, U3, U8

**Files:**
- `apps/admin/src/components/content/CollectionListView.tsx`
- `apps/admin/src/components/content/BulkActionsBar.tsx`
- `apps/admin/src/app/_app/$collection/index.tsx`
- `apps/admin/__tests__/content/CollectionListView.test.tsx`

**Approach:**

**Column definition derivation:**

TanStack Table column definitions are built from `CollectionDefinition.fields` using `columnHelper.accessor()`. Each field becomes a column with:
- `header`: the field's label from the definition
- `cell`: a lightweight renderer (plain text for strings, a pill for status, a thumbnail for media, a date formatter for dates)
- `enableSorting`: `true` for string, number, and date fields; `false` for richtext, media, json
- `enableColumnFilter`: `true` for enumeration and boolean fields (renders a filter dropdown in the column header)

Two fixed columns are prepended:
- A checkbox column for row selection (`selectedItemsAtom` integration)
- A "Status" column (draft/published pill) if the collection has `draftAndPublish: true`

One fixed column is appended:
- An "Actions" column with Edit (navigate to `/$collection/$id`) and Delete (optimistic remove) buttons.

**TanStack Table state:**

`useReactTable` is initialized with `getCoreRowModel`, `getSortedRowModel`, `getFilteredRowModel`, and `getPaginationRowModel` (for offset mode). Sorting and filtering state is synced bidirectionally with TanStack Router search params via `useSearch()` and `useNavigate()` — the URL is the source of truth for filter/sort state so that the browser back button restores the previous view.

**TanStack Virtual integration:**

The table body does not render all rows. Instead, `useVirtualizer` from `@tanstack/react-virtual` virtualizes the row list. The table container has a fixed height (e.g., `calc(100vh - 200px)`). The virtualizer returns `virtualItems` — only those are rendered as `<tr>` elements. The `<tbody>` has a `paddingTop` and `paddingBottom` applied from the virtualizer's `totalSize` to maintain correct scroll position.

This architecture means the component code is identical for 10 rows (all visible) and 10,000 rows (only ~30 rendered) — the virtualizer handles both cases.

**Pagination:**

Two modes selected by the API's capabilities:
- **Cursor pagination** (preferred): the query fetches the next page by passing the last item's cursor. A "Load More" button calls `fetchNextPage()` via TanStack Query's `useInfiniteQuery`. Cursor state is not in the URL (it would be invalid after data changes).
- **Offset pagination** (fallback for admin list views): `page` and `pageSize` stored in URL search params. "Previous / Next page" controls. Standard `useQuery` with page as a query key dependency.

The list view supports both modes — the collection definition (or admin config) specifies which mode applies.

**Bulk actions:**

`BulkActionsBar` is shown when `selectedItemsAtom` is non-empty. It shows: `N items selected`, then action buttons: `Publish`, `Unpublish`, `Delete`. Each action:
- Calls the appropriate CMS API mutation in a loop (or a batch endpoint if the API provides one)
- Uses TanStack Query's `useMutation` with an optimistic update that immediately removes or updates the affected rows in the query cache
- On success, clears `selectedItemsAtom`
- On failure, rolls back the optimistic update and shows an error toast

Rate limiting (TanStack Pacer): bulk publish of many items uses `usePacer` with `type: 'throttle'` to space out the API calls and avoid overwhelming the API under bulk operations.

**Filter toolbar:**

A filter row above the table (or in a collapsible sidebar) allows adding field-specific filters. Enumeration and boolean fields render as multi-select pills. String fields render as a text search input (debounced with TanStack Pacer, 300ms). All active filters are shown as dismissible chips. Filters are synced to URL search params.

**Optimistic updates on delete:**

When a row is deleted (single or bulk), the query cache is immediately updated to remove the row before the API call completes. If the API call fails, the query is invalidated to re-fetch the true state.

**Test scenarios:**
- `CollectionListView`: renders one column header per field in the collection definition
- `CollectionListView`: checkbox column is always present
- `CollectionListView`: clicking a column header with `enableSorting: true` updates the URL search param `sort`
- `CollectionListView`: clicking a row's Edit button navigates to `/$collection/$id`
- `CollectionListView`: selecting all rows sets `selectedItemsAtom` to all row IDs
- `BulkActionsBar`: shown when `selectedItemsAtom` is non-empty, hidden when empty
- `BulkActionsBar`: clicking Delete calls the delete mutation for each selected ID
- `BulkActionsBar`: optimistic update removes deleted rows from the table immediately
- `CollectionListView`: filter input debounces API calls (mock Pacer, assert call count on rapid input)
- `CollectionListView`: pagination controls render "Load More" for cursor mode; "Next/Previous" for offset mode

**Verification:** Navigate to `/$collection` in dev with a test collection seeded with 100 records. Observe that sorting by a column updates the URL. Select 5 rows, click Delete, confirm rows disappear instantly (optimistic). Scroll the list — confirm only visible rows have DOM nodes (open DevTools Elements panel).

---

### U6. Media Library

**Goal:** Implement the full-screen media library at `/media` — a virtualized asset grid that handles thousands of files, drag-and-drop upload with optimistic thumbnails, search and filter, inline preview with metadata, and a `MediaPickerModal` triggered by `media` fields in content forms.

**Requirements:**
- Grid virtualizes with TanStack Virtual (same code path for 10 and 10,000 assets)
- Upload is drag-and-drop or click-to-select; thumbnail appears immediately (optimistic, before upload completes)
- Search by filename; filter by MIME type category (image, video, document, other) and date range
- Inline preview panel: shows asset thumbnail/player, metadata (filename, size, dimensions, MIME type, upload date, URL), and actions (copy URL, delete, update alt text)
- `MediaPickerModal` is a modal version of the grid; on asset selection it resolves a Jotai atom (`mediaPickerStateAtom`) with the selected asset
- `mediaPickerStateAtom` is the coupling point between `MediaField` (U4) and this library — the field opens the picker; the picker resolves the selection back

**Dependencies:** U1, U2, U3, U8

**Files:**
- `apps/admin/src/components/media/MediaLibrary.tsx`
- `apps/admin/src/components/media/MediaGrid.tsx`
- `apps/admin/src/components/media/MediaPickerModal.tsx`
- `apps/admin/src/components/media/MediaPreviewPanel.tsx`
- `apps/admin/src/components/media/UploadDropzone.tsx`
- `apps/admin/src/app/_app/media/index.tsx`
- `apps/admin/src/app/_app/media/$id.tsx`
- `apps/admin/__tests__/media/MediaLibrary.test.tsx`
- `apps/admin/__tests__/media/MediaPickerModal.test.tsx`

**Approach:**

**Grid virtualization:**

`MediaGrid` renders assets in a CSS Grid layout with fixed cell dimensions (e.g., 160×160px thumbnails). `useVirtualizer` with `lanes` set to the number of grid columns (computed from container width via `ResizeObserver`) virtualizes the cells. Each cell renders: thumbnail (or file icon for non-images), filename (truncated), and a selection checkbox.

The virtualizer's row count is `Math.ceil(totalAssets / columnsPerRow)`. Each "row" in the virtualizer maps to a grid row containing N cells. This gives O(1) DOM nodes regardless of total asset count.

**Drag-and-drop upload with optimistic UI:**

`UploadDropzone` wraps the grid in a drag-and-drop zone using native `dragover` / `drop` events (no third-party DnD library needed for this use case). On file drop or click-to-select:

1. **Immediately**: create a synthetic asset object with `id: crypto.randomUUID()`, `url: URL.createObjectURL(file)`, `status: 'uploading'` and insert it at the top of the query cache via `queryClient.setQueryData`. The grid renders the thumbnail immediately using the object URL.
2. **Background**: call `client.api.media.$post({ body: formData })` with the file in a `FormData` body.
3. **On success**: replace the synthetic asset in the cache with the real asset from the API response (including the persisted URL, dimensions, etc.). Revoke the object URL.
4. **On failure**: remove the synthetic asset from the cache. Show an error toast.

Multiple files can be uploaded in parallel. Each has its own synthetic entry with a progress indicator.

**Search and filter:**

A search input at the top of the library debounces (TanStack Pacer, 300ms) and appends `?filters[filename][$contains]=...` to the query. MIME type filter buttons (`Images`, `Videos`, `Documents`, `Other`) append `?filters[mimeType][$startsWith]=image/` etc. Date range filter uses two date pickers. All filter state is in URL search params (synced via TanStack Router).

**Inline preview panel:**

Clicking an asset opens a side panel (not a modal) showing the full-resolution image or a media player for video/audio. Metadata displayed: filename (editable inline → PATCH `/api/media/:id`), file size (formatted), dimensions (for images), MIME type, upload date, CDN URL (copy button). Alt text field (editable, saved on blur). Delete button with confirmation.

**`MediaPickerModal` and `mediaPickerStateAtom`:**

`mediaPickerStateAtom` shape: `{ open: boolean; fieldId: string | null; resolve: ((asset: MediaAsset | null) => void) | null }`.

When `MediaField` (U4) calls `openMediaPicker(fieldId)`, it sets the atom to `{ open: true, fieldId, resolve: (asset) => { form.setFieldValue(fieldDef.name, asset) } }`. The modal reads `mediaPickerStateAtom.open` to determine visibility. The "Select" button in the modal calls `state.resolve(selectedAsset)` and then resets the atom to `{ open: false, fieldId: null, resolve: null }`.

This decouples `MediaField` from `MediaLibrary` — the picker modal can be opened from any form, anywhere in the app, without prop drilling.

**Test scenarios:**
- `MediaGrid`: renders a thumbnail cell for each asset in the query result
- `MediaGrid`: renders only visible rows (virtualizer test — assert `document.querySelectorAll('.media-cell').length` is less than total asset count when total > viewport capacity)
- `UploadDropzone`: dropping a file immediately renders an optimistic thumbnail
- `UploadDropzone`: upload failure removes the optimistic thumbnail and shows an error toast
- `MediaLibrary`: typing in the search input debounces API calls (mock Pacer, assert once after 300ms)
- `MediaLibrary`: clicking the Images filter appends the correct MIME type filter to the query
- `MediaPickerModal`: opens when `mediaPickerStateAtom.open` is `true`
- `MediaPickerModal`: selecting an asset calls `state.resolve` with the asset and closes the modal
- `MediaPickerModal`: closing without selection calls `state.resolve(null)` and closes the modal

**Verification:** In dev, open `/media`. Drag 5 images onto the grid — all 5 thumbnails appear immediately. Wait for uploads to complete — thumbnails update to CDN URLs. Search for a filename — grid filters in real time. Click an image — side panel opens with metadata and the CDN URL is copyable. Open a content edit form, click a media field's "Change" button — the picker modal opens; selecting an image closes the modal and populates the field.

---

### U7. Content-Type Builder UI (Dev Only)

**Goal:** Implement the `CollectionTypeBuilder` — a dev-mode UI for creating and editing collection definitions. In prod mode, the same route renders a read-only view. Writes to the CMS API which generates `cms/collections/<name>.ts` files and triggers auto-migration in dev. Uses Jotai atoms for in-progress builder state.

**Requirements:**
- All builder editing is disabled in prod (`import.meta.env.VITE_CMS_ENV === 'production'` or driven by an API capability flag)
- In dev: add fields, set types, configure options (required, unique, max length), define relations, set field-level permissions
- In prod: read-only display of current collections and their fields
- Saving a collection POSTs to the CMS API; the API writes the TypeScript file and triggers auto-migration
- Jotai atoms hold the in-progress builder state: `builderDraftAtom` tracks the collection being edited before it is saved
- Unsaved builder changes set `unsavedChangesAtom` (same atom as content forms — blocks navigation)

**Dependencies:** U1, U2, U3, U8

**Files:**
- `apps/admin/src/components/ct-builder/CollectionTypeBuilder.tsx`
- `apps/admin/src/components/ct-builder/FieldConfigurator.tsx`
- `apps/admin/src/components/ct-builder/RelationConfigurator.tsx`
- `apps/admin/src/app/_app/settings/content-types/index.tsx`
- `apps/admin/src/app/_app/settings/content-types/$name.tsx`
- `apps/admin/__tests__/ct-builder/CollectionTypeBuilder.test.tsx`

**Approach:**

**Dev/prod mode gate:**

`CollectionTypeBuilder` reads `import.meta.env.VITE_CMS_ENV` (or alternatively, makes a `GET /api/cms/capabilities` call and checks `{ contentTypeBuilderEnabled: boolean }` from the response). If prod, all inputs are `disabled` and all save/add/delete buttons are hidden. A banner reads "Content-Type Builder is read-only in production. Use the CLI to apply schema changes."

**In-progress state with Jotai:**

`builderDraftAtom` is defined as `atom<CollectionDefinition | null>(null)`. When the user clicks "Edit" on a collection, `builderDraftAtom` is set to a deep clone of that collection's definition (not a reference — edits must not mutate the live definition until saved). The builder form reads from and writes to `builderDraftAtom`. A `builderIsDirtyAtom` derived atom compares `builderDraftAtom` to the original (from query cache) and returns `true` if they differ. This feeds into `unsavedChangesAtom` so navigation is blocked.

**Field list management:**

The builder shows the current fields as a sortable list (drag-to-reorder, using a simple drag state in a local atom — not a full DnD library; reordering uses mouse events + index swap). An "Add Field" button opens a `FieldConfigurator` modal.

**`FieldConfigurator` modal:**

A multi-step form (not a wizard — all steps visible in a scrollable panel):
1. Field type selector: a grid of type cards (string, richtext, number, boolean, date, enumeration, media, relation, json, uid)
2. Basic options: name, display label, required (boolean), unique (boolean)
3. Type-specific options:
   - `string`: max length
   - `enumeration`: enum values (add/remove)
   - `number`: min, max, integer/float
   - `relation`: opens `RelationConfigurator`
4. Field-level permissions: which roles can read/write this field (multi-select from the known roles)

On "Add", the field is appended to `builderDraftAtom.fields`. The modal closes.

**`RelationConfigurator`:**

Selects the target collection from a dropdown (fetched from `GET /api/cms/collections`). Selects cardinality: one-to-one, one-to-many, many-to-many. Sets the relation field name on both sides. Relations are bidirectional — the builder shows both sides.

**Saving:**

"Save" calls `POST /api/cms/collections` (new) or `PUT /api/cms/collections/:name` (update) with the `CollectionDefinition` JSON. The API writes the TypeScript file and runs `drizzle-kit generate` + migration. The builder shows a loading state during this operation. On success, invalidates the collections query and clears `builderDraftAtom`.

**New collection:**

"Create Collection" starts a new `builderDraftAtom` with only `name` and `displayName` fields. The builder form requires a valid collection name (alphanumeric, kebab-case) before adding any fields.

**Test scenarios:**
- `CollectionTypeBuilder` in prod mode: all inputs are disabled, save button is absent
- `CollectionTypeBuilder` in dev mode: all inputs are enabled
- `FieldConfigurator`: selecting "string" type shows the max-length option; selecting "enumeration" shows the enum values editor
- `FieldConfigurator`: adding a field with no name shows a validation error
- `FieldConfigurator`: adding a valid field appends it to `builderDraftAtom.fields`
- `CollectionTypeBuilder`: dirty builder state (draft differs from saved) sets `unsavedChangesAtom` to `true`
- `CollectionTypeBuilder`: clicking Save calls the CMS API with the full `CollectionDefinition`
- `RelationConfigurator`: selecting target collection and cardinality populates the relation field on the draft

**Verification:** In dev, create a new collection with 3 fields (string, number, enumeration). Click Save. Confirm the CMS API creates the TypeScript file in `cms/collections/`. Navigate to `/$newCollection` — confirm the list view renders columns for the 3 fields. In a production build (`VITE_CMS_ENV=production`), navigate to `/settings/content-types/$name` — confirm all fields are read-only.

---

### U8. Jotai Atoms and Provider Setup

**Goal:** Define all Jotai atoms needed by the admin SPA, configure the `JotaiProvider` at the app root, and establish the patterns for atom access and cross-component state coordination.

**Requirements:**
- All atoms are defined in one file (`src/store/atoms.ts`) for discoverability
- Atoms cover: multi-select state, sidebar expansion, unsaved changes, command palette, media picker, builder draft, toast notifications
- `JotaiProvider` wraps the entire app in `main.tsx` with an explicit store (for testability)
- Tests can inject a fresh store per test case to prevent atom state bleed between tests

**Dependencies:** U1

**Files:**
- `apps/admin/src/store/atoms.ts`
- `apps/admin/src/main.tsx` (modification — add JotaiProvider)
- `apps/admin/__tests__/store/atoms.test.ts`

**Approach:**

**Atom definitions in `src/store/atoms.ts`:**

All atoms exported from a single file. Each atom is documented with a JSDoc comment explaining its purpose and which components consume it.

| Atom | Type | Initial value | Purpose |
|---|---|---|---|
| `selectedItemsAtom` | `Set<string>` | `new Set()` | IDs of selected rows in `CollectionListView`; consumed by `BulkActionsBar` |
| `sidebarExpandedAtom` | `boolean` | `true` | Controls sidebar expanded/collapsed state; persisted to `localStorage` via `atomWithStorage` (Jotai utils) |
| `unsavedChangesAtom` | `boolean` | `false` | Set to `true` when any form or CT builder has unsaved changes; consumed by the router navigation guard |
| `commandPaletteOpenAtom` | `boolean` | `false` | Controls command palette visibility; toggled by `Ctrl+K` hotkey |
| `mediaPickerStateAtom` | `MediaPickerState` | `{ open: false, fieldId: null, resolve: null }` | Coordinates media picker modal between `MediaField` and `MediaPickerModal` |
| `builderDraftAtom` | `CollectionDefinition \| null` | `null` | CT Builder in-progress state |
| `toastAtom` | `Toast[]` | `[]` | Global toast notification queue; write-only from mutations; consumed by `ToastContainer` |
| `activeCollectionAtom` | `string \| null` | `null` | The current collection name from the route; derived from TanStack Router's `useParams()` at the layout level and written to this atom for cross-component access |

**`atomWithStorage` for sidebar:**

The sidebar expanded state is persisted with `atomWithStorage('sidebarExpanded', true)` from `jotai/utils`. This means the sidebar remembers its expanded/collapsed state across page refreshes without any additional logic.

**`toastAtom` write pattern:**

TanStack Query's global mutation `onError` handler writes to `toastAtom` via the Jotai store (not via a hook — the mutation handler is outside React). The store is obtained via `const store = createStore()` in `main.tsx` and passed to both `JotaiProvider` and any non-React contexts that need to write atoms.

**`Provider` setup in `main.tsx`:**

```ts
// Directional — not implementation specification
const store = createStore()
// store.set(sidebarExpandedAtom, true)  // can pre-seed if needed

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Provider>
  </React.StrictMode>
)
```

**Test isolation pattern:**

Each test that touches atoms creates a fresh store:

```ts
// Directional — not implementation specification
const store = createStore()
render(
  <Provider store={store}>
    <ComponentUnderTest />
  </Provider>
)
```

This prevents atom state from leaking between tests — a test that sets `selectedItemsAtom` does not affect the next test.

**Derived atoms:**

`builderIsDirtyAtom` is a read-only derived atom that compares `builderDraftAtom` to the original loaded definition. Defined in `atoms.ts` alongside the base atoms:

```ts
// Directional — not implementation specification
const builderIsDirtyAtom = atom((get) => {
  const draft = get(builderDraftAtom)
  // compare to cached original ... returns boolean
})
```

This pattern should be used for any atom whose value can be derived from another atom — avoids duplicate state synchronization logic.

**Test scenarios:**
- `sidebarExpandedAtom`: toggling updates `localStorage` key `'sidebarExpanded'`
- `selectedItemsAtom`: adding an ID to the Set and reading it back returns the updated Set
- `unsavedChangesAtom`: starts as `false`; can be set to `true` and reset to `false`
- `commandPaletteOpenAtom`: starts as `false`
- `mediaPickerStateAtom`: setting `open: true` with a resolve function; reading back returns the correct state
- `toastAtom`: writing a toast appends it to the array
- Provider isolation: two separate test renders with separate stores do not share atom state

**Verification:** In Storybook (or in dev), open the browser console and verify `sidebarExpandedAtom` is restored from `localStorage` on hard refresh. Confirm `unsavedChangesAtom` blocks navigation when `true`. Confirm `commandPaletteOpenAtom` opens the command palette on `Ctrl+K`.

---

## Risk Analysis

### R1. TanStack Pacer API stability

TanStack Pacer is one of the newer packages in the TanStack ecosystem. Its API surface has changed between minor versions. Pin the version in `package.json` with a `~` prefix (patch updates only) until the API stabilizes. The debounce behavior (`type: 'debounce'`, `wait: 500`) is well-established in the codebase — if Pacer's API changes, the fallback is a standard `useCallback` with `setTimeout` / `clearTimeout`, which adds ~15 lines but is fully under control.

### R2. `import type` enforcement

If `@hono-cms/core` is accidentally imported as a value (not a type), Vite will bundle server code — Drizzle ORM, better-auth server internals — into the admin bundle. This is a silent failure; the app may still work but the bundle size balloons. Mitigation: add a bundle size CI check (fail if `dist/` exceeds 2 MB compressed) and a `rollup-plugin-visualizer` analysis step. The `import type` restriction can be enforced by a lint rule (`@typescript-eslint/no-import-type-side-effects`).

### R3. CORS preflight failures in production

The admin SPA and API live on different origins. CORS configuration must match exactly — if the admin URL changes (e.g., from a preview URL to the production CDN URL), the API's `CORS_ALLOWED_ORIGINS` must be updated. Mitigation: treat `CORS_ALLOWED_ORIGINS` as a required env var on the API with no default; the API startup check (`cms schema check --assert-clean` equivalent) should also validate CORS config. Document the required pair (`VITE_CMS_API_URL` on the SPA side; `CORS_ALLOWED_ORIGINS` on the API side) in the deployment guide.

### R4. TanStack Router file-based routing code-gen in monorepo

TanStack Router's Vite plugin generates `src/routeTree.gen.ts` on dev server start and build. In a monorepo, if the Vite dev server is started from the monorepo root (not `apps/admin/`), the plugin may not detect the routes directory correctly. Mitigation: always run Vite from `apps/admin/` directory; configure the monorepo's root `package.json` scripts to use `pnpm --filter @hono-cms/admin-spa dev` which runs Vite with the correct working directory.

### R5. Tiptap bundle size

Tiptap's `@tiptap/starter-kit` adds approximately 80 KB to the bundle (gzipped). This is acceptable for an admin SPA but should be verified against the bundle size budget. Use `manualChunks` in `vite.config.ts` to split Tiptap into its own chunk so it does not block the initial render — the rich text editor is only mounted on content edit pages, and dynamic import (`import()`) for Tiptap within `RichTextField` allows it to be code-split.

### R6. Jotai atom state in StrictMode

React StrictMode double-invokes effects and render functions. Jotai's `atom()` is stable across double renders. However, atoms that have side effects in their `read` function (e.g., `atomWithStorage`) may write to `localStorage` twice during development. This is a StrictMode artifact, not a production bug. Verify atom behavior in production builds (`NODE_ENV=production`) before attributing StrictMode double-render behavior to real bugs.

---

## System-Wide Impact

| Surface | Impact |
|---|---|
| `packages/core` | Must export `CMSApp` as a type-only export. Must configure CORS for the admin SPA origin. Must expose `/api/cms/collections` (list) and `PUT /api/cms/collections/:name` (update) endpoints for the CT Builder. Must expose `/api/cms/capabilities` with `{ contentTypeBuilderEnabled }` |
| `packages/schema` | `CollectionDefinition` type must be importable by the admin with no server-side dependencies. If the schema package imports Drizzle ORM types, those must be separated from the pure TypeScript `CollectionDefinition` type so the admin can import the type safely |
| `packages/auth` | The better-auth client (`createAuthClient`) is a browser-safe import — no server code. Verify that `better-auth/client` entry point has no Node.js-only imports |
| CDN deployment | `dist/` output must include a `_redirects` file (Cloudflare Pages) or `vercel.json` with `"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]` for SPA fallback routing |
| API CORS | API must respond to `OPTIONS` preflight on all routes. `Access-Control-Allow-Origin` must be the admin SPA's exact origin. `Access-Control-Allow-Headers` must include `Authorization`, `Content-Type` |
| CI | Admin SPA builds must run `tsc --noEmit` and `vitest run` in CI. Bundle size check (2 MB compressed limit) must run after `vite build`. `routeTree.gen.ts` should be committed and verified not to drift (run `vite build` in CI and `git diff --exit-code src/routeTree.gen.ts`) |

---

## Dependencies / Prerequisites

- `packages/core` must export `CMSApp` type before U2 can be implemented
- `packages/schema` must export `CollectionDefinition` type before U4, U5, U7 can be implemented
- `packages/auth` must export `createAuthClient` compatible entry point before U3 can be implemented
- The CMS API must be deployed and reachable at `VITE_CMS_API_URL` for manual verification of any unit
- Cloudflare Pages or Vercel project must be configured (outside this plan) for the first deployment

---

## Deferred / Open Questions

| Item | Disposition |
|---|---|
| Real-time collaborative editing (multi-user concurrent edits on the same document) | Deferred — requires SSE or WebSocket infrastructure; not supported by basic Workers without Durable Objects; post-MVP |
| Command palette implementation (`commandPaletteOpenAtom`) | The atom is defined in U8; the UI component (`CommandPalette.tsx`) is scaffolded in U1's Output Structure but not detailed here — implementation follows after core flows are stable |
| Tiptap extensions beyond StarterKit (tables, mentions, embeds) | Deferred — base StarterKit is in-scope for U4; extension marketplace is post-MVP |
| Admin UI theming / CSS design system | The plan defines component boundaries; actual styling (colors, spacing, typography tokens) is a separate design pass. The plan assumes a utility-first CSS approach (Tailwind CSS v4 or UnoCSS) but does not specify the design language |
| `@vitest/browser` vs `jsdom` | The plan specifies `jsdom` as the Vitest environment. `@vitest/browser` (Playwright-backed component tests in a real browser) is a viable upgrade for media drag-and-drop tests and virtual scroll validation; revisit when jsdom limitations become blocking |
| Offline support / service worker | TanStack Query's `networkMode: 'offlineFirst'` and Pacer's queue handle the common offline edit case. A full service worker (PWA) is deferred |
