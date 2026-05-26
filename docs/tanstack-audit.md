# TanStack Audit — apps/admin

Date: 2026-05-22
Auditor: ce-work U6

## Summary

The admin SPA is broadly familiar with the TanStack stack — every required library is installed, imported, and exercised in production code paths. File-based routing is wired up via `@tanstack/router-plugin`, `useQuery`/`useMutation` are the default for I/O, the content list uses a `useReactTable` + `useVirtualizer` pair, optimistic updates with rollback are present for bulk content mutations, and Pacer's `useDebouncedCallback` powers both autosave and search debouncing. However, the implementation is **moderately idiomatic, not exemplary** — there are real anti-patterns that undercut the framework choice: (1) the entire app lives in a single 2,791-line `AdminApp.tsx` god-file rather than per-route components, (2) `@tanstack/react-form` is used for exactly **one** form (the schema editor) while every other form in the app hand-rolls `<form onSubmit>` + `FormData`, (3) the route files are pure stub forwarders with zero loaders/`errorComponent`/`pendingComponent` — TanStack Router's data-loading powers are unused, (4) the QueryClient is constructed as a module-level singleton instead of passed via router context, blocking SSR/test isolation, and (5) `useReactTable` is only used in one place (`ContentTable`) while the Sessions view re-implements an HTML table by hand. The biggest leverage opportunity: split the monolith, push reads into route loaders (so router preloading actually does something), and adopt `useForm` for the 8 remaining `FormData`-based forms.

## Scoring Grid

| Library | Used | Idiomatic | Notes |
|---|---|---|---|
| @tanstack/react-router | Yes | Partial | File-based routing + `routeTree.gen.ts` is correct; root `beforeLoad` is used; but **no loaders anywhere**, no router context, route files are 6-line forwarders, `useNavigate` redirect from `useEffect` in `AppFrame` duplicates root `beforeLoad`. |
| @tanstack/react-query | Yes | Mostly | `useQuery`/`useMutation`/`useInfiniteQuery` used everywhere; query keys are array-tuple-structured; mutation `onSuccess` invalidations are present; optimistic update + rollback in `ContentWorkspace` and `SessionsView` is textbook. QueryClient is a module singleton (not router-context-scoped). Query keys are not centralised in a key factory — bare strings/literals duplicated across files. |
| @tanstack/react-table | Yes | Minimal | One use site only. No `createColumnHelper`, no sorting/filtering/pagination from the table itself (it’s a thin layer over a manually-managed sort state). `SessionsView` has its own hand-rolled table and skips `useReactTable` entirely. |
| @tanstack/react-virtual | Yes | Yes | Two correct call sites: `ContentTable` rows and `VirtualRelationList`. Audit log, webhook deliveries, media grid, and members list are *not* virtualised even though they can grow. |
| @tanstack/react-form | Yes | Poorly | Used for the schema editor form only; every other form (webhooks, API keys, content-types, auth, i18n, org settings, members, invitations, audit filters) hand-rolls `<form onSubmit>` + `new FormData(event.currentTarget)`. No validation pipeline, no `form.Subscribe`, no `field.api.handleChange`. |
| @tanstack/pacer | Yes | Yes | `useDebouncedCallback` from `@tanstack/react-pacer` is used for autosave (500ms), relation search (300ms), and media search (300ms). Correct usage. One missed opportunity: `globalThis.setTimeout` in `GeneratedSnippet`. |
| @tanstack/react-hotkeys | Yes | Yes | Two correct call sites: command palette `Mod+K` in `AppFrame` and editor `Mod+S` / `Mod+Shift+P` in `SchemaForm`. Hotkey constants are exported for testability. Nothing more would obviously belong here. |

## Detailed Findings

### Router (`@tanstack/react-router`)

What's good
- File-based routing is correctly configured. Route files live in `apps/admin/src/app/*.tsx`, the generated tree is at `apps/admin/src/routeTree.gen.ts:11-35`, and the router is created idiomatically with `defaultPreload: "intent"` and `scrollRestoration: true` (`apps/admin/src/router.tsx:4-8`). The `Register` interface is declared for typesafe routing (`router.tsx:12-16`).
- `__root.tsx` correctly uses `createRootRoute` with a `beforeLoad` that redirects unauthenticated users (`apps/admin/src/app/__root.tsx:5-15`).
- `validateSearch` is wired to nuqs parsers for the content and media routes (`content.tsx:6`, `media.tsx:6`, `route-search.ts:19-25`), giving typed `Route.useSearch()` consumers.
- `useBlocker` is used correctly to guard navigation with unsaved changes (`AdminApp.tsx:99-104`), including `enableBeforeUnload` to cover tab-close.
- `<Link>` with `activeProps` for nav highlight (`AdminApp.tsx:2771`) is idiomatic.

What to improve
- **P1 — Route files are stub forwarders, no loaders.** Every route file is 6–15 lines that imports a view component out of `AdminApp.tsx` and returns it. None of them define a `loader`, `errorComponent`, `pendingComponent`, or `staleTime`. This means `defaultPreload: "intent"` has nothing to preload on hover — every navigation does its data-fetching client-side on mount through `useQuery`. The whole point of file-based routes in TanStack Router is that they own their data. Example pattern that's missing:

  ```tsx
  // apps/admin/src/app/content.$collectionName.tsx (current)
  export const Route = createFileRoute("/content/$collectionName")({
    validateSearch: validateContentSearch,
    component: ContentCollectionRoute  // delegates everything to <ContentWorkspace>
  });
  ```

  Idiomatic shape would be:
  ```tsx
  export const Route = createFileRoute("/content/$collectionName")({
    validateSearch: validateContentSearch,
    loader: ({ context: { queryClient }, params, deps }) =>
      queryClient.ensureQueryData(contentQueryOptions(params.collectionName, deps)),
    loaderDeps: ({ search }) => ({ q: search.q, status: search.status, sort: search.sort }),
    component: ContentCollectionRoute,
    pendingComponent: ContentSkeleton,
    errorComponent: ContentError
  });
  ```

- **P1 — No router context.** `createRouter` is called without `context: { queryClient }` (`router.tsx:4-8`). As a result, route loaders cannot hand off to React Query for prefetching, tests cannot inject a fresh client, and the `QueryClient` has to live as a module singleton at `AdminApp.tsx:30-37`. The canonical pattern is `createRootRouteWithContext<{ queryClient: QueryClient }>()` + `createRouter({ routeTree, context: { queryClient } })`.

- **P2 — Duplicate auth redirect logic.** `__root.tsx:6-9` already redirects via `beforeLoad`, but `AppFrame` (`AdminApp.tsx:112-115`) *also* checks auth in a `useEffect` and re-redirects. The `useEffect` redirect is racy with the route load and means you'll see a flash of unauthenticated content. Consolidate to `beforeLoad`/`loader` and delete the effect.

- **P2 — `CommandPaletteRoute` and `NavLink`'s `to` union are hand-maintained string-literal types** (`AdminApp.tsx:177-188`, `2770`). `useNavigate`/`<Link>` already have typesafe routes via the `Register` declaration — these manual unions duplicate what the generated route tree provides. Drop them and let the router infer.

- **P3 — `Outlet` is rendered inside `<main>`** (`AdminApp.tsx:144`). Good. But the entire layout shell is also rendered from `__root.tsx`'s component, which is fine — just note that nothing exercises route-level layouts (e.g. there is no `settings.tsx` parent for `settings.*.tsx` children, so the sidebar and the settings panels share no shared layout boundary).

### Query (`@tanstack/react-query`)

What's good
- All reads go through `useQuery`/`useInfiniteQuery` (`AdminApp.tsx:306, 321, 932, 1068, 1085, 1195, 1231, 1379, 1497, 1655, 2307, 2310, 2439, 2489, 2547, 2609, 2652`).
- All writes go through `useMutation`. Mutations almost always invalidate or write-through their related cache keys on `onSuccess` or `onSettled`.
- Optimistic updates with rollback are textbook in two places:
  - `ContentWorkspace` bulk operations (`AdminApp.tsx:352-388`) — `cancelQueries` + `getQueriesData` snapshot + `setQueriesData` mutation + `onError` restore + `onSettled` invalidate.
  - `SessionsView.revokeMutation` (`AdminApp.tsx:1499-1519`) — same pattern.
- Query keys are tuple-shaped (`["content", activeCollection, searchField, ...]`) which is the correct way to make invalidation hierarchical.
- `staleTime: 15_000, retry: 1` defaults on the client (`AdminApp.tsx:30-37`) are reasonable for an admin tool.

What to improve
- **P1 — `QueryClient` is a module-level singleton** (`AdminApp.tsx:30-37`). This blocks any SSR pre-render, breaks test isolation (every test that imports this module shares state), and prevents handing the client into route `loader({ context: { queryClient } })`. Move to per-render construction (e.g. `useState(() => new QueryClient(...))`) and pass via `RouterProvider` `context`.

- **P1 — No query-key factory; bare arrays scattered across the file.** Examples of duplicated literals: `["content", activeCollection]` appears at lines 353, 354, 355, 368, 377, 386, 729, 761; `["organization-members"]` appears at lines 2489, 2493, 2497; `["webhooks"]` at 1195, 1198, 1228, 1243, 1517, 1526. A single key factory (per spec: `keys = { content: { all: ['cms','content'], list: (c) => [...keys.content.all, 'list', c], ... } }`) would prevent typos, enable hierarchical invalidation, and make the keys discoverable.

- **P2 — Query keys include unstable object references.** `["audit", filters]` (`AdminApp.tsx:1086`) and `["i18n-backfill-status", selection]` (`AdminApp.tsx:2311`) put a full object into the key. Because the object identity changes on every render, the keys are still structurally compared by React Query — so it works, but any nested object/array means cache hits depend on iteration order. Normalize before keying.

- **P2 — `useClient()` creates a new client on every token change but the queries don't capture that in their keys.** `useClient()` at `AdminApp.tsx:2774-2777` `useMemo`s on `token`. When the token changes, every `queryFn` closure rebinds, but the query keys don't include `token`, so stale entries can survive a token rotation. The `signOut` flow does `queryClient.clear()` (`AdminApp.tsx:226`) which is the brute-force fix, but a token-namespaced key would be more surgical.

- **P3 — Some mutations don't invalidate their queries.** `previewMutation` (`AdminApp.tsx:764-767`) and `scheduleMutation` (`AdminApp.tsx:750-753`) update local state but don't invalidate `["content", collectionName]` — fine if the server doesn't change the record on schedule, but the schedule actually *does* change the record status server-side, so this likely leaves stale data in the table.

### Table (`@tanstack/react-table`)

What's good
- `useReactTable` + `getCoreRowModel()` + `flexRender` is wired correctly in `ContentTable` (`AdminApp.tsx:489-565`).
- Columns are typed `ColumnDef<AdminContentRecord>[]` and memoised on the collection metadata.

What to improve
- **P1 — Sorting is bolted on outside of `useReactTable`.** The `sort` state lives in the URL via nuqs, and the column header renders a manual button that calls `props.onSortChange(key)` (`AdminApp.tsx:481-486`). The table itself doesn't know it's sorted. The idiomatic shape is `useReactTable({ state: { sorting }, onSortingChange, getSortedRowModel: getSortedRowModel() })`, which (a) gives you the multi-column sort UI for free and (b) keeps the column header `getCanSort()`/`getIsSorted()` semantics.

- **P1 — Other tabular views ignore `useReactTable` entirely.** `SessionsView` (`AdminApp.tsx:1542-1567`) builds an HTML `<Table>` by hand. Webhook deliveries, audit log entries, org members, and invitations are likewise rendered as `<article>` lists. If any of these grow filtering/sorting/column-pin requirements, they'll all duplicate the work.

- **P2 — No `createColumnHelper`.** Columns are built with raw object literals (`accessorKey`, `header`, `cell`). `createColumnHelper<AdminContentRecord>()` would give per-column type inference for `info.getValue()` (currently typed as `unknown` and stringified).

- **P3 — Generic `ContentTable` opportunity.** There is genuinely only one table that's rich enough to warrant `useReactTable` today; consolidation isn't urgent. The opportunity is to *extract* a generic `<DataTable columns={} data={} sort={} ...>` so that when sessions/members/audit-log inevitably grow, they have a path to use it.

### Virtual (`@tanstack/react-virtual`)

What's good
- `useVirtualizer` is used in two places: `ContentTable` body rows (`AdminApp.tsx:491`) and `VirtualRelationList` for relation-picker options (`AdminApp.tsx:946`). Both pass `count`, `getScrollElement`, `estimateSize`, `overscan` correctly and render `virtualizer.getVirtualItems().map(...)` with the `translateY` transform.

What to improve
- **P2 — Lists that can grow large are not virtualised.** The audit log list (`AdminApp.tsx:1125-1140`), webhook deliveries (`1329-1344`), media grid (`2708-2724`), org members (`2502-2530`), and invitation list (`2562-2574`) all use plain `rows.map(...)`. Audit log in particular is known to grow into the thousands. Per spec ("`useVirtualizer` for any list >100 items"), these are candidate sites.

- **P3 — `useVirtualizer` is invoked inside `ContentTable` even when the row count is small.** Cheap — just noting that for collections with <20 records, the virtual container's fixed 360px height (`AdminApp.tsx:546`) wastes vertical space.

### Form (`@tanstack/react-form`)

What's good
- The schema record editor uses `useForm({ defaultValues, onSubmit })` and renders `<form.Field>` with `formField.state.value` / `formField.handleBlur` (`AdminApp.tsx:769-832`). The submission re-keys on collection+record so a fresh form mounts per selection (line 446: `key={`${activeCollection}:${selected?.id ?? "new"}`}`).
- Autosave is correctly wired by reading `form.state.values` in the change handler (`AdminApp.tsx:784`).

What to improve
- **P1 — Every other form is hand-rolled `FormData`.** There are 9 other `<form onSubmit>` blocks that all do `event.preventDefault()` then `new FormData(event.currentTarget)` and a `fooInputFromForm()` parser:
  - `AuditView` filter form (`AdminApp.tsx:1099-1124`)
  - `WebhooksView` editor (`1276-1302`)
  - `ApiKeysView` editor (`1445-1466`)
  - `AuthView` (`1604-1614`) — login/register/forgot/magic-link/verify-email/2fa
  - `ContentTypesView` editor (`1736-1755`)
  - `I18nView` (`2346-2377`)
  - `OrganizationSettingsView` (`2460-2467`)
  - `OrganizationMembersView` per-member row (`2510-2525`)
  - `OrganizationInvitationsView` (`2581-2588`)

  All of these would benefit from `useForm`: free `isSubmitting`/`canSubmit`, validation per-field with `validators: { onChange: ... }`, no separate `fooInputFromForm` parser to keep in sync, and submission state shared with the disable-while-pending logic that is currently spread across `mutation.isPending` checks. Example minimal port of `WebhooksView`:

  ```tsx
  const form = useForm({
    defaultValues: { name: selected?.name ?? "", url: selected?.url ?? "", events: selected?.events.join(", ") ?? "content.published", secret: "", enabled: selected?.enabled ?? true },
    onSubmit: ({ value }) => selected ? updateMutation.mutate(toWebhookInput(value)) : createMutation.mutate(toWebhookInput(value))
  });
  ```

- **P2 — `form.Field` uses `children` prop (render-prop) instead of `form.Field` JSX children**. Functional, but the modern v1 idiom is `<form.Field name="...">{(field) => ...}</form.Field>` — minor.

- **P2 — No `form.Subscribe` for cross-field reactive UI.** The save button's disabled state is calculated from many `mutation.isPending` flags rather than `form.state.canSubmit && !form.state.isSubmitting`. With `useForm` adoption this falls out for free.

### Pacer (`@tanstack/react-pacer`)

What's good
- `useDebouncedCallback` is used at three sites with appropriate waits:
  - Autosave on schema form values: `wait: 500` (`AdminApp.tsx:775-777`).
  - Relation picker search: `wait: 300` (`AdminApp.tsx:931`).
  - Media search: `wait: 300` (`AdminApp.tsx:2649-2651`).
- All three patterns are correct: debounce updates a state setter or fires a mutation, not the input value itself, which keeps inputs uncontrolled-feeling but typed-responsive.

What to improve
- **P3 — `globalThis.setTimeout(() => setCopied(false), 1_500)` in `GeneratedSnippet`** (`AdminApp.tsx:1893`) is a hand-rolled timer for the "Copied!" feedback. Pacer's `useDebouncer`/`useTimeout` (if available) or just a `useEffect` cleanup would be cleaner. Low severity — it's the only setTimeout in the file.

- **P3 — Consider `useDebouncedValue` instead of `useDebouncedCallback` for the relation picker.** The current pattern stores both a `searchInput` (immediate) and a `search` (debounced) state and wires the callback to copy one to the other (`AdminApp.tsx:928-931, 974-975`). `useDebouncedValue(searchInput, 300)` collapses that to one declaration.

### Hotkeys (`@tanstack/react-hotkeys`)

What's good
- Two correct, well-scoped `useHotkeys` call sites:
  - Command palette toggle `Mod+K` in `AppFrame` (`AdminApp.tsx:105-107`).
  - Save (`Mod+S`) + Publish (`Mod+Shift+P`) in `SchemaForm`, conditionally enabled via `options.enabled` (`AdminApp.tsx:786-789`).
- Hotkey constants are exported (`EDITOR_HOTKEYS`, `SHELL_HOTKEYS`) which is friendly to documentation and tests.
- `preventDefault: true, stopPropagation: true, requireReset: true` is used consistently.

What to improve
- **P3 — Consider hotkeys for collection switching and record navigation.** Strapi/Contentful-style admins typically bind `g c` to go-to-content, `g m` to go-to-media (the command palette already documents these as `<CommandShortcut>G C</CommandShortcut>` at `AdminApp.tsx:198-199`, but no `useHotkeys` listener actually handles the chord). The shortcut hint is currently a lie.

## Top Anti-Patterns Flagged

1. **2,791-line `AdminApp.tsx` monolith holds every view component.** Every route file is a 6-line forwarder importing a named export. This makes the route system inert — routes can't own their own data, can't independently lazy-load, and the file is hostile to navigation. Highest-leverage refactor.

2. **`useForm` for one form, `FormData`-parsing for the other nine.** The library is in the bundle, the pattern is established for the schema editor, but every other CRUD form duplicates `event.preventDefault()` + `new FormData(event.currentTarget)` + a separate `fooInputFromForm()` parser per form. No validation, no submission state, no field-level dirty tracking.

3. **`QueryClient` constructed as module singleton; no router context.** `createRouter` is called without `context`, `__root.tsx` defines no `context` either, and the QueryClient at `AdminApp.tsx:30` is a top-level `new QueryClient(...)`. This locks out route loaders and breaks test isolation.

4. **`useReactTable` only in one place; `SessionsView` and others hand-roll HTML tables.** No `createColumnHelper`, no `getSortedRowModel`, sorting is a URL-state side-channel rather than table state.

5. **Auth gating happens both in `__root.beforeLoad` and again in `AppFrame`'s `useEffect`.** Two systems redirect, racing, causing visible auth flicker.

6. **Long lists in the audit log, media grid, deliveries, members are not virtualised** even though `useVirtualizer` is already a dependency and is used correctly elsewhere.

7. **Query keys are bare arrays of literals duplicated across 41 sites.** No key factory means typos in `["organization-members"]` vs `["organization_members"]` are undetectable.

8. **Manual `globalThis.setTimeout` in `GeneratedSnippet` for the "Copied!" toggle** when Pacer is already a dependency.

## Recommendations (priority-ordered)

1. **Split `AdminApp.tsx` per route.** Move each `*View` (ContentWorkspace, MediaView, WebhooksView, AuditView, ApiKeysView, SessionsView, ContentTypesView, I18nView, OrganizationSettingsView, OrganizationMembersView, AuthView, HealthView) into its own file under `apps/admin/src/components/` or — better — collapse the view into the route file itself so file-based routing becomes meaningful. This alone unlocks recommendations 2 and 3.

2. **Adopt router context + route loaders.** Add `createRootRouteWithContext<{ queryClient: QueryClient }>()` in `__root.tsx`, construct the QueryClient inside a component (or pass via boot state), and add `loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(...)` to every route that currently does its first `useQuery` inside a view component. `defaultPreload: "intent"` will then actually warm the cache on hover.

3. **Convert all remaining forms to `@tanstack/react-form`.** Start with the high-traffic ones — webhooks, api-keys, content-types, org settings — then auth and the smaller forms. Co-locate validation rules with each field. Wire submit-disabled to `form.state.canSubmit` and drop the per-mutation `isPending` plumbing where possible.

4. **Introduce a `queryKeys.ts` factory.** A single module exporting `keys.content.list(collection, search)`, `keys.organization.members()`, `keys.audit.list(filters)`, etc. Replace bare-array call sites and pin invalidations to `keys.content.all`-style prefixes.

5. **Wire sorting/filtering into `useReactTable` state instead of bolting it on.** Use `state.sorting` + `onSortingChange` synced to nuqs search params. Add `getSortedRowModel`/`getFilteredRowModel` so column headers participate. Extract a small `<DataTable>` that other tables (sessions, members, audit log) can adopt incrementally.

6. **Virtualize the audit log and the webhook delivery list.** Both are infinite-queried already and can easily exceed 100 entries. Re-use the `VirtualRelationList`-shaped helper.

7. **Delete the auth `useEffect` redirect in `AppFrame` and rely on `__root.beforeLoad`.** Add the same `beforeLoad` check to a `_authed` layout route if you want a clean unauthenticated/authenticated split.

8. **Replace the manual `setTimeout` in `GeneratedSnippet` with a Pacer-based timer or a small effect with cleanup**. Negligible but a 1-minute fix while you're in the file.

9. **Remove the hand-maintained `CommandPaletteRoute` and `NavLink` `to` string-literal unions.** TanStack Router's `Register` declaration already provides typesafe `to` props.

10. **Implement the `G C` / `G M` chord hotkeys the command palette advertises**, or remove the `<CommandShortcut>` labels so the UI doesn't lie.
