---
title: "feat: Content API — REST Routes, GraphQL, Filter Syntax, RBAC"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#5 Decoupled Static Admin SPA", "#8 Schema-Level RBAC", "#12 Content Query API"]
---

# feat: Content API — REST Routes, GraphQL, Filter Syntax, RBAC

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, architecture review, performance review, security review

### Key Improvements

1. Bound query/filter complexity before it reaches adapter code.
2. Reduce contract drift by feeding REST, GraphQL, docs, and SDK work from one shared manifest.
3. Add stronger security language for sensitive fields and GraphQL demand control.

## Summary

This plan implements the primary integration surface of `@hono-cms/core`: a dynamically generated REST API (Hono RPC, fully typed), a GraphQL API (Apollo Server via `@as-integrations/next`), a Strapi-compatible filter/pagination/populate query parser, and schema-level RBAC enforced uniformly across both surfaces. These seven implementation units form the complete public content API — every frontend, SDK client, and third-party integration talks exclusively to this layer.

The content API is the single most important thing to get right. Every downstream plan (SDK generation, admin SPA, webhooks, audit log, OpenAPI spec) depends on the contracts defined here.

---

## Problem Frame

`@hono-cms` must expose content data to the outside world via two surfaces that developers actually use: REST (for typed TypeScript clients using Hono RPC's `hc`) and GraphQL (for flexible cross-platform queries). Both surfaces must enforce the same access rules declared in collection definitions — not scattered through route handlers, not stored in a database permissions table, but co-located with the schema and applied uniformly before any handler or resolver executes.

The challenge is that these surfaces are generated dynamically from collection definitions at startup. There is no hand-written `GET /api/articles` route — the route factory reads the `ArticleCollection` definition and generates all eight REST endpoints for it. The GraphQL schema generator does the same from the same definition. RBAC middleware reads the same definition a third time to know what roles can do what. All three consumers must agree on the collection definition as the single source of truth.

### Scope

**In scope:**
- Hono RPC route factory for all eight REST verbs per collection
- `qs`-based query parser (filters, sort, pagination, populate, fields, locale)
- RBAC middleware: role resolution, operation check, field stripping, write rejection
- GraphQL schema generator (types, resolvers, input types) from collection definitions
- Apollo Server mounting via `startServerAndCreateHandler` at `/graphql`
- Cursor pagination as default; offset as fallback
- Draft/publish filter applied at handler level, not RBAC level

**Out of scope (handled in other plans):**
- Collection schema definition API (`defineCollection`, field types, validation) — Plan 005
- Database adapter interface and implementations — Plans 002–003
- Authentication session creation and management — Plan 004
- Cache layer for session and content caching — Plan 009
- Preview token generation (stored in cache) — Plan 009
- SDK type generation and `buildQuery` export — Plan 011
- OpenAPI spec generation — Plan 018
- Admin SPA implementation — Plans 007–008

---

## Key Technical Decisions

### 1. Why Hono RPC route factory (not hand-written routes per collection)

A CMS with 15 collections would need 120 hand-written route handlers (8 verbs × 15 collections) that are structurally identical except for the collection name and type parameter. The route factory collapses this to one function called 15 times. More importantly, the factory produces a **typed Hono router** — the return type carries the full request/response shape so `typeof collectionRouter` gives the `hc` client in the admin SPA complete end-to-end type safety with zero codegen. Hand-written routes lose this because TypeScript cannot infer a generic type across 15 separate files. The factory approach is the only way to make `hc<AppType>` work when the collection set is dynamic.

### 2. Why `qs` for filter syntax (Strapi compatibility, nested object support)

The bracket notation (`filters[author][name][$startsWith]=John`) cannot be parsed by the browser's native `URLSearchParams` or Hono's `c.req.query()` alone — both flatten nested brackets into opaque string keys. `qs.parse` correctly reconstructs the nested object `{ filters: { author: { name: { $startsWith: 'John' } } } }` from the raw query string. Adopting the Strapi filter syntax (same operators, same bracket convention) means developers familiar with Strapi migrate with zero learning curve, and existing Strapi SDK code for query building works against `@hono-cms` without modification. The `qs` library is the parser Strapi itself recommends — using the same library on both server (parse) and client (stringify) eliminates encoding edge cases.

### 3. Why cursor pagination as default (not offset)

Offset pagination requires a `COUNT(*)` query to compute total page count, which is expensive on large tables and inconsistent under concurrent inserts (a new record between page 1 and page 2 requests causes page 2 to return a duplicate). Cursor pagination is `O(1)` for the database (keyset scan rather than full-table count), stateless for the server (no session, no page state), and correct under concurrent writes. Edge runtimes (Cloudflare Workers, Vercel Edge) benefit most from the stateless property — there is no server memory to store pagination state between requests. Offset is retained as an explicitly opt-in mode for the admin list view where "jump to page N" is a UX requirement and the dataset is always admin-only (bounded and trusted).

### 4. Why GraphQL field-level permissions via null return (not schema removal)

Schema removal would require generating a different schema per role, which breaks Apollo Server's single-schema model and makes introspection useless — clients would need to introspect as each possible role to discover what fields exist. Returning `null` from a resolver for forbidden fields preserves the schema structure for all clients: a client can introspect and discover `_internalNotes` exists, include it in a query, and receive `null` when their role doesn't permit it — a clean, standard GraphQL authorization pattern (referenced in the GraphQL Authorization spec). The null-return approach is also consistent across REST (field stripping from response objects) and GraphQL (null-return from resolvers) — the underlying `checkFieldPermission` function is shared; the surface-specific presentation differs.

### 5. How the same RBAC logic applies uniformly to REST and GraphQL

A shared `checkPermission(collection, role, operation)` and `stripForbiddenFields(data, collection, role)` function is the core of the RBAC system. The Hono middleware calls these functions before handler execution and after response assembly. The Apollo Server context function calls `checkPermission` once at context-creation time per operation, then each resolver calls `stripForbiddenFields` or `checkFieldPermission` on its return value. The user's role is resolved once (from the better-auth session) and attached to the Hono context in the RBAC middleware; the Apollo context function reads it from `c.req.raw` headers (via `auth.api.getSession`). This means the role resolution logic runs exactly once per request regardless of surface, and all permission checks reference the same function with the same inputs.

---

## High-Level Technical Design

## Research Insights

**Best Practices:**
- Put validation schemas on every route so the same definitions can feed Hono typing, OpenAPI generation, and later SDK output.
- Parse filters into a bounded AST with caps on depth, node count, `$in` size, populate breadth, and sort count.
- Keep the RBAC policy layer pure and shared across REST and GraphQL exactly as the current design intends.

**Performance Considerations:**
- Add request-scoped batching/DataLoaders for relation expansion and GraphQL resolver work.
- Canonicalize parsed query objects before caching and adapter translation so equivalent queries share behavior and cache keys.

**Security Considerations:**
- Add hard GraphQL complexity, depth, and relation-populate limits.
- Introduce a `sensitive/internal` field classification for fields that should disappear from GraphQL/OpenAPI/SDK exposure entirely, not merely return `null`.

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

### Request flow through the content API

```
Incoming request
       │
       ▼
┌─────────────────────────────────────┐
│  Hono app (cms.handler)             │
│                                     │
│  app.use('*', authMiddleware)       │  ← Plan 004: extracts user+session
│  app.use('/api/*', rbacMiddleware)  │  ← U3: resolves role, attached to ctx
│                                     │
│  ┌─────────────────────────────┐   │
│  │  REST: /api/{collection}/*  │   │  ← U1: route factory per collection
│  │                             │   │
│  │  parseQueryParams(q)        │   │  ← U2: qs.parse → QueryParams
│  │  applyDraftFilter(params)   │   │  ← U7: status filter for public
│  │  adapter.findMany(params)   │   │  ← Plans 002–003: DB query
│  │  stripForbiddenFields(res)  │   │  ← U3: field stripping
│  │  return c.json(response)    │   │
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │  GraphQL: /graphql          │   │  ← U5: Apollo Server handler
│  │                             │   │
│  │  context fn: getSession()   │   │  ← reads role from headers
│  │  resolver: checkPermission  │   │  ← U3 shared fn
│  │  resolver: adapter.findMany │   │  ← Plans 002–003
│  │  resolver: null for fields  │   │  ← U4: field-level null return
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Route factory output shape (one collection)

```
sub-router (mounted at /api/articles)
  GET    /           → findMany  (parseQueryParams, draftFilter, stripFields)
  GET    /:id        → findOne   (populate, stripFields)
  POST   /           → create    (rejectForbiddenWriteFields, adapter.create)
  PUT    /:id        → update    (full replace, rejectForbiddenWriteFields)
  PATCH  /:id        → patch     (partial, rejectForbiddenWriteFields)
  DELETE /:id        → delete    (rbac: delete permission required)
  POST   /:id/publish    → publish   (draftAndPublish only, rbac: publish)
  POST   /:id/unpublish  → unpublish (draftAndPublish only, rbac: publish)
```

### Role resolution priority chain

```
better-auth session present?
       │ no                    │ yes
       ▼                       ▼
  role = 'public'      org membership role?
                               │ yes           │ no
                               ▼               ▼
                         role = org role   Admin plugin flag?
                                                │ yes     │ no
                                                ▼         ▼
                                          role='admin'  user.role claim?
                                                          │ yes    │ no
                                                          ▼        ▼
                                                    role=claim  role='authenticated'
```

### Cursor pagination mechanics

```
Encode cursor: base64(JSON.stringify({ id, createdAt }))

findMany with cursor:
  WHERE (createdAt, id) > (cursor.createdAt, cursor.id)
  ORDER BY createdAt ASC, id ASC
  LIMIT pageSize + 1          ← n+1 trick

If results.length > pageSize:
  hasMore = true
  nextCursor = encode(results[pageSize - 1])   ← last item before the +1
  data = results.slice(0, pageSize)
Else:
  hasMore = false
  nextCursor = undefined
  data = results
```

---

## Output Structure

```
packages/core/
  src/
    content/
      route-factory.ts          ← U1: createCollectionRoutes
      query-parser.ts           ← U2: parseQueryParams
      rbac-middleware.ts        ← U3: createRBACMiddleware
      rbac-core.ts              ← U3: checkPermission, stripForbiddenFields (shared)
      draft-filter.ts           ← U7: applyDraftFilter
      pagination.ts             ← U6: cursor encode/decode, buildCursorWhere
      index.ts                  ← re-exports
    graphql/
      schema-generator.ts       ← U4: generateGraphQLSchema
      type-builder.ts           ← U4: collection → GQL type definitions
      resolver-factory.ts       ← U4: collection → resolver map
      apollo-integration.ts     ← U5: createApolloHandler
      index.ts                  ← re-exports
    types/
      query-params.ts           ← U2: QueryParams, FilterNode, SortSpec, etc.
      rbac.ts                   ← U3: Role, Permission, FieldPermissions types
      response.ts               ← U6: PaginatedResponse, ContentResponse
  src/
    index.ts                    ← public exports (no Apollo/GQL imports)
  __tests__/
    content/
      route-factory.test.ts
      query-parser.test.ts
      rbac-middleware.test.ts
      rbac-core.test.ts
      draft-filter.test.ts
      pagination.test.ts
    graphql/
      schema-generator.test.ts
      apollo-integration.test.ts
```

---

## Implementation Units

### U1. Route factory — `createCollectionRoutes`

**Goal:** Produce a typed Hono sub-router for a single collection covering all eight REST endpoints. The factory is called once per collection at `createCMS` startup; the resulting routers are mounted at `/api/{collection.name}`.

**Requirements:**
- All eight REST verbs (findMany, findOne, create, update/PUT, patch/PATCH, delete, publish, unpublish)
- Publish/unpublish routes only present when `collection.draftAndPublish === true`
- Return type must be a fully typed Hono instance so `typeof router` carries request/response shapes
- Router is mounted at `/api/${collection.name}` in the parent Hono app
- Each route passes through RBAC middleware (U3) before handler logic
- Each write route rejects writes to `fieldPermissions`-restricted fields
- Query params parsed via U2 before handler sees them
- Draft filter (U7) applied in findMany and findOne handlers, not in RBAC

**Dependencies:** U2 (query parser), U3 (RBAC middleware), U6 (pagination), U7 (draft filter), DatabaseAdapter (Plans 002–003), CollectionDefinition (Plan 005)

**Files:**
- `packages/core/src/content/route-factory.ts` — factory implementation
- `packages/core/src/content/index.ts` — re-exports
- `packages/core/__tests__/content/route-factory.test.ts` — unit + integration tests

**Approach:**

The factory signature is `createCollectionRoutes<T extends CollectionDefinition>(collection: T, adapter: DatabaseAdapter): Hono`. The generic `T` parameter lets TypeScript infer the collection's field shape, which flows into the Hono route type parameters.

The factory creates a new `Hono` instance and registers each route with explicit input/output type annotations matching the collection's Zod schema. For Hono RPC typing to work, each route must be defined with `app.get('/', zValidator('query', querySchema), handler)` or equivalent — the validator attachment is what allows `typeof app` to carry the type to `hc`. The validated query schema is derived from the collection definition at factory call time.

Each handler follows this internal flow:
1. RBAC check runs first (delegated to U3 middleware already mounted on the sub-router)
2. Parse query params via `parseQueryParams` (U2)
3. Apply draft filter via `applyDraftFilter` (U7)
4. Call `adapter.findMany` / `adapter.findOne` / etc. with built query
5. Strip forbidden fields from response via `stripForbiddenFields` (U3 core)
6. Return `c.json({ data, meta })` using the standard response envelope

The parent `createCMS` function iterates all registered collections and calls `createCollectionRoutes` for each, then mounts each sub-router: `app.route('/api/' + collection.name, router)`. The aggregate type of all mounted routers is captured as `typeof app` and re-exported so `hc<typeof app>` in the admin SPA is fully typed.

For write operations (create, update, patch), the handler extracts the request body and calls `rejectForbiddenWriteFields(body, collection, role)` — a function from U3 core — before passing the sanitized body to the adapter. If any forbidden field is present in the write body, the route returns `400` with an error message identifying the field.

**Technical design (directional):**

```
createCollectionRoutes(collection, adapter):
  router = new Hono()
  querySchema = buildQueryZodSchema(collection)    // derived from collection fields

  router.get('/', zValidator('query', querySchema), async (c) => {
    role = c.get('role')                           // set by RBAC middleware
    params = parseQueryParams(c.req.query())
    params = applyDraftFilter(params, role, collection, c.req)
    result = await adapter.findMany(collection.name, params)
    data = result.items.map(item => stripForbiddenFields(item, collection, role))
    return c.json({ data, meta: { pagination: result.pagination } })
  })

  router.get('/:id', ...) → findOne + populate + stripFields
  router.post('/', ...) → rejectForbiddenWrites + adapter.create
  router.put('/:id', ...) → rejectForbiddenWrites + adapter.update (full)
  router.patch('/:id', ...) → rejectForbiddenWrites + adapter.patch (partial)
  router.delete('/:id', ...) → adapter.delete (RBAC already checked)

  if collection.draftAndPublish:
    router.post('/:id/publish', ...) → adapter.publish
    router.post('/:id/unpublish', ...) → adapter.unpublish

  return router
```

**Patterns to follow:**
- Hono's `zValidator` middleware for typed input validation
- `app.route()` for sub-router mounting (standard Hono composition)
- The route factory pattern used in SonicJS and HonoHub as prior art

**Test scenarios:**

- **Happy path — findMany:** Request `GET /api/articles` as a `public` role user. Expect `200` with `{ data: [...publishedOnly], meta: { pagination: { hasMore, cursor } } }`. Assert `_internalNotes` is absent from all items.
- **Happy path — findOne:** Request `GET /api/articles/123` as `editor`. Expect `200` with the full article object (including `status` field since editor has fieldPermission). Assert `_internalNotes` is absent (editor excluded from that fieldPermission).
- **Happy path — create:** `POST /api/articles` as `editor` with valid body. Expect `201` with the created article. Assert the DB record exists.
- **Happy path — publish:** `POST /api/articles/123/publish` as `admin`. Expect `200` with `status: 'published'`.
- **RBAC — public create attempt:** `POST /api/articles` with no auth token. Expect `403`.
- **RBAC — editor delete attempt:** `DELETE /api/articles/123` as `editor` (no delete permission). Expect `403`.
- **RBAC — public publish attempt:** `POST /api/articles/123/publish` with no auth token. Expect `403`.
- **RBAC — authenticated user reading private field:** `GET /api/articles/123` as `authenticated`. Expect `200` but `_internalNotes` absent.
- **Write rejection — forbidden field in body:** `POST /api/articles` as `editor` with `_internalNotes: 'secret'` in body. Expect `400` identifying `_internalNotes` as a forbidden write field.
- **Publish route on non-draftAndPublish collection:** `POST /api/tags/1/publish` on a collection with `draftAndPublish: false`. Expect `404` (route not registered).
- **RPC type inference:** TypeScript assertion (compile-time) that `hc<typeof app>` provides typed `.api.articles.$get()` with the correct query parameter types.
- **404 on missing record:** `GET /api/articles/nonexistent`. Expect `404`.
- **Integration — create then findOne:** Create an article via REST, then retrieve it via `findOne`. Assert data round-trips correctly including all populated relations.

**Verification:** All eight route types return correct HTTP status codes. Type-safe `hc` client can call all routes without type errors. RBAC middleware is confirmed to run before handler logic (verified by checking that a DB call is never made when RBAC rejects). Publish/unpublish routes absent for non-`draftAndPublish` collections.

---

### U2. Query parser — `parseQueryParams`

**Goal:** Parse the raw Hono query string (bracket-nested syntax) into a structured `QueryParams` object using `qs`. Validate filter operators against the allowed list; return `400` on unknown operators. Provide `buildQuery` helper for SDK consumers.

**Requirements:**
- Filters: nested bracket syntax, all 15 operators ($eq, $ne, $lt, $lte, $gt, $gte, $in, $nin, $contains, $notContains, $startsWith, $endsWith, $null, $notNull, $between)
- Sort: comma-separated `field:direction` pairs
- Pagination: cursor mode (`pagination[limit]` + `pagination[cursor]`) and offset mode (`pagination[pageSize]` + `pagination[page]`)
- Populate: simple comma list (`populate=author,tags`) and selective field populate (`populate[author][fields]=name,avatar`)
- Fields: comma-separated field selection (`fields=title,status,createdAt`)
- Locale: single string (`locale=es`)
- Unknown filter operator → `400` with operator name in error message
- `buildQuery` exported from SDK — typed `qs.stringify` wrapper that accepts a collection-typed query object

**Dependencies:** None (pure parsing, no DB or auth)

**Files:**
- `packages/core/src/content/query-parser.ts` — parser implementation
- `packages/core/src/types/query-params.ts` — `QueryParams` type definitions
- `packages/core/__tests__/content/query-parser.test.ts` — unit tests

**Approach:**

`parseQueryParams` accepts `Record<string, string | string[]>` (the raw output of `c.req.query()`) and calls `qs.parse` with `allowDots: false` and `allowPrototypes: false` to reconstruct the nested object. It then walks the parsed `filters` subtree depth-first, validating that every key beginning with `$` is in the `VALID_OPERATORS` set. If an unknown operator is found, it throws a `QueryParseError` which the route factory converts to a `400` response.

Sort parsing: split on `,`, then each segment on `:`. Direction defaults to `asc` if omitted. Unknown fields are not validated at parse time (the adapter is responsible for rejecting unknown fields at query time).

Pagination detection: if `pagination.cursor` or `pagination.limit` is present, mode is `cursor`. If `pagination.page` or `pagination.pageSize` is present, mode is `offset`. If both are present, cursor takes precedence. Default page size is `25`; max page size is `100` (configurable via `createCMS` options).

Populate parsing: a string `populate=author,tags` becomes `{ author: true, tags: true }`. A nested `populate[author][fields]=name,avatar` becomes `{ author: { fields: ['name', 'avatar'] } }`. Mixed forms are merged.

`buildQuery<T>(params: QueryInput<T>): string` — a wrapper around `qs.stringify` that is typed against a given collection's field type `T`. The type constraint ensures `filters` keys are valid field names at compile time. Exported from `packages/sdk/src/query.ts` (Plan 011) but implemented here and re-exported.

**Technical design (directional):**

```
const VALID_OPERATORS = new Set([
  '$eq', '$ne', '$lt', '$lte', '$gt', '$gte',
  '$in', '$nin', '$contains', '$notContains',
  '$startsWith', '$endsWith', '$null', '$notNull', '$between'
])

function parseQueryParams(raw): QueryParams:
  parsed = qs.parse(qs.stringify(raw))   // normalize: raw may already be parsed by hono

  validateOperators(parsed.filters)      // throws QueryParseError if unknown $op found

  return {
    filters: parsed.filters ?? {},
    sort:    parseSortSpec(parsed.sort),
    pagination: detectPaginationMode(parsed.pagination),
    populate:   parsePopulate(parsed.populate),
    fields:     parseFields(parsed.fields),
    locale:     parsed.locale ?? null,
  }
```

**Patterns to follow:**
- Strapi's `qs`-based query parsing (same library, same bracket convention)
- Validate-then-use pattern: full validation pass before any DB interaction

**Test scenarios:**

- **Simple filter:** Parse `filters[title][$contains]=hello`. Assert result contains `{ filters: { title: { $contains: 'hello' } } }`.
- **Nested relation filter:** Parse `filters[author][name][$startsWith]=John`. Assert `{ filters: { author: { name: { $startsWith: 'John' } } } }`.
- **Multi-operator filter:** Parse `filters[status][$eq]=published&filters[views][$gte]=100`. Assert both filters present in result.
- **`$in` operator:** Parse `filters[status][$in][]=draft&filters[status][$in][]=published`. Assert `{ status: { $in: ['draft', 'published'] } }`.
- **`$between` operator:** Parse `filters[createdAt][$between][]=2026-01-01&filters[createdAt][$between][]=2026-12-31`. Assert array value preserved.
- **`$null` operator:** Parse `filters[publishedAt][$null]=true`. Assert parsed correctly.
- **Unknown operator → 400:** Parse `filters[title][$fuzzy]=hello`. Assert `QueryParseError` thrown with `$fuzzy` in message.
- **Sort single field:** Parse `sort=createdAt:desc`. Assert `[{ field: 'createdAt', direction: 'desc' }]`.
- **Sort multiple fields:** Parse `sort=createdAt:desc,title:asc`. Assert both sort specs present in order.
- **Sort default direction:** Parse `sort=title`. Assert `direction: 'asc'`.
- **Cursor pagination:** Parse `pagination[limit]=20&pagination[cursor]=abc`. Assert `{ mode: 'cursor', limit: 20, cursor: 'abc' }`.
- **Offset pagination:** Parse `pagination[pageSize]=20&pagination[page]=3`. Assert `{ mode: 'offset', pageSize: 20, page: 3 }`.
- **Cursor takes precedence:** Parse both cursor and offset params. Assert mode is `cursor`.
- **Max page size clamping:** Parse `pagination[limit]=500`. Assert clamped to `100`.
- **Simple populate:** Parse `populate=author,tags`. Assert `{ author: true, tags: true }`.
- **Selective populate:** Parse `populate[author][fields]=name,avatar`. Assert `{ author: { fields: ['name', 'avatar'] } }`.
- **Fields selection:** Parse `fields=title,status,createdAt`. Assert `['title', 'status', 'createdAt']`.
- **Locale:** Parse `locale=es`. Assert `locale: 'es'`.
- **Empty query string:** Parse `{}`. Assert all fields at defaults (empty filters, default pagination, no sort).
- **`buildQuery` round-trip:** Call `buildQuery({ filters: { title: { $contains: 'hello' } } })`. Parse the result with `parseQueryParams`. Assert same structure recovered.
- **Prototype pollution guard:** Parse `filters[__proto__][$eq]=polluted`. Assert the parsed object's prototype is not modified and `Object.prototype` remains clean. Verify `allowPrototypes: false` is enforced.
- **Constructor injection guard:** Parse `filters[constructor][prototype][$eq]=polluted`. Assert same prototype cleanliness guarantee.

**Verification:** All 15 operators parse without error. Unknown operators produce errors. Sort, pagination mode detection, populate variants, and field selection all produce correct structures. `buildQuery` output is parseable by `parseQueryParams` without loss.

---

### U3. RBAC middleware — `createRBACMiddleware`

**Goal:** A Hono middleware factory that resolves the caller's role from the better-auth session, checks operation permission against the collection definition, and attaches the role to context. Shared pure functions (`checkPermission`, `stripForbiddenFields`, `rejectForbiddenWriteFields`) are consumed by REST route handlers and GraphQL resolvers.

**Requirements:**
- Role resolution: org membership → admin flag → role claim → `'authenticated'` → `'public'`
- Unauthenticated requests (no session) resolve to `'public'`
- Operation check: `collection.permissions[role][operation]` — `403` if falsy or absent
- Field stripping on response: remove keys listed in `fieldPermissions` for roles not in the allowed list
- Write rejection: `400` if request body contains a field listed in `fieldPermissions` for a role not in the allowed list
- `public` role handling: unauthenticated `GET` to a collection with `permissions.public.read: true` is allowed
- Middleware result (resolved role) stored in Hono context via `c.set('role', role)` and `c.set('user', user)` for downstream handlers
- Shared `checkPermission` and `stripForbiddenFields` functions work identically for GraphQL resolvers

**Dependencies:** better-auth session from Plan 004 auth middleware (sets `c.get('session')` and `c.get('user')`), CollectionDefinition from Plan 005

**Files:**
- `packages/core/src/content/rbac-middleware.ts` — `createRBACMiddleware` factory
- `packages/core/src/content/rbac-core.ts` — pure functions: `resolveRole`, `checkPermission`, `stripForbiddenFields`, `rejectForbiddenWriteFields`, `checkFieldPermission`
- `packages/core/src/types/rbac.ts` — `Role`, `Permission`, `FieldPermissions` types
- `packages/core/__tests__/content/rbac-middleware.test.ts`
- `packages/core/__tests__/content/rbac-core.test.ts`

**Approach:**

`createRBACMiddleware(collections: CollectionDefinition[])` returns a Hono middleware. The middleware receives every request to `/api/*` and performs these steps in sequence:

**Step 1 — Extract session.** Read `c.get('session')` and `c.get('user')` (set by the auth middleware from Plan 004). If both are undefined, the request is unauthenticated.

**Step 2 — Resolve role.** Call `resolveRole(user, session)`:
- If no session: return `'public'`
- If `session.activeOrganization?.role` is set: return that role (e.g., `'admin'`, `'editor'`, `'member'`)
- If `user.isAdmin === true` (better-auth Admin plugin flag): return `'admin'`
- If `user.role` is a non-empty string: return `user.role`
- Otherwise: return `'authenticated'`

Store the resolved role: `c.set('role', role)`.

**Step 3 — Identify collection.** Parse the collection name from `c.req.path` (the segment after `/api/`). Look up the collection in the middleware's internal map keyed by `collection.name`.

**Step 4 — Identify operation.** Map the HTTP method and path pattern to an operation name:
- `GET /:collection` → `'read'`
- `GET /:collection/:id` → `'read'`
- `POST /:collection` → `'create'`
- `PUT /:collection/:id` or `PATCH /:collection/:id` → `'update'`
- `DELETE /:collection/:id` → `'delete'`
- `POST /:collection/:id/publish` or `POST /:collection/:id/unpublish` → `'publish'`

**Step 5 — Check permission.** Call `checkPermission(collection, role, operation)`:
```
permissions = collection.permissions[role] ?? collection.permissions['authenticated'] ?? {}
return permissions[operation] === true
```
If `false`: return `c.json({ error: 'Forbidden' }, 403)`.

The middleware then calls `next()`. Field stripping and write rejection are applied in the route handler after the adapter call, not in the middleware, because the middleware doesn't have the response body yet.

**Shared pure functions (rbac-core.ts):**

`checkPermission(collection, role, operation)` — as above. Returns boolean.

`stripForbiddenFields<T extends Record<string, unknown>>(data: T, collection, role)` — iterates `collection.fieldPermissions`, and for each field where `role` is not in the allowed roles array, deletes that key from a shallow copy of `data`. Works recursively only one level deep (nested relations are stripped at the relation resolver level). Returns the sanitized copy.

`checkFieldPermission(collection, fieldName, role)` — returns `true` if `role` appears in `collection.fieldPermissions[fieldName]` (or if the field has no `fieldPermissions` entry). Used by GraphQL resolvers to decide whether to return `null`.

`rejectForbiddenWriteFields(body, collection, role)` — iterates `collection.fieldPermissions`, and for each field where `role` is not in the allowed list, checks if that key is present in `body`. If so, throws a `ForbiddenFieldWriteError`. Called by write route handlers before the body reaches the adapter.

**Patterns to follow:**
- better-auth's `auth.api.getSession({ headers })` for session retrieval in the Apollo context function (U5)
- Hono's `c.set`/`c.get` for typed context variables
- Middleware-first RBAC (check once, use everywhere) rather than per-handler checks

**Test scenarios:**

- **Public read allowed:** `GET /api/articles` with no auth. Collection has `permissions.public.read: true`. Expect middleware calls `next()`.
- **Public read denied:** `GET /api/articles` with no auth. Collection has `permissions: {}` (no public). Expect `403`.
- **Authenticated read:** `GET /api/articles` with valid auth token, role `'authenticated'`. Collection has `permissions.authenticated.read: true`. Expect `next()`.
- **Editor create allowed:** `POST /api/articles` as `editor`. Collection has `permissions.editor.create: true`. Expect `next()`.
- **Editor delete denied:** `DELETE /api/articles/1` as `editor`. Collection lacks `permissions.editor.delete`. Expect `403`.
- **Admin all operations:** `DELETE /api/articles/1` as `admin`. Collection has `permissions.admin.delete: true`. Expect `next()`.
- **Org membership role:** Session has `activeOrganization.role = 'editor'`. Assert `resolveRole` returns `'editor'`.
- **Admin plugin flag:** `user.isAdmin = true`, no org. Assert `resolveRole` returns `'admin'`.
- **Role claim fallback:** User has `role: 'editor'` claim, no org, not admin. Assert `resolveRole` returns `'editor'`.
- **Default to authenticated:** User has no org, not admin, no role claim. Assert `resolveRole` returns `'authenticated'`.
- **stripForbiddenFields — non-admin:** Call `stripForbiddenFields({ title: 'Hello', _internalNotes: 'secret' }, collection, 'editor')`. Assert result lacks `_internalNotes`, retains `title`.
- **stripForbiddenFields — admin:** Same call with role `'admin'`. Assert `_internalNotes` is present.
- **stripForbiddenFields — status field for public:** Article has `fieldPermissions.status: ['editor', 'admin']`. Call with role `'public'`. Assert `status` absent from result.
- **rejectForbiddenWriteFields — blocked field:** Editor submits `{ title: 'New', _internalNotes: 'inject' }`. Assert `ForbiddenFieldWriteError` thrown.
- **rejectForbiddenWriteFields — allowed field:** Editor submits `{ title: 'New', status: 'draft' }`. `status` is in editor's fieldPermissions. Assert no error.
- **checkPermission correctness:** Verify all combinations (4 roles × 6 operations) return expected boolean based on the test collection's permissions matrix.
- **Publish operation RBAC:** `POST /api/articles/1/publish` as `editor` (editor has no `publish` permission). Expect `403`.
- **Role attached to context:** After successful RBAC check, `c.get('role')` returns the resolved role. Verified by a downstream handler spy.

**Verification:** All role resolution paths produce the correct role. All permission checks match the collection definition. `stripForbiddenFields` never mutates the input object. `rejectForbiddenWriteFields` throws on every forbidden field regardless of where in the body the field appears. Shared functions produce identical results when called from REST handlers vs. GraphQL resolvers with the same inputs.

---

### U4. GraphQL schema generator — `generateGraphQLSchema`

**Goal:** From a list of `CollectionDefinition` objects, produce a complete Apollo Server-compatible `{ typeDefs, resolvers }` pair. Each collection gets full CRUD + publish/unpublish operations. Resolvers delegate to the same `DatabaseAdapter` methods the REST routes use.

**Requirements:**
- Per collection: one GraphQL type, `CreateInput`, `UpdateInput`, `FilterInput`, `PaginationInput`
- Per collection query: `findOne(id: ID!): CollectionType`, `findMany(filters, sort, pagination): CollectionFindManyResult`
- Per collection mutation: `create(data: CreateInput!): CollectionType`, `update(id: ID!, data: UpdateInput!): CollectionType`, `delete(id: ID!): Boolean`, `publish(id: ID!): CollectionType`, `unpublish(id: ID!): CollectionType`
- `publish`/`unpublish` mutations only generated for `draftAndPublish: true` collections
- Output types for populated variants: `ArticleWithAuthor` type for `findMany` with `populate: ['author']`
- `findMany` result shape: `{ data: [CollectionType], meta: { pagination: { total, cursor, hasMore } } }`
- Resolvers call `adapter.findMany`, `adapter.findOne`, `adapter.create`, `adapter.update`, `adapter.delete`, `adapter.publish`, `adapter.unpublish`
- Resolvers call `checkPermission` (U3 core) using the role from Apollo context
- Field-level: resolvers for `fieldPermissions`-restricted fields return `null` for unauthorized roles (not schema removal)
- `FilterInput` type exposes all 15 operators as optional input fields

**Dependencies:** U3 (rbac-core shared functions), DatabaseAdapter (Plans 002–003), CollectionDefinition (Plan 005)

**Files:**
- `packages/core/src/graphql/schema-generator.ts` — top-level generator
- `packages/core/src/graphql/type-builder.ts` — builds GraphQL SDL strings from a collection definition
- `packages/core/src/graphql/resolver-factory.ts` — builds resolver map from a collection definition
- `packages/core/__tests__/graphql/schema-generator.test.ts`

**Approach:**

`generateGraphQLSchema(collections, adapter)` returns `{ typeDefs: DocumentNode, resolvers: Resolvers }`.

**Type generation (type-builder.ts):**

`buildCollectionTypeDefs(collection)` produces a string of GraphQL SDL. For a collection named `articles` with fields `title: z.string()`, `status: z.enum([...])`, `author: relation(authors)`:

- Type `Article { id: ID! title: String! status: String author: Author createdAt: String! updatedAt: String! }`
- Input `ArticleCreateInput { title: String! status: String }`  (id, createdAt, updatedAt omitted)
- Input `ArticleUpdateInput { title: String status: String }` (all optional for patch semantics; PUT uses same input, the adapter handles full-replace semantics)
- Input `ArticleFilterInput { title: StringFilter status: StringFilter ... }` where `StringFilter { eq, ne, contains, notContains, startsWith, endsWith, in, nin, null, notNull }` and `NumberFilter { eq, ne, lt, lte, gt, gte, in, nin, between, null, notNull }`
- Type `ArticleFindManyResult { data: [Article!]! meta: PaginationMeta! }`
- Query fields: `article(id: ID!): Article` and `articles(filters: ArticleFilterInput, sort: [String], pagination: PaginationInput): ArticleFindManyResult`
- Mutation fields: `createArticle(data: ArticleCreateInput!): Article!`, `updateArticle(id: ID!, data: ArticleUpdateInput!): Article!`, `deleteArticle(id: ID!): Boolean!`, and if `draftAndPublish`: `publishArticle(id: ID!): Article!`, `unpublishArticle(id: ID!): Article!`

Shared scalar types and the `PaginationMeta`, `PaginationInput` types are generated once and merged into the final `typeDefs`.

Zod-to-GraphQL field type mapping:
- `z.string()` → `String`
- `z.number()` → `Float` (or `Int` if `.int()` is chained)
- `z.boolean()` → `Boolean`
- `z.date()` or `z.string().datetime()` → `String` (ISO 8601; no custom scalar for simplicity in v1)
- `z.enum(values)` → inline `String` with a comment listing valid values (enum SDL types are also generated)
- Relation fields → the related collection's type name

**Resolver generation (resolver-factory.ts):**

`buildCollectionResolvers(collection, adapter)` returns the resolver map for one collection. The Query and Mutation resolver functions:

1. Extract `{ role, user }` from Apollo context (set by the context function in U5)
2. Call `checkPermission(collection, role, operation)` — throw `GraphQLError` with code `FORBIDDEN` if false
3. Call the appropriate adapter method with the parsed args
4. Apply `stripForbiddenFields` to the result (or each item in the array)
5. Return the result

Individual field resolvers for `fieldPermissions`-restricted fields:
```
Article: {
  _internalNotes: (parent, args, context) =>
    checkFieldPermission(collection, '_internalNotes', context.role)
      ? parent._internalNotes
      : null
}
```

This is the null-return pattern: the field is always present in the schema; the resolver conditionally returns `null` based on the caller's role.

**Patterns to follow:**
- Apollo Server `makeExecutableSchema` for merging type defs and resolvers
- Resolver chaining pattern from Apollo docs (parent → resolver chain)
- The shared `checkPermission` / `stripForbiddenFields` from U3 — same functions, no duplication

**Test scenarios:**

- **Type generation — basic collection:** Generate type defs for a collection with `title: z.string()` and `status: z.enum(['draft', 'published'])`. Assert SDL contains `Article`, `ArticleCreateInput`, `ArticleUpdateInput`, `ArticleFilterInput`, `ArticleFindManyResult`.
- **Type generation — relation field:** Collection with `author: relation('authors')`. Assert `Article` type has `author: Author` field.
- **Type generation — draftAndPublish = false:** Mutations SDL lacks `publishArticle` and `unpublishArticle`.
- **Type generation — draftAndPublish = true:** SDL includes both publish mutations.
- **Resolver — findMany happy path:** Mock adapter returns `{ items: [article1], pagination }`. Call resolver as `editor`. Assert response is `{ data: [article1WithStrippedFields], meta: { pagination } }`.
- **Resolver — findMany as public, draft/publish filter:** Adapter called with `status: 'published'` constraint. Verify adapter receives the filter (integration with U7 draft-filter logic wired into the resolver).
- **Resolver — findOne RBAC pass:** `admin` calls `article(id: "1")`. `checkPermission` returns true. Adapter called with id. Response returned with all fields.
- **Resolver — findOne RBAC block:** `public` calls `article(id: "1")` on a collection with `permissions.public.read: false`. Expect `GraphQLError` with `FORBIDDEN` code.
- **Field-level null return — non-admin:** `editor` queries `article { _internalNotes }`. Assert `_internalNotes: null` in response (not a resolver error, just null).
- **Field-level null return — admin:** `admin` queries same. Assert `_internalNotes` has the actual value.
- **Resolver — create mutation:** `POST createArticle(data: { title: "New" })` as `editor`. Assert adapter's `create` called with sanitized body. Response is the created article.
- **Resolver — create RBAC block:** `public` calls `createArticle`. Expect `FORBIDDEN`.
- **Resolver — delete admin only:** `deleteArticle(id: "1")` as `admin`. Assert adapter `delete` called. Response `true`.
- **Resolver — delete editor denied:** `deleteArticle(id: "1")` as `editor`. Expect `FORBIDDEN`.
- **Resolver — update forbidden field in args:** `updateArticle(id: "1", data: { _internalNotes: "inject" })` as `editor`. Assert `ForbiddenFieldWriteError` thrown (or equivalent `GraphQLError`).
- **Schema merging — multiple collections:** `generateGraphQLSchema([articles, tags, authors], adapter)`. Assert the merged schema compiles without type conflicts, all three collection query/mutation fields are present.

**Verification:** Schema compiles via `makeExecutableSchema` without errors. Each resolver function has correct arity (parent, args, context). All 15 filter operators appear in each collection's `FilterInput`. Forbidden field resolvers always return `null` for unauthorized roles and never `undefined` (which GraphQL treats differently).

---

### U5. Apollo Server integration — `createApolloHandler`

**Goal:** Mount Apollo Server at `/graphql` inside the Hono app created by `createCMS`. Wire the better-auth session into the Apollo context function. Expose GraphQL field-level permissions via resolver-level null return. The developer never imports Apollo Server or `@as-integrations/next`.

**Requirements:**
- `createApolloHandler(schema, auth)` returns a function `(req: Request) => Promise<Response>`
- Handler called with `c.req.raw` — the native WinterTC `Request` object
- Apollo context function calls `auth.api.getSession({ headers: req.headers })` to get the better-auth session
- Context object passed to all resolvers: `{ user, session, role }` — role resolved via `resolveRole` (U3 core)
- `graphql: true` in `createCMS` config enables the handler; `graphql: false` (default) skips it entirely
- Introspection enabled by default; playground endpoint at `/graphql` in development (configurable)
- Handler mounted with `app.all('/graphql', ...)` (both GET and POST methods)
- Handler uses `startServerAndCreateHandler` from `@as-integrations/next` — this is the only call site

**Dependencies:** U3 (resolveRole from rbac-core), U4 (generateGraphQLSchema), better-auth instance (Plan 004)

**Files:**
- `packages/core/src/graphql/apollo-integration.ts` — `createApolloHandler`
- `packages/core/__tests__/graphql/apollo-integration.test.ts`

**Approach:**

`createApolloHandler` is called once inside `createCMS` during startup:

```
if config.graphql:
  schema = generateGraphQLSchema(collections, adapter)   // U4
  server = new ApolloServer({ schema })
  await server.start()
  graphqlHandler = startServerAndCreateHandler(server, {
    context: async ({ request }) => {
      session = await auth.api.getSession({ headers: request.headers })
      user = session?.user ?? null
      role = resolveRole(user, session)     // U3 rbac-core
      return { user, session, role }
    }
  })
  app.all('/graphql', async (c) => {
    return graphqlHandler(c.req.raw)
  })
```

The `context` function receives the raw `Request` object from `startServerAndCreateHandler`. It calls `auth.api.getSession` — the same call the REST auth middleware makes, so session resolution is consistent between surfaces. The resolved `role` in the context is the same role the RBAC middleware attaches to `c.set('role')` for REST requests.

**WinterTC compatibility note:** `startServerAndCreateHandler` uses the Web Standards `Request`/`Response` API. `c.req.raw` is the native Hono `Request` — a real `Request` object on all runtimes (CF Workers, Vercel Edge, Node.js via `@hono/node-server`). The handler returns a native `Response`, which Hono returns directly via `return graphqlHandler(c.req.raw)`. No adapter layer needed.

**Apollo Server startup lifecycle:** `ApolloServer.start()` is async and must be awaited before `startServerAndCreateHandler` is called. `createCMS` is already async (it performs DB schema checks). Apollo startup slots naturally into the existing async boot sequence.

**Introspection and playground:** Introspection is always on in development (`process.env.NODE_ENV !== 'production'`). In production, it is off by default but can be enabled via `graphql: { introspection: true }`. The Apollo Sandbox (Apollo's hosted GraphQL IDE) is the recommended playground — accessed by pointing the browser to the `/graphql` endpoint in development. No Apollo Studio plugin required.

**Patterns to follow:**
- `@as-integrations/next` documentation: `startServerAndCreateHandler` is the sole integration point
- better-auth's `auth.api.getSession` pattern (consistent with Plan 004 auth middleware)
- Hono's `app.all` for method-agnostic route mounting

**Test scenarios:**

- **Happy path — query via POST:** `POST /graphql` with `{ query: "{ articles { data { id title } } }" }` as an unauthenticated user on a collection with `public.read: true`. Expect `200` with data.
- **Happy path — authenticated query:** `POST /graphql` with valid `Authorization` header. Context function resolves the session. Resolver receives `{ user, session, role: 'editor' }` in context.
- **RBAC via context — forbidden operation:** Authenticated `editor` sends a `deleteArticle` mutation. Resolver checks `checkPermission` and throws `FORBIDDEN`. Response has `errors[0].extensions.code = 'FORBIDDEN'`.
- **Unauthenticated mutation blocked:** No auth token, `createArticle` mutation. Collection has no `public.create`. Expect `FORBIDDEN` error.
- **Field-level null return — integration:** `public` user queries `{ articles { data { _internalNotes } } }`. Response: `{ _internalNotes: null }` for each item. No error thrown.
- **Handler mounts on both GET and POST:** Introspection query sent via `GET /graphql?query={...}`. Expect `200`.
- **`c.req.raw` is a native Request:** Verify that the `Request` passed to `graphqlHandler` has `.headers`, `.method`, `.body` matching the original request (smoke test).
- **Apollo startup awaited:** If `ApolloServer.start()` has not resolved, subsequent requests queue or fail gracefully (not a crash). Verify no `"Must await server.start()"` errors in logs.
- **`graphql: false` skips mounting:** If `createCMS({ graphql: false })`, no route is registered at `/graphql`. Expect `404`.
- **Context session forwarding:** Mock `auth.api.getSession` to return a specific user. Assert resolver context contains that user object.
- **Introspection disabled in production:** With `NODE_ENV=production` and no explicit `introspection: true`, `POST /graphql { query: "{ __schema { types { name } } }" }` returns a `400` or `GRAPHQL_VALIDATION_FAILED` error.

**Verification:** Handler returns native `Response` objects (not Hono `Context` responses). Apollo Server starts without errors. Session resolved in context matches the session the REST auth middleware would resolve for the same request. RBAC errors surface as GraphQL errors with `FORBIDDEN` extension code, not as HTTP 403 (GraphQL spec requires `200` with errors array).

---

### U6. Cursor pagination implementation

**Goal:** Implement cursor-based pagination as the default for `findMany`. Cursor encodes the last-seen `{ id, createdAt }` in base64 JSON. Offset pagination is retained as an explicitly activated fallback. Both modes use the standard response envelope `{ data, meta: { pagination } }`.

**Requirements:**
- Cursor encoding: `base64url(JSON.stringify({ id, createdAt }))` — URL-safe, no padding
- `findMany` with cursor: keyset scan `(createdAt, id) > (cursor.createdAt, cursor.id)`, `ORDER BY createdAt ASC, id ASC`, `LIMIT n+1`
- n+1 trick: fetch one extra record; if received, `hasMore = true`, drop the extra, encode the last kept record as `nextCursor`
- Response envelope: `{ data: T[], meta: { pagination: { cursor?: string, hasMore: boolean, total?: number } } }`
- `total` is `undefined` in cursor mode (no `COUNT(*)` query issued)
- Offset pagination: `OFFSET (page-1) * pageSize LIMIT pageSize` + one `COUNT(*)` query for `total`
- `total` is always present in offset mode
- Default mode is cursor when no mode is specified by the client
- Cursor is opaque to the client — the client must treat it as a string token, not parse it

**Dependencies:** U2 (PaginationSpec from QueryParams), DatabaseAdapter (Plans 002–003) — the adapter receives the pagination spec and constructs the actual SQL; this unit defines the spec and encoding contracts, not the SQL

**Files:**
- `packages/core/src/content/pagination.ts` — encode/decode cursor, `buildPaginationSpec`
- `packages/core/src/types/response.ts` — `PaginatedResponse<T>`, `PaginationMeta` types
- `packages/core/__tests__/content/pagination.test.ts`

**Approach:**

`encodeCursor({ id, createdAt })`: serialize the object to JSON, then base64url-encode (using `btoa` in edge runtimes or `Buffer.from(...).toString('base64url')` in Node.js — abstract behind a single `b64encode` utility that chooses based on runtime detection or a `TextEncoder` polyfill).

`decodeCursor(token: string): { id: string, createdAt: string }`: reverse. Throws `InvalidCursorError` on malformed input. The route handler converts `InvalidCursorError` to a `400` response.

`buildPaginationSpec(parsed: PaginationParams)`: converts the `QueryParams.pagination` structure into the object the adapter receives: either `{ mode: 'cursor', limit: n, after: { id, createdAt } | null }` (for the first page, `after` is null) or `{ mode: 'offset', page: n, pageSize: n }`.

The adapter (Plans 002–003) is responsible for constructing the WHERE clause and issuing the COUNT query. This unit only defines the spec shape and the cursor codec.

`buildPaginationMeta(items: T[], spec, total?: number)`: after the adapter returns results, this function applies the n+1 trick:
- If `spec.mode === 'cursor'` and `items.length > spec.limit`: `hasMore = true`, `nextCursor = encodeCursor(items[spec.limit - 1])`, `data = items.slice(0, spec.limit)`
- If `spec.mode === 'cursor'` and `items.length <= spec.limit`: `hasMore = false`, `nextCursor = undefined`, `data = items`
- If `spec.mode === 'offset'`: `hasMore = (page * pageSize) < total`, `data = items`, `total = total` (from adapter COUNT)

**Response envelope shape:**
```
{
  data: T[],
  meta: {
    pagination: {
      hasMore: boolean,
      cursor?: string,          // only in cursor mode, only when hasMore
      total?: number,           // only in offset mode
      page?: number,            // only in offset mode
      pageSize?: number,        // only in offset mode
    }
  }
}
```

**Technical design (directional):**

```
// First page (no cursor provided)
paginationSpec = { mode: 'cursor', limit: 25, after: null }
adapterResult = adapter.findMany(collection, { ...queryParams, pagination: paginationSpec })
// adapter fetches limit+1 items
meta = buildPaginationMeta(adapterResult.items, paginationSpec)
// meta = { hasMore: true, cursor: 'eyJpZCI6IjI1Ii4...' }

// Subsequent page
paginationSpec = { mode: 'cursor', limit: 25, after: decodeCursor(incomingCursor) }
// adapter: WHERE (createdAt, id) > (after.createdAt, after.id) ORDER BY createdAt, id LIMIT 26
```

**Patterns to follow:**
- Relay cursor spec (opaque base64-encoded cursor) for client compatibility
- Keyset pagination over `(createdAt, id)` — composite index assumed on the content tables

**Test scenarios:**

- **encodeCursor round-trip:** Encode `{ id: '123', createdAt: '2026-01-01T00:00:00Z' }`. Decode. Assert same object recovered.
- **encodeCursor is URL-safe:** Assert result contains no `+`, `/`, or `=` characters.
- **decodeCursor — malformed input:** Pass `'not-base64'`. Assert `InvalidCursorError` thrown.
- **decodeCursor — truncated:** Pass a valid base64 string that decodes to `{}` (missing fields). Assert `InvalidCursorError`.
- **buildPaginationMeta — first page, hasMore:** Pass 26 items with `limit: 25`. Assert `data.length === 25`, `hasMore === true`, `cursor` is set.
- **buildPaginationMeta — last page:** Pass 20 items with `limit: 25`. Assert `data.length === 20`, `hasMore === false`, `cursor` is `undefined`.
- **buildPaginationMeta — exact page size:** Pass exactly 25 items with `limit: 25`. Assert `hasMore === false` (n+1 means 25 items means no 26th was found).
- **buildPaginationMeta — empty page:** Pass `[]` with any limit. Assert `data === []`, `hasMore === false`.
- **Offset mode meta — mid-set:** `total: 100`, `page: 2`, `pageSize: 20`. Assert `hasMore === true`.
- **Offset mode meta — last page:** `total: 100`, `page: 5`, `pageSize: 20`. Assert `hasMore === false`.
- **Offset mode meta — total present:** Assert `meta.pagination.total === 100`.
- **Cursor mode — total absent:** Cursor mode response. Assert `meta.pagination.total` is `undefined`.
- **buildPaginationSpec — cursor mode input:** `pagination[limit]=20&pagination[cursor]=abc`. Assert `{ mode: 'cursor', limit: 20, after: decodeCursor('abc') }`.
- **buildPaginationSpec — offset mode input:** `pagination[page]=3&pagination[pageSize]=10`. Assert `{ mode: 'offset', page: 3, pageSize: 10 }`.
- **buildPaginationSpec — no pagination params:** Assert default cursor mode with limit 25, after null.
- **Integration — two-page cursor walk:** Request page 1 (no cursor). Extract `meta.pagination.cursor`. Request page 2 with that cursor. Assert page 2 items are different from page 1 and there is no overlap.
- **Integration — offset page 2 has no duplicates:** Offset page 1 items differ from offset page 2 items (validates that `OFFSET` is correctly applied by the adapter).

**Verification:** `encodeCursor` output is stable (same input → same output). `decodeCursor` is the exact inverse. n+1 trick correctly produces `hasMore` for both edge cases (exactly pageSize items, pageSize+1 items). Offset `total` is always numeric in offset mode. REST response envelope matches the specified shape exactly.

---

### U7. Draft/publish filter — `applyDraftFilter`

**Goal:** Automatically inject `status = 'published'` into `findMany` and `findOne` queries for public and unauthenticated requests on collections with `draftAndPublish: true`. Remove the filter for admin sessions and valid preview tokens. The filter is applied at the route handler level, after RBAC has already verified the role — it is a separate concern from access control.

**Requirements:**
- Only active for collections with `draftAndPublish: true`
- Unauthenticated (`public`) and `'authenticated'` roles: inject `filters.$and = [{ status: { $eq: 'published' } }]` (merged with existing filters)
- `'editor'` and `'admin'` roles: no filter injected (see all records including drafts)
- Preview token: if `?preview=<token>` is present, verify token against cache (Plan 009 provides the verification function); if valid, skip the draft filter for that specific document id
- The filter is applied in the REST route handler and in the GraphQL resolver for `findMany`/`findOne`
- Preview token verification is behind a `verifyCacheToken` abstraction — the actual cache call is provided by Plan 009; this unit defines the integration point
- Collections with `draftAndPublish: false` are unaffected — no `status` field exists

**Dependencies:** U2 (filter merge), U3 (role from context), Plan 009 (preview token verification — stub interface in this plan, implemented in Plan 009)

**Files:**
- `packages/core/src/content/draft-filter.ts` — `applyDraftFilter`
- `packages/core/__tests__/content/draft-filter.test.ts`

**Approach:**

`applyDraftFilter(params: QueryParams, role: Role, collection: CollectionDefinition, req: Request, tokenVerifier?: TokenVerifier): QueryParams`

The function returns a (possibly modified) `QueryParams`. It does not mutate the input.

Logic:
1. If `collection.draftAndPublish !== true`: return `params` unchanged.
2. If role is `'admin'` or `'editor'`: return `params` unchanged.
3. Check if `req.url` contains `?preview=<token>`:
   - If yes and `tokenVerifier` is provided: call `await tokenVerifier(token)`. If valid, return `params` unchanged.
   - If token invalid or verifier not provided: ignore the preview token.
4. Merge `{ status: { $eq: 'published' } }` into `params.filters` using `$and` conjunction. If `params.filters.$and` already exists, append to it. If it does not exist, create `{ $and: [existingFilters, { status: { $eq: 'published' } }] }`.

The `TokenVerifier` interface is: `type TokenVerifier = (token: string) => Promise<{ valid: boolean; documentId?: string }>`. In Plan 009, this is implemented against the Upstash cache. In tests, it is mocked.

**Note on separation of concerns:** The draft/publish filter is NOT part of RBAC. An `editor` user bypassing the draft filter is not a privilege escalation — editors are supposed to see drafts. A `public` user seeing only published content is a content visibility rule, not a permission boundary. These are different systems with different failure modes, which is why they are separate functions with separate test suites.

**Patterns to follow:**
- Filter injection pattern: create a new `QueryParams` object rather than mutating the input
- `$and` conjunction for merging filters (same pattern Strapi uses for system-injected filters)
- Stub interface pattern for Plan 009 dependency (dependency injection via optional parameter)

**Test scenarios:**

- **Non-draftAndPublish collection:** `applyDraftFilter(params, 'public', collection /* draftAndPublish: false */, req)`. Assert `params` returned unchanged.
- **Admin bypass:** `applyDraftFilter(params, 'admin', collection /* draftAndPublish: true */, req)`. Assert no `status` filter added.
- **Editor bypass:** Same with role `'editor'`. Assert no filter added.
- **Public filter injection — no existing filters:** Empty `params.filters`. Assert result has `{ $and: [{ status: { $eq: 'published' } }] }`.
- **Public filter injection — existing filters preserved:** `params.filters = { title: { $contains: 'hello' } }`. Assert result has `$and` containing both the existing filter and the status filter.
- **Public filter injection — existing $and extended:** `params.filters = { $and: [{ views: { $gte: 10 } }] }`. Assert resulting `$and` has both the existing condition and the status condition.
- **Authenticated role — filter injected:** Role `'authenticated'` on a `draftAndPublish: true` collection. Assert status filter added (authenticated users see only published, same as public).
- **Preview token — valid:** Mock `tokenVerifier` to return `{ valid: true }`. Assert no status filter added.
- **Preview token — invalid:** Mock `tokenVerifier` to return `{ valid: false }`. Assert status filter added.
- **Preview token — no verifier provided:** Request has `?preview=abc` but no verifier. Assert status filter added (safe default).
- **Preview token — not present in URL:** No `preview` param. Role is `'public'`. Assert status filter added normally.
- **Integration — findMany via REST as public:** `GET /api/articles` with no auth on a `draftAndPublish: true` collection. Assert the adapter is called with a `status: published` constraint. Assert draft articles absent from response.
- **Integration — findMany via REST as admin:** Same but with admin auth. Assert adapter called without status filter. Assert draft articles present.
- **Immutability:** Assert input `params` object is not mutated by `applyDraftFilter`.

**Verification:** Draft filter never runs on non-`draftAndPublish` collections. Admin and editor roles always see all statuses. Public and authenticated roles always see only published unless a valid preview token overrides. The override is per-request, not per-session. Filter merge is correct for all three cases (empty filters, existing non-`$and` filters, existing `$and` filters).

---

## Scope Boundaries

### In scope
- REST route factory with Hono RPC typing
- `qs`-based query parser with all 15 operators
- RBAC middleware and shared permission functions
- GraphQL schema generator (type defs + resolvers)
- Apollo Server integration via `@as-integrations/next`
- Cursor pagination as default with offset as fallback
- Draft/publish filter at handler level with preview token interface

### Deferred to Follow-Up Work
- Preview token generation and storage (Plan 009 — cache layer)
- SDK `buildQuery` export and typed client (Plan 011)
- OpenAPI spec generation from collection definitions (Plan 018)
- Admin SPA consuming the `hc` typed client (Plans 007–008)
- Webhook delivery triggered by content mutations (Plan 013)
- Audit log writes on content mutations (Plan 021)
- Full-text search (out of scope for v1 content API; plugin territory)
- Rate limiting on content mutation endpoints (Plan 009 / cache layer)
- Content seeding CLI (Plan 022)

### Outside this product's identity
- Strapi-compatible admin panel (this is a different product)
- Runtime-switching between database adapters (Design decision: adapter is fixed at build time)
- Multi-tenant content isolation (v2 roadmap, requires tenant-aware adapter)

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hono RPC type inference breaks for dynamic route registration | Medium | High | Validate `typeof app` pattern in a standalone TypeScript test project before wiring into `createCMS`. Check Hono RPC issues for dynamic route composition patterns. |
| Apollo Server startup adds cold-start latency on CF Workers | Medium | Medium | `ApolloServer.start()` must complete before the first request. On CF Workers, start is called in the module-level initialization (not in the `fetch` handler). Benchmark cold-start with 5, 10, 20 collections. |
| `qs.parse` on malicious input (prototype pollution) | Low | High | Always call `qs.parse` with `allowPrototypes: false`. Add a test for `__proto__` injection attempt. |
| Cursor decode on a tampered token causes crash | Low | Medium | `decodeCursor` wraps JSON.parse in try/catch and throws `InvalidCursorError`. Route handler converts this to `400`. Never trust the cursor as valid data. |
| Role resolution mismatch between REST and GraphQL | Medium | High | `resolveRole` is a single pure function in `rbac-core.ts` called by both the Hono middleware and the Apollo context function. No duplication of logic. |
| `fieldPermissions` stripping misses nested relation objects | Medium | Medium | `stripForbiddenFields` is explicitly shallow-first. Relation resolvers (both REST populate and GraphQL relation resolvers) call `stripForbiddenFields` on the relation's data too. Test this explicitly with a nested relation that contains a forbidden field. |
| Draft filter injected `$and` conflicts with existing `$and` in the adapter's WHERE builder | Low | Medium | The `$and` array is always flattened by the adapter's query builder. Test: existing `$and` + draft filter injection produces correct SQL with both conditions. |

---

## Dependencies and Prerequisites

- **Plan 002–003:** `DatabaseAdapter` interface and at least one implementation (SQLite/D1) must be defined for integration tests. Unit tests mock the adapter.
- **Plan 004:** Auth middleware that sets `c.get('session')` and `c.get('user')` must be implemented. RBAC middleware reads these values.
- **Plan 005:** `defineCollection` / `CollectionDefinition` type must be stable. The route factory and schema generator are parameterized on this type.
- **Plan 009:** Preview token verification function stub only needed at integration test time. The `TokenVerifier` interface is defined in this plan; the implementation lives in Plan 009.

---

## Alternative Approaches Considered

### Route factory: single `Hono` app with `app.route()` vs. per-collection sub-routers

The alternative is to register all collection routes directly on the main `createCMS` Hono app rather than creating sub-routers via the factory. This simplifies mounting but loses the ability to export `typeof collectionRouter` separately, which breaks the RPC type inference when collections are registered dynamically. The sub-router factory is the only approach that produces a statically inferrable type for each collection's routes.

### GraphQL schema: SDL-first vs. code-first (type-graphql, pothos)

Code-first libraries like Pothos generate SDL from TypeScript decorators or builder functions, which would allow the collection's Zod schema to drive the GraphQL type directly. However, Pothos and type-graphql both require class-based patterns or builder DSLs that add a layer of abstraction between the collection definition and the GraphQL type. SDL-first (manually generated SDL strings from collection definitions) is more transparent — every generated string is inspectable — and avoids a code-first library dependency that may not be edge-compatible. SDL-first is also the approach used by Apollo's own documentation for dynamic schema generation.

### Field-level permissions: null return vs. schema splitting

Schema splitting (generating different schemas per role) would make it impossible for unauthorized clients to introspect restricted fields. However, it requires Apollo Server to serve different schemas per request — which is not supported natively and would require a custom gateway. Null return is the standard recommendation in the GraphQL Authorization Working Group spec and is simpler to implement, audit, and test.

### Cursor encoding: `id`-only vs. `{ id, createdAt }`

An `id`-only cursor works when IDs are ordered and monotonically increasing (e.g., auto-increment integers or ULIDs). However, UUIDs (the likely default ID type) are not monotonically ordered by creation time, so `id`-only cursors produce unpredictable sort order. Encoding `{ id, createdAt }` allows a composite keyset index on `(createdAt, id)` which is both deterministic and stable under concurrent inserts with the same timestamp.

---

## Documentation Plan

The content API is the primary integration surface. Documentation work (separate from this plan) should cover:

- REST API reference: all eight endpoints per collection, all query parameters with examples
- Filter operator reference: table of all 15 operators with type constraints and examples
- Pagination guide: cursor mode vs. offset mode, when to use each
- GraphQL schema reference: auto-generated per deployment at `/graphql` (introspection)
- RBAC guide: how to declare permissions in `defineCollection`, role resolution order
- Preview mode guide: generating and using preview tokens (Plan 009)

---

## Phased Delivery

**Phase 1 (this plan):** REST route factory (U1), query parser (U2), RBAC middleware (U3), cursor pagination (U6), draft filter (U7). These five units are sufficient for a fully functional REST content API with access control.

**Phase 2 (this plan, after Phase 1):** GraphQL schema generator (U4) and Apollo Server integration (U5). GraphQL depends on the same adapter and RBAC functions as REST; it can be implemented after Phase 1 is stable without blocking the admin SPA (which uses REST via Hono RPC).

This phasing means the admin SPA (Plans 007–008) can begin implementation after Phase 1 is complete, while GraphQL work continues in parallel.
