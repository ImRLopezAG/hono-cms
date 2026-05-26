---
title: "feat: OpenAPI 3.1 Spec + Scalar API Documentation UI"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#18 OpenAPI Spec + Scalar API Docs"]
---

# Plan 012: OpenAPI 3.1 Spec + Scalar API Documentation UI

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, architecture review, security review

### Key Improvements

1. Elevate OpenAPI 3.1 as the canonical public contract for SDK and external clients.
2. Add clearer public-vs-operator spec and docs exposure rules.
3. Tighten route-derived generation and security posture around docs endpoints.

**Sequence:** 012 of 018
**Blocking:** Plan 017 (SDK generation) depends on the spec contract established here.

---

## Summary

This plan specifies the auto-generated OpenAPI 3.1 documentation layer for `@hono-cms/core`. Every content collection route, auth endpoint, and media API endpoint is documented without any hand-written spec. The spec is generated once at startup, served as static JSON at `GET /cms/openapi.json`, and rendered as an interactive Scalar UI at `GET /cms/docs`.

The implementation pivots content route definitions (originally plain Hono routes) to `@hono/zod-openapi`'s `createRoute`, which simultaneously generates route handlers and OpenAPI path entries from a single declaration. This eliminates a separate spec assembly step and guarantees the spec stays in sync with the actual routes.

This is Plan 012 of 18. Plans 006 (content routes), 008 (better-auth integration), and 009 (media API) must complete first; Plan 017 (SDK generation) consumes the spec this plan produces.

---

## Problem Frame

A Hono-based CMS that serves REST endpoints for content, auth, and media has no built-in documentation layer. Without one:

- Mobile developers, non-TypeScript consumers, and third-party integrators must reverse-engineer the API from source code or trial and error.
- Postman collections and Insomnia workspaces are maintained by hand and drift from the actual implementation.
- Plan 017's SDK generator has no machine-readable contract to generate from.
- Internal developers testing authenticated endpoints have no try-it-now UI.

The solution is an OpenAPI 3.1 spec derived directly from the route definitions — not maintained separately — so it is always accurate by construction. Scalar is the rendering layer: modern, fast, dark-mode-first, OpenAPI 3.1 native, and already used by Hono's own documentation site.

---

## Scope Boundaries

### In Scope

- `@hono/zod-openapi` route migration for all content API routes
- Auto-generated Zod request/response schemas per collection (`CreateInput<T>`, `UpdateInput<T>`, `PaginatedResponse<T>`)
- Query parameter documentation strategy for Strapi-compatible bracket syntax
- `@better-auth/openapi` plugin integration and spec merge
- Hand-coded OpenAPI schemas for the media API
- `GET /cms/openapi.json` spec endpoint (ETag-cached, CORS-enabled)
- `GET /cms/docs` Scalar UI endpoint with bearer token authentication support
- Production mode: Scalar disabled by default unless `openapi.docs` is explicitly configured
- `createCMS` config surface: `openapi: true | OpenAPIConfig`
- Namespace collision handling for auth vs. content schemas

### Deferred to Follow-Up Work

- GraphQL schema introspection documentation (Plan 006 scope)
- Webhook delivery log endpoints (Plan 013)
- Audit log export endpoints (Plan 015)
- `cms schema` CLI commands — not API endpoints, not documented in the spec
- Admin SPA endpoints — mounted at `/cms/admin/*`, excluded from the public spec
- Job handler endpoints (`/cms/jobs/*`) — internal only, explicitly excluded

### Outside This Product's Identity

- Providing a standalone API gateway or spec validator
- Replacing the spec with a GraphQL SDL as the source of truth for non-TypeScript consumers
- Hosting the Scalar UI as a separate deployment artifact

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Generate docs from route validation metadata so OpenAPI stays downstream of real handlers instead of becoming a parallel tree.
- Treat OpenAPI 3.1 as the public contract source of truth and keep Hono RPC as a strong internal/same-workspace typing tool.
- Add stable operation IDs and environment metadata so docs and generated clients remain predictable.

**Security Considerations:**
- Split public spec exposure from operator-only/admin/internal endpoint exposure instead of serving one all-seeing document.
- Avoid `Access-Control-Allow-Origin: *` on docs/spec endpoints if authenticated try-it flows are enabled.

**Edge Cases:**
- Document the limitations of deepObject/nested filter tooling clearly where Strapi-style bracket syntax exceeds generator support.
- Keep auth/media/admin-only paths from leaking accidentally when docs are enabled in production.

### 1. `@hono/zod-openapi` over manual spec assembly

Content routes (Plan 006) will be re-specified using `createRoute` from `@hono/zod-openapi`. This library is maintained by the Hono core team and combines three concerns in a single declaration: route metadata (method, path, tags), request validation (Zod schemas for body, params, query), and OpenAPI spec entry generation. The alternative — writing Hono routes separately and maintaining a parallel OpenAPI spec — guarantees drift and doubles the documentation burden.

`@hono/zod-openapi` wraps Hono's `OpenAPIHono` class. Every `createRoute` call registers the route on the Hono app AND adds the path entry to the spec simultaneously. The spec is assembled by calling `app.getOpenAPI31Document(...)` at startup, which traverses all registered routes and produces the complete JSON document.

The cost of this choice: Plan 006's content routes must be rewritten using `createRoute` instead of plain `app.get(...)` / `app.post(...)`. This is a mechanical transformation, not a redesign, but it does mean Plan 012 has an explicit dependency on Plan 006 completing first (so the route structure is known before migrating it).

### 2. Query parameter documentation: hybrid strategy (deepObject + opaque fallback)

OpenAPI's `deepObject` style (`style: deepObject, explode: true`) allows `filters[title][$eq]=hello` to be expressed as a typed parameter with a nested schema. It is technically valid per OpenAPI 3.1 and correctly renders in Scalar. However, most OpenAPI tooling (code generators, validators, older Swagger UIs) do not fully support `deepObject` with more than one level of nesting, and the Strapi-compatible filter syntax goes three levels deep (`filters[author][name][$startsWith]`).

**Decision: document `filters` as a `deepObject` parameter for the first level (field → operator), document nested relation filters as a plain `string` parameter with a detailed description and examples.** This gives Scalar users a structured try-it UI for simple filters (`filters[title][$eq]=hello`) while not producing invalid spec output for complex nested filters. The spec will include an `x-cms-filter-examples` extension field with the full bracket syntax examples so tooling that reads extensions can provide guidance.

`sort`, `pagination`, `populate`, and `fields` are all documented as `deepObject` parameters. These are one or two levels deep and map cleanly to OpenAPI's `deepObject` style.

### 3. Scalar disabled in production by default

Exposing the API structure publicly in production is a security tradeoff. The Scalar UI at `/cms/docs` reveals all endpoint paths, schemas, and parameter names to unauthenticated visitors. For production CMS instances that are internal tools or not intended for third-party consumption, this is undesirable.

**Default behavior:** In production (`NODE_ENV === 'production'`), the `GET /cms/docs` route returns 404 unless `openapi.docs` is explicitly set in the config. The `GET /cms/openapi.json` endpoint follows the same rule — disabled by default in production unless `openapi.path` is explicitly set.

`openapi: true` enables both endpoints in development. In production, `openapi: true` is treated as `openapi: { path: undefined, docs: undefined }` — neither endpoint is mounted. The developer must explicitly set the paths to enable them in production.

This convention follows Scalar's own recommendation for production deployments and mirrors how GraphQL Playground / Apollo Sandbox handle introspection in production.

### 4. Spec merge strategy for better-auth

`@better-auth/openapi` generates a separate OpenAPI document for all `/api/auth/*` endpoints. The merge strategy is a shallow-merge at the top level: paths, components/schemas, components/securitySchemes from the better-auth spec are merged into the CMS-generated spec. The `info`, `servers`, and `openapi` version fields from the CMS spec take precedence.

Namespace collision for schemas: better-auth uses `User`, `Session`, `Account` as schema component names. If a CMS collection is also named `User`, it collides with the better-auth `User` schema. Resolution: better-auth schemas are prefixed with `Auth` during merge (`User` → `AuthUser`, `Session` → `AuthSession`). All `$ref` pointers within the better-auth spec are rewritten to match the prefixed names before merge. CMS collection schemas retain their original names.

### 5. ETag caching for the spec

The spec is generated once at bootstrap (not per-request) and stored as a pre-serialized JSON string in memory. On each `GET /cms/openapi.json` request, the handler:

1. Checks the `If-None-Match` request header against the spec's ETag (a stable hash of the spec JSON, computed once at startup).
2. Returns `304 Not Modified` if they match.
3. Returns `200` with `Content-Type: application/json`, `Cache-Control: public, max-age=3600` (1 hour in production, `no-store` in development), and `ETag: "<hash>"` if they differ.

This prevents Scalar, Postman, and other tooling from downloading the full spec on every page load or collection sync. In development, `no-store` ensures the spec always reflects the current route definitions without requiring a manual cache clear.

---

## High-Level Technical Design

This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

### Spec assembly flow

```
createCMS(config)
  │
  ├── createOpenAPIHono()           ← wraps standard Hono with OpenAPI tracking
  │
  ├── mountContentRoutes(app, collections)
  │     └── for each collection:
  │           app.openapi(createRoute({...}), handler)
  │                │
  │                └── registers route + OpenAPI path entry simultaneously
  │
  ├── mountAuthRoutes(app, betterAuth)
  │     └── app.route('/api/auth', betterAuth.handler)
  │         (auth routes are not registered via createRoute —
  │          auth spec comes from @better-auth/openapi separately)
  │
  ├── mountMediaRoutes(app)
  │     └── app.openapi(createRoute({...}), handler)  ← hand-coded schemas
  │
  ├── mountCMSRoutes(app)           ← health, openapi.json, docs
  │
  └── [bootstrap] buildOpenAPISpec(app, config)
        ├── cmsSpec = app.getOpenAPI31Document(info, servers)
        ├── authSpec = betterAuth.getOpenAPIDocument()
        ├── mergedSpec = mergeSpecs(cmsSpec, authSpec)   ← prefix auth schemas
        ├── specJSON = JSON.stringify(mergedSpec)
        └── specETag = computeETag(specJSON)
              └── stored in module closure for GET /cms/openapi.json handler
```

### `createRoute` declaration shape (directional)

```
createRoute({
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: '/api/{collection}/{id}',
  tags: [collectionName],
  summary: string,
  request: {
    params: zodSchema,       ← path parameters
    query:  zodSchema,       ← query parameters (filters, sort, pagination, etc.)
    body: {
      content: { 'application/json': { schema: zodSchema } }
    }
  },
  responses: {
    200: { content: { 'application/json': { schema: zodSchema } }, description },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description },
    401: { ... },
    403: { ... },
    404: { ... },
  }
})
```

### Config type (directional)

```
type OpenAPIConfig = {
  path?: string           // default: '/cms/openapi.json' (undefined = disabled in prod)
  docs?: string           // default: '/cms/docs' (undefined = disabled in prod)
  title?: string          // spec info.title
  version?: string        // spec info.version
  description?: string    // spec info.description
  servers?: { url: string; description?: string }[]
  theme?: 'default' | 'moon' | 'purple' | 'solarized'
}

type CMSConfig = {
  // ...
  openapi?: boolean | OpenAPIConfig
}
```

### Namespace collision resolution (directional)

```
mergeSpecs(cmsSpec, authSpec):
  authSchemas = Object.fromEntries(
    Object.entries(authSpec.components.schemas).map(([k, v]) =>
      ['Auth' + k, rewriteRefs(v, (ref) => ref.replace('#/components/schemas/', '#/components/schemas/Auth'))]
    )
  )
  return {
    ...cmsSpec,
    paths: { ...cmsSpec.paths, ...authSpec.paths },
    components: {
      schemas: { ...cmsSpec.components.schemas, ...authSchemas },
      securitySchemes: { ...cmsSpec.components.securitySchemes, ...authSpec.components.securitySchemes }
    }
  }
```

---

## Output Structure

```
packages/core/src/
├── openapi/
│   ├── index.ts                    ← public exports (mountOpenAPIRoutes, buildSpec)
│   ├── builder.ts                  ← spec assembly: getOpenAPI31Document + mergeSpecs
│   ├── schemas/
│   │   ├── collection.ts           ← CreateInput<T>, UpdateInput<T>, PaginatedResponse<T>
│   │   ├── query-params.ts         ← filter, sort, pagination, populate, fields schemas
│   │   ├── media.ts                ← media API request/response schemas
│   │   ├── error.ts                ← standard error response schema
│   │   └── common.ts               ← shared primitives (ID, timestamp, etc.)
│   ├── routes/
│   │   ├── content.ts              ← createRoute definitions for collection CRUD
│   │   ├── media.ts                ← createRoute definitions for media endpoints
│   │   └── admin.ts                ← health check route definition
│   ├── scalar.ts                   ← Scalar UI mounting and config
│   └── merge-auth-spec.ts          ← better-auth spec merge and prefix logic
└── ...

packages/core/src/
├── content/
│   └── routes.ts                   ← MIGRATED: now uses OpenAPIHono + createRoute
```

---

## Implementation Units

---

### U1. Switch Content Routes to `@hono/zod-openapi` createRoute

**Goal:** Migrate all collection-level route definitions from plain `app.get/post/put/patch/delete(...)` to `app.openapi(createRoute({...}), handler)` from `@hono/zod-openapi`. After this unit, every content route simultaneously registers a handler and contributes an OpenAPI path entry to the spec.

**Requirements:**
- All seven content operations (list, findOne, create, update, patch, delete, publish, unpublish) are declared with `createRoute`.
- Path parameters (`{id}`, `{collection}`) use Zod string schemas with `.openapi({ example: '...' })`.
- Request bodies (create, update, patch) reference the collection's `CreateInput` or `UpdateInput` Zod schema (defined in U2).
- Response bodies reference the collection's `ResponseSchema` and `PaginatedResponse` Zod schema (defined in U2).
- Query parameters for list endpoints reference the query param schemas (defined in U3).
- Error responses (400, 401, 403, 404, 422) are declared on every route using the shared `ErrorSchema`.
- The `OpenAPIHono` instance is used wherever a plain `Hono` instance was used for content routes.
- Existing route handler logic is unchanged — only the declaration mechanism changes.

**Dependencies:** Plan 006 (content routes must exist to be migrated). U2 and U3 of this plan (schema and query param definitions must exist to reference).

**Files:**
- `packages/core/src/content/routes.ts` — migrate to `createRoute`
- `packages/core/src/content/router.ts` — switch from `new Hono()` to `new OpenAPIHono()`
- `packages/core/src/openapi/routes/content.ts` — `createRoute` declarations (extracted from routes.ts for testability)
- `packages/core/src/openapi/schemas/error.ts` — shared error response schema
- `packages/core/package.json` — add `@hono/zod-openapi` dependency

**Approach:**

`@hono/zod-openapi` exports `OpenAPIHono` (a Hono subclass) and `createRoute`. The content router is currently a plain `new Hono()` — swap to `new OpenAPIHono()`. Each route definition is extracted to a `createRoute(...)` call that specifies method, path, tags, summary, request schemas, and response schemas. The handler function is passed as the second argument to `app.openapi(route, handler)`.

The `createRoute` declarations live in `packages/core/src/openapi/routes/content.ts` rather than inline in `routes.ts` — this separates the route metadata (OpenAPI concern) from the handler logic (content concern) and makes both independently testable.

Route tagging strategy: each collection gets its own tag (e.g., `articles`, `authors`). The tag name is the collection's `name` property from `defineCollection`. This groups all article routes together in the Scalar UI sidebar.

The `publish` and `unpublish` routes use `POST /api/{collection}/{id}/publish` and `POST /api/{collection}/{id}/unpublish`. These are included in the spec with a `requestBody` of `null` (no body) and a response schema of the published/unpublished document.

**Patterns to follow:**
- `@hono/zod-openapi` README — `createRoute` and `OpenAPIHono` API (see `packages/core/package.json` after installation)
- Existing content route handler signatures in `packages/core/src/content/routes.ts`

**Test scenarios:**
- Happy path: `app.getOpenAPI31Document(...)` returns a document where every registered content route appears as a path entry with the correct method, parameters, and response schemas.
- Each `createRoute` declaration includes `200`, `400`, `401`, `403`, `404` response entries.
- A `GET /api/articles` path entry includes a `200` response referencing the `PaginatedResponse<Article>` schema.
- A `POST /api/articles` path entry includes a `requestBody` referencing the `CreateInput<Article>` schema.
- A `GET /api/articles/{id}` path entry includes a `paths./api/articles/{id}.get.parameters` array with a `name: 'id'` path parameter.
- Handler behavior is unchanged after migration: `POST /api/articles` with a valid body returns `201`, with an invalid body returns `422` (Zod validation failure surfaced by `@hono/zod-openapi`'s built-in validation).
- The `OpenAPIHono` app remains mountable as `app.route('/api', contentRouter)` without behavior change.

**Verification:** `app.getOpenAPI31Document(...)` returns a non-null document after mounting the content router. All seven route operations appear for each registered collection. Existing content route integration tests continue to pass without modification.

---

### U2. Collection-to-OpenAPI Schema Mapping

**Goal:** Auto-generate Zod schemas for each collection's API surface — `CreateInput<T>`, `UpdateInput<T>`, `ResponseSchema<T>`, and `PaginatedResponse<T>` — derived from the collection's `defineCollection` field definitions. These schemas serve dual purpose: runtime request validation (via `@hono/zod-openapi`'s validation middleware) and OpenAPI spec schema components.

**Requirements:**
- `deriveCreateInputSchema(collection)` produces a Zod object schema for the request body of `POST /api/{collection}`.
- `deriveUpdateInputSchema(collection)` produces a partial version of `CreateInput` for `PUT` (full) and `PATCH` (partial).
- `deriveResponseSchema(collection)` produces the full document shape including CMS-managed fields (`id`, `createdAt`, `updatedAt`, `status` when `draftAndPublish: true`).
- `derivePaginatedResponseSchema(collection)` wraps `ResponseSchema` in a `{ data: ResponseSchema[], meta: PaginationMeta }` object.
- Relation fields:
  - In write schemas (`CreateInput`, `UpdateInput`): relations are represented as `z.string()` (the related document's ID) or `z.string().array()` for one-to-many.
  - In read schemas (`ResponseSchema`): relations are represented as `z.union([z.string(), RelatedDocumentSchema])` — a discriminated union that handles both the non-populated (ID string) and populated (full object) cases. When `populate` is specified, the Scalar UI example shows the full object shape.
- `fieldPermissions` affect the read schema: fields with permissions restrictions are marked `.optional()` in `ResponseSchema` because they are stripped from responses for lower-privilege roles. The description is annotated with which roles can see the field.
- All generated schemas call `.openapi({ title, description, example })` to add OpenAPI metadata for Scalar rendering.
- Generated schemas are registered as named components in the spec (`#/components/schemas/{CollectionName}CreateInput`, etc.) rather than inlined at every usage site.

**Dependencies:** U1 (collection `defineCollection` type), Plans 001–002 (schema package with collection definitions).

**Files:**
- `packages/core/src/openapi/schemas/collection.ts` — `deriveCreateInputSchema`, `deriveUpdateInputSchema`, `deriveResponseSchema`, `derivePaginatedResponseSchema`
- `packages/core/src/openapi/schemas/common.ts` — shared primitives: `IdSchema`, `TimestampSchema`, `PaginationMetaSchema`, `PublishStatusSchema`
- `packages/core/src/openapi/schemas/error.ts` — `ErrorSchema` with `{ error: string; details?: unknown }`
- `packages/core/src/openapi/__tests__/schemas.test.ts`

**Approach:**

The collection's `fields` object from `defineCollection` is already a `Record<string, ZodType>` (from Plan 001/002). The schema derivation functions compose these into the request/response shapes.

`CreateInput` excludes CMS-managed fields: `id`, `createdAt`, `updatedAt`, `status` (if `draftAndPublish: true`), and any relation back-references. Write-protected fields (from `fieldPermissions` where no role has write access) are also excluded.

`ResponseSchema` adds CMS-managed fields on top of the collection fields. Fields with `fieldPermissions` are marked `.optional()` in the schema. The `.openapi({ description })` annotation notes which roles can access the field, so Scalar renders the permission information in the schema description.

Relation representation in write schemas: the collection field type for relations is a custom Zod type from Plan 001 (e.g., `z.relation({ target: 'authors' })`). The schema derivation function detects this type and substitutes `z.string().openapi({ description: 'Related author document ID' })`. In read schemas, the substitution is `z.union([z.string(), AuthorResponseSchema]).openapi({ description: 'Author ID or populated Author document when ?populate=author is specified' })`.

Schema naming convention for registered components:
- `ArticleCreateInput`
- `ArticleUpdateInput`
- `ArticleResponse`
- `ArticlePaginatedResponse`
- `AuthorResponse` (referenced in `ArticleResponse` for the populated relation case)

**Patterns to follow:**
- `zod-openapi` `.openapi()` extension on Zod types (from `@hono/zod-openapi`'s re-export)
- Plan 001's `defineCollection` field type definitions

**Test scenarios:**
- `deriveCreateInputSchema` for an `articles` collection with `title: z.string()` and `author: z.relation(...)` produces a schema where `title` is `z.string()` and `author` is `z.string()`.
- `deriveCreateInputSchema` does not include `id`, `createdAt`, `updatedAt`, or `status` fields.
- `deriveResponseSchema` for a collection with `draftAndPublish: true` includes a `status` field of type `z.enum(['draft', 'published'])`.
- A field with `fieldPermissions: { _internalNotes: ['admin'] }` produces a `.optional()` field in `deriveResponseSchema` with a description noting admin-only access.
- `derivePaginatedResponseSchema` wraps the response schema in `{ data: [], meta: { page, pageSize, total, cursor } }`.
- A relation field in `deriveResponseSchema` produces a `z.union([z.string(), RelatedSchema])` — asserting both shapes are valid discriminated-union members.
- Schema components are registered with stable names: re-running `deriveResponseSchema` for the same collection produces the same component name.
- `z.parse()` with `deriveCreateInputSchema` rejects a body that includes `id` (extra field stripping via `.strict()` or equivalent).

**Verification:** All generated schemas pass `JSON.stringify(zodToJsonSchema(schema))` without errors. Schema component names appear in the assembled spec's `#/components/schemas` map. Scalar renders example values correctly for each schema.

---

### U3. Query Parameter Documentation Strategy

**Goal:** Document all Strapi-compatible query parameters (`filters`, `sort`, `pagination`, `populate`, `fields`, `locale`) for collection list endpoints in a way that is OpenAPI 3.1 valid, renders usably in Scalar, and accurately represents the actual filter behavior.

**Requirements:**
- `sort`, `pagination`, `populate`, and `fields` are documented as `deepObject` style parameters with typed schemas.
- `filters` is documented in two layers: a `deepObject` parameter for simple single-field filters (one level deep), and a supplementary `x-cms-filter-syntax` extension documenting the full bracket syntax with examples.
- All query parameters are declared in `packages/core/src/openapi/schemas/query-params.ts` as reusable Zod schemas.
- The `GET /api/articles` route in the spec includes all documented query parameters with descriptions and examples.
- Scalar renders the query parameters with a try-it UI that allows entering values.

**Dependencies:** U1 (query params referenced from `createRoute` declarations).

**Files:**
- `packages/core/src/openapi/schemas/query-params.ts`
- `packages/core/src/openapi/__tests__/query-params.test.ts`

**Approach:**

The Strapi filter syntax (`filters[author][name][$startsWith]=John`) maps to OpenAPI as follows. Declare `filters` as a parameter with:

```
name: 'filters'
in: query
style: deepObject
explode: true
schema: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())]))
```

This correctly represents `?filters[title][$eq]=hello` (single-field filter) as a `deepObject`. For two-level nesting (`?filters[author][name][$startsWith]=John`), the `style: deepObject` technically supports this per the OpenAPI 3.1 spec, but most client tooling silently ignores the second nesting level in their UI. Scalar renders `deepObject` parameters as a nested key-value editor — usable for simple cases.

Supplement with `x-cms-filter-syntax` as a top-level spec extension (placed in the spec's root `info.x-cms-filter-syntax` field) documenting the full syntax with copy-pasteable examples:

```yaml
x-cms-filter-syntax:
  description: >
    Filter syntax uses bracket notation compatible with the `qs` library.
    Complex nested filters can be built using the qs.stringify utility
    re-exported from @hono-cms/core.
  examples:
    simple: "filters[title][$eq]=Hello+World"
    nested: "filters[author][name][$startsWith]=John"
    operator_list: "[$eq, $ne, $lt, $lte, $gt, $gte, $contains, $startsWith, $endsWith, $in, $nin, $null]"
```

**`sort` parameter:**
```
name: sort
style: deepObject
explode: true
schema: z.record(z.enum(['asc', 'desc']))
description: "Sort by field. Example: sort[createdAt]=desc&sort[title]=asc"
```

**`pagination` parameter:**
```
name: pagination
style: deepObject
explode: true
schema: z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
```

**`populate` parameter:**
```
name: populate
in: query
schema: z.union([
  z.string().describe("Comma-separated relation names. Example: populate=author,tags"),
  z.record(z.object({ fields: z.string().optional() }))
    .describe("Selective population. Example: populate[author][fields]=name,avatar")
])
```

**`fields` parameter:**
```
name: fields
in: query
schema: z.string().describe("Comma-separated field names to include. Example: fields=title,status,createdAt")
```

**`locale` parameter** (only on collections with `localization: true`):
```
name: locale
in: query
schema: z.string().describe("Locale code. Example: locale=es. Falls back to default locale if not found.")
```

**Example spec output for `GET /api/articles`:**

The spec's path entry for `GET /api/articles` includes:
```json
{
  "operationId": "getArticles",
  "tags": ["articles"],
  "summary": "List articles",
  "parameters": [
    { "name": "filters", "in": "query", "style": "deepObject", "explode": true, "schema": { ... } },
    { "name": "sort", "in": "query", "style": "deepObject", "explode": true, "schema": { ... } },
    { "name": "pagination", "in": "query", "style": "deepObject", "explode": true, "schema": { ... } },
    { "name": "populate", "in": "query", "schema": { ... } },
    { "name": "fields", "in": "query", "schema": { ... } },
    { "name": "locale", "in": "query", "schema": { ... } }
  ],
  "responses": {
    "200": { "$ref": "#/components/responses/ArticlePaginatedResponse" }
  }
}
```

Scalar renders each parameter with a label, description, and input field. The `deepObject` style causes Scalar to render `filters` with expandable key-value pairs for the first level — users can enter `title / $eq / Hello World` rather than writing raw bracket syntax. For deeply nested filters, the description and `x-cms-filter-syntax` extension guide them to the full syntax.

**Tradeoffs documented (to be preserved in the spec as `info.description` addendum):**

| Approach | Pros | Cons |
|---|---|---|
| `deepObject` for all filter levels | Type-safe, Scalar renders structured UI | Two+ nesting levels not universally supported in tooling |
| Opaque `string` for all filters | Simple, works everywhere | No structured UI in Scalar, hard to discover |
| Hybrid (chosen) | Structured UI for simple cases, full docs for complex | Two mechanisms to document and maintain |

**Test scenarios:**
- `queryParamSchemas.pagination` parses `{ page: '2', pageSize: '20' }` into `{ page: 2, pageSize: 20 }` (coercion).
- `queryParamSchemas.pagination` rejects `{ pageSize: '0' }` (min: 1 violated).
- `queryParamSchemas.pagination` rejects `{ pageSize: '101' }` (max: 100 violated).
- `queryParamSchemas.sort` parses `{ createdAt: 'desc', title: 'asc' }` successfully.
- `queryParamSchemas.sort` rejects `{ createdAt: 'INVALID' }` (must be 'asc' | 'desc').
- `queryParamSchemas.fields` parses the string `'title,status,createdAt'` without error.
- The spec JSON for `GET /api/articles` includes parameters for `filters`, `sort`, `pagination`, `populate`, `fields`.
- The spec JSON is valid per OpenAPI 3.1 schema validation (`@redocly/openapi-core` or `openapi-schema-validator`).
- `locale` parameter appears only for collections with `localization: true`, not for collections without.

**Verification:** All query parameter schemas parse their expected inputs. The assembled spec validates against the official OpenAPI 3.1 JSON Schema. Scalar's try-it UI shows all parameters for `GET /api/articles` with their descriptions.

---

### U4. better-auth OpenAPI Integration and Spec Merge

**Goal:** Include `@better-auth/openapi`'s generated auth endpoint documentation in the CMS spec. Resolve namespace collisions between auth schema names and CMS collection schema names. The final `GET /cms/openapi.json` response contains both the CMS routes and all auth routes in one unified document.

**Requirements:**
- `@better-auth/openapi` is installed as a plugin on the better-auth instance inside `createCMS`.
- The auth-generated spec is retrieved at startup (not per-request) alongside the CMS-generated spec.
- `mergeSpecs(cmsSpec, authSpec)` performs a deep merge with the following rules:
  - `info`, `servers`, `openapi` version: CMS spec values take precedence.
  - `paths`: merged — auth paths are added alongside CMS paths (no overlapping paths expected).
  - `components.schemas`: auth schemas are prefixed with `Auth` (e.g., `User` → `AuthUser`); all internal `$ref` pointers within the auth spec are rewritten accordingly.
  - `components.securitySchemes`: merged — the CMS spec adds a `BearerAuth` security scheme; the auth spec may add cookie-based schemes.
  - Tags: auth routes are grouped under an `Authentication` tag; CMS content routes are grouped by collection name; media routes under a `Media` tag; CMS admin routes under `CMS` tag.
- If the developer has configured `auth: false` or omitted auth from `createCMS`, the auth spec merge is skipped.
- The merge is defensive: if the auth spec is malformed or missing, the CMS spec is still served without auth documentation (with a logged warning).

**Dependencies:** U1 (OpenAPI assembly), Plan 008 (better-auth integration inside `createCMS` must exist to pass the auth instance to `@better-auth/openapi`).

**Files:**
- `packages/core/src/openapi/merge-auth-spec.ts` — `mergeSpecs`, `prefixAuthSchemas`, `rewriteRefs`
- `packages/core/src/openapi/builder.ts` — calls `mergeSpecs` during startup spec assembly
- `packages/core/package.json` — add `@better-auth/openapi` as an optional peer dependency
- `packages/core/src/openapi/__tests__/merge-auth-spec.test.ts`

**Approach:**

`@better-auth/openapi` is a better-auth plugin. It is activated by adding it to the `auth.plugins` array in `createCMS`'s internal better-auth configuration when `openapi` is truthy in the CMS config. The plugin exposes a `.getOpenAPIDocument()` method on the better-auth instance that returns the auth spec as a plain JavaScript object.

`mergeSpecs` is a pure function (no side effects, no I/O): it takes two OpenAPI document objects and returns a merged object. This makes it independently testable with fixture specs.

`prefixAuthSchemas` iterates `authSpec.components.schemas` and produces a new object where every key is prefixed with `Auth`. It simultaneously runs `rewriteRefs` on every schema value to replace `#/components/schemas/User` with `#/components/schemas/AuthUser`, etc.

`rewriteRefs` is a recursive deep traversal of a JSON object that rewrites all `$ref` string values matching `#/components/schemas/<name>` to `#/components/schemas/Auth<name>`. It handles `$ref` at any nesting level: inside `allOf`, `oneOf`, `anyOf`, `properties`, `items`.

Security scheme: the CMS-generated spec includes a `BearerAuth` security scheme in `components.securitySchemes`:
```json
{
  "BearerAuth": {
    "type": "http",
    "scheme": "bearer",
    "bearerFormat": "JWT",
    "description": "Pass the token from POST /api/auth/sign-in in the Authorization header"
  }
}
```

Every content route and media route's `createRoute` declaration includes `security: [{ BearerAuth: [] }]` for endpoints that require authentication, or omits `security` for public endpoints.

**Patterns to follow:**
- `@better-auth/openapi` plugin documentation
- Existing `createCMS` provider registration pattern from Plan 003

**Test scenarios:**
- `prefixAuthSchemas({ User: {...}, Session: {...} })` returns `{ AuthUser: {...}, AuthSession: {...} }`.
- `rewriteRefs` on an auth schema containing `{ "$ref": "#/components/schemas/User" }` produces `{ "$ref": "#/components/schemas/AuthUser" }`.
- `rewriteRefs` handles nested `$ref` inside `allOf[0].properties.user.$ref`.
- `mergeSpecs` with a CMS spec containing an `articles` path and an auth spec containing a `/api/auth/sign-in` path produces a merged document with both paths.
- `mergeSpecs` when auth spec contains `User` schema and CMS spec contains `User` schema (rare but possible) — the auth `User` becomes `AuthUser` without overwriting the CMS `User`.
- If `authSpec` is `null` or malformed, `mergeSpecs` returns the CMS spec unchanged (graceful degradation).
- The merged spec passes OpenAPI 3.1 schema validation.
- Auth routes in the merged spec are tagged `Authentication`.
- Content routes in the merged spec are tagged by their collection name.

**Verification:** The merged spec contains paths from both auth and CMS. All `$ref` pointers in the auth sections resolve correctly within the merged document (no dangling references). The spec validates without errors against the OpenAPI 3.1 schema validator.

---

### U5. Scalar UI Mounting

**Goal:** Mount the Scalar API reference UI at the configured `openapi.docs` path (default: `/cms/docs`). The UI loads the spec from `/cms/openapi.json`, supports bearer token authentication for testing authenticated endpoints, applies the configured theme, and is disabled by default in production.

**Requirements:**
- `@scalar/hono-api-reference` is imported and mounted using `apiReference({ spec: { url }, theme, ... })`.
- The Scalar UI is mounted only when `openapi.docs` is set (or when in development mode with `openapi: true`).
- In production (`NODE_ENV === 'production'`), `openapi.docs` must be explicitly set — `openapi: true` does not mount Scalar in production.
- The `authentication` config for Scalar pre-configures the `BearerAuth` security scheme so users can enter a token in the Scalar UI without navigating through the auth section.
- The theme is passed from `openapi.theme` (default: `'default'`). Valid themes: `'default'`, `'moon'`, `'purple'`, `'solarized'`.
- The Scalar UI route does not appear in the OpenAPI spec itself (it is an internal admin route, not an API endpoint).

**Dependencies:** U6 (spec must be served at `/cms/openapi.json` before Scalar can load it).

**Files:**
- `packages/core/src/openapi/scalar.ts` — `mountScalarUI(app, config)`
- `packages/core/src/openapi/index.ts` — re-exports `mountScalarUI`
- `packages/core/package.json` — add `@scalar/hono-api-reference` dependency

**Approach:**

`mountScalarUI` receives the `OpenAPIHono` app instance and the resolved `OpenAPIConfig`. It checks whether Scalar should be mounted (see production gate below). If so, it calls:

```ts
app.get(
  config.docs,
  apiReference({
    spec: { url: config.path },
    theme: config.theme ?? 'default',
    authentication: {
      preferredSecurityScheme: 'BearerAuth',
      http: {
        bearer: {
          token: '',   // empty — user enters it in the UI
        }
      }
    },
    // Hide the Scalar branding for the try-it console
    hideModels: false,
    hideDownloadButton: false,
  })
)
```

**Production gate logic:**

```
isProduction = process.env.NODE_ENV === 'production'
docsPath = config === true
  ? (isProduction ? undefined : '/cms/docs')
  : config.docs

if (docsPath !== undefined) {
  mountScalarUI(app, { ...resolvedConfig, docs: docsPath })
}
```

This ensures:
- `openapi: true` in development → Scalar mounted at `/cms/docs`.
- `openapi: true` in production → Scalar NOT mounted.
- `openapi: { docs: '/cms/docs' }` in production → Scalar mounted at `/cms/docs` (explicit override).
- `openapi: { docs: undefined }` → Scalar not mounted regardless of environment.

**Theming:** The four Scalar themes (`default`, `moon`, `purple`, `solarized`) are passed directly to `apiReference`. If an invalid theme is provided, `createCMS` logs a warning and falls back to `default`. The theme affects only the Scalar UI — not the spec content.

**Security in the Scalar try-it console:** Scalar's `authentication` config pre-selects the `BearerAuth` scheme and shows a bearer token input at the top of the try-it panel. After the developer obtains a token from `POST /api/auth/sign-in`, they paste it into Scalar and all subsequent try-it requests include `Authorization: Bearer <token>`. This requires no additional code in the spec — it is purely a Scalar UI configuration.

**Patterns to follow:**
- `@scalar/hono-api-reference` `apiReference` function signature
- Existing CMS route mounting pattern in Plan 003 (`packages/core/src/core/routes.ts`)

**Test scenarios:**
- In test environment (non-production): `mountScalarUI` mounts a route at `/cms/docs`.
- In simulated production (`NODE_ENV=production`) with `openapi: true`: `GET /cms/docs` returns 404.
- In simulated production with `openapi: { docs: '/cms/docs' }`: `GET /cms/docs` returns 200.
- `GET /cms/docs` returns a 200 response with `Content-Type: text/html`.
- The response HTML contains a `<script>` tag referencing the Scalar CDN or the bundled Scalar assets.
- An invalid theme value falls back to `default` without crashing.
- The `authentication.preferredSecurityScheme` is `'BearerAuth'` in the rendered Scalar config.

**Verification:** Navigating to `/cms/docs` in a browser (dev environment) renders the Scalar UI. The spec loads without CORS errors. The `BearerAuth` token input is visible in the try-it panel. In production mode without an explicit `docs` path, `GET /cms/docs` returns 404.

---

### U6. Spec Serving — `GET /cms/openapi.json`

**Goal:** Serve the pre-assembled OpenAPI 3.1 spec as a static JSON response with ETag caching, CORS headers for external clients, and correct production behavior.

**Requirements:**
- The spec is assembled once at `createCMS` bootstrap time (not per-request).
- `GET /cms/openapi.json` responds with:
  - `Content-Type: application/json`
  - `ETag: "<stable-hash-of-spec>"` — computed at startup, not per-request
  - `Cache-Control: public, max-age=3600` in production; `Cache-Control: no-store` in development
  - `Access-Control-Allow-Origin: *` (CORS for Postman, Insomnia, Scalar desktop)
  - `Access-Control-Allow-Methods: GET, OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type`
- `OPTIONS /cms/openapi.json` handles CORS preflight.
- Conditional GET: if the request includes `If-None-Match` matching the spec's ETag, return `304 Not Modified` (no body).
- The spec endpoint is disabled in production unless `openapi.path` is explicitly set in config (same production gate as Scalar — see U5).
- The spec endpoint does NOT appear in the spec itself (no circular documentation).

**Dependencies:** U1–U4 (spec must be fully assembled before it can be served). U3 for query params to be in the spec.

**Files:**
- `packages/core/src/openapi/builder.ts` — `buildSpec(app, config, authSpec)` → `{ specJSON: string, etag: string }`
- `packages/core/src/openapi/routes/admin.ts` — `GET /cms/openapi.json` and `OPTIONS /cms/openapi.json` route definitions
- `packages/core/src/openapi/index.ts` — orchestration: call `buildSpec` at startup, store result, mount spec route
- `packages/core/src/openapi/__tests__/spec-serving.test.ts`

**Approach:**

`buildSpec` is called once during `createCMS` bootstrap, after all routes are registered. It:
1. Calls `app.getOpenAPI31Document(info, servers)` to get the CMS-generated spec.
2. Calls `mergeSpecs(cmsSpec, authSpec)` to merge the auth spec (from U4).
3. Serializes to JSON: `specJSON = JSON.stringify(mergedSpec)`.
4. Computes ETag: `etag = '"' + hash(specJSON) + '"'` — using a fast non-cryptographic hash (e.g., FNV-1a or xxhash). The ETag is wrapped in double-quotes per RFC 7232. The hash is stable — same spec content always produces the same ETag across restarts.
5. Returns `{ specJSON, etag }`.

The `specJSON` and `etag` are stored in a module-level closure inside `packages/core/src/openapi/index.ts`. They are set once and never mutated after startup. This is safe because the spec does not change at runtime (route definitions are fixed at bootstrap).

The `GET /cms/openapi.json` handler:
```
if (request.headers.get('If-None-Match') === etag) {
  return c.newResponse(null, 304)
}
return c.newResponse(specJSON, 200, {
  'Content-Type': 'application/json',
  'ETag': etag,
  'Cache-Control': isProduction ? 'public, max-age=3600' : 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
})
```

The spec route is mounted **after** all content, auth, and media routes are registered, ensuring those routes contribute to the spec before it is serialized. The mounting order in `createCMS` is:

1. Content routes (`mountContentRoutes`)
2. Auth routes (`mountAuthRoutes`)
3. Media routes (`mountMediaRoutes`)
4. Build spec (`buildSpec`)
5. Mount spec route (`GET /cms/openapi.json`, `OPTIONS /cms/openapi.json`)
6. Mount Scalar UI (`mountScalarUI`) — last, depends on spec route

**ETag hash choice:** A non-cryptographic hash (FNV-1a) is sufficient — the ETag is not a security primitive, it is a cache validity check. FNV-1a is O(n) with a tiny constant, runs in microseconds on a typical spec, and produces a stable 64-bit integer. Alternatives (MD5, SHA-256) are heavier and provide no meaningful benefit for this use case.

**Patterns to follow:**
- Hono's `c.newResponse()` for raw response construction
- Existing CMS route definitions in Plan 003

**Test scenarios:**
- `GET /cms/openapi.json` returns 200 with `Content-Type: application/json`.
- The response body is valid JSON that parses without error.
- The response includes `ETag`, `Cache-Control`, and `Access-Control-Allow-Origin` headers.
- A second `GET` with `If-None-Match: <etag>` returns 304 with no body.
- A second `GET` with a different `If-None-Match` value returns 200.
- `OPTIONS /cms/openapi.json` returns 200 with the CORS headers.
- In development (non-production), `Cache-Control` is `no-store`.
- In production, `Cache-Control` is `public, max-age=3600`.
- In production with `openapi: true` and no explicit `path`, `GET /cms/openapi.json` returns 404.
- In production with `openapi: { path: '/cms/openapi.json' }`, `GET /cms/openapi.json` returns 200.
- The spec JSON contains paths for all registered collections.
- The ETag does not change across two requests when no routes have been modified.

**Verification:** `GET /cms/openapi.json` returns a valid OpenAPI 3.1 document. The ETag is present and stable. Conditional GET with the correct ETag returns 304. Postman can import the spec via the URL without CORS errors.

---

### U7. SDK Generation Readiness (Spec as Source of Truth for Plan 017)

**Goal:** Ensure the generated spec is structured in a way that enables Plan 017's SDK generator to produce correct TypeScript types and a usable client. Document the integration contract between the spec and SDK generation tooling so Plan 017 can proceed without revisiting spec design decisions.

**Requirements:**
- The spec uses stable `operationId` values on every path entry — these become function names in the generated SDK.
- All request and response body schemas are registered as named components in `#/components/schemas` (not inlined) — this enables code generators to produce named types rather than anonymous inline types.
- The spec version matches the configured `openapi.version` (defaults to `'1.0.0'`).
- A comment/annotation in the spec's `info.description` documents the recommended SDK generation toolchain.
- The spec is structurally compatible with `openapi-typescript` (the primary recommended tool for TypeScript SDK generation from OpenAPI).

**Dependencies:** U1–U6 (spec must be fully assembled and validated before this unit's compatibility requirements can be verified).

**Files:**
- `packages/core/src/openapi/builder.ts` — add `operationId` generation to `createRoute` declarations (update to U1's route content)
- `packages/core/src/openapi/schemas/collection.ts` — ensure all schemas use `.openapi({ ref: 'ComponentName' })` for named component registration
- `docs/references/openapi-sdk-generation.md` — integration guide for Plan 017

**Approach:**

**`operationId` convention:** Every `createRoute` declaration includes an explicit `operationId`. The convention is:
- `list{CollectionPascal}` — `GET /api/articles` → `listArticles`
- `get{CollectionPascal}ById` — `GET /api/articles/{id}` → `getArticlesById`
- `create{CollectionPascal}` — `POST /api/articles` → `createArticles`
- `update{CollectionPascal}` — `PUT /api/articles/{id}` → `updateArticles`
- `patch{CollectionPascal}` — `PATCH /api/articles/{id}` → `patchArticles`
- `delete{CollectionPascal}` — `DELETE /api/articles/{id}` → `deleteArticles`
- `publish{CollectionPascal}` — `POST /api/articles/{id}/publish` → `publishArticles`
- `unpublish{CollectionPascal}` — `POST /api/articles/{id}/unpublish` → `unpublishArticles`
- Media routes: `uploadMedia`, `listMedia`, `deleteMedia`, `presignMedia`, `confirmMedia`
- Admin routes: `getCMSHealth`, `getCMSOpenAPISpec`

`operationId` values must be unique across the entire spec. If two collections happen to share a name after PascalCase transformation (extremely unlikely), a warning is logged and the second one gets a numeric suffix.

**Named component registration:** `@hono/zod-openapi` registers Zod schemas as named components when `.openapi({ ref: 'ComponentName' })` is called on the schema before passing it to `createRoute`. This must be done in U2's schema derivation — every call to `deriveResponseSchema` and `deriveCreateInputSchema` adds `.openapi({ ref: 'ArticleResponse' })` and `.openapi({ ref: 'ArticleCreateInput' })` respectively.

**`openapi-typescript` compatibility:**
- `openapi-typescript` (`npx openapi-typescript /cms/openapi.json -o types.ts`) produces TypeScript types from the spec.
- For the generated types to be useful, every schema referenced in a response body must be a named component (not an inline schema) — this is satisfied by the named component registration above.
- The `operationId` values become the keys of the `operations` type in the generated output, enabling the pattern: `type ListArticlesResponse = paths['/api/articles']['get']['responses']['200']['content']['application/json']`.
- Discriminated union types (populated vs. unpopulated relations from U2) are generated as TypeScript union types, which `openapi-typescript` handles correctly.

**SDK generation command (documented, not automated in this plan):**
```
npx openapi-typescript http://localhost:3000/cms/openapi.json -o ./cms-types.ts
```

This is the command Plan 017 will automate. The spec served at runtime is the single source of truth — no separate spec file needs to be maintained.

**Patterns to follow:**
- `openapi-typescript` documentation for schema naming requirements
- `@hono/zod-openapi` `.openapi({ ref })` documentation

**Test scenarios:**
- Every path entry in the assembled spec has a non-empty `operationId`.
- `operationId` values are unique across the entire spec (no duplicates).
- `operationId` follows the naming convention: `listArticles`, `getArticlesById`, `createArticles`, etc.
- All response body schemas in the spec are `$ref` pointers to named components (no inline schemas in response bodies).
- All request body schemas in the spec are `$ref` pointers to named components.
- Running `openapi-typescript` against the spec output produces valid TypeScript without errors.
- The generated TypeScript includes a type for each collection's response schema.
- `paths['/api/articles']['get']['responses']['200']` resolves to `ArticlePaginatedResponse` in the generated types.

**Verification:** `openapi-typescript` runs against the live spec with zero errors. All `operationId` values are unique. Named component registration is confirmed by checking that `components.schemas` in the spec JSON contains `ArticleResponse`, `ArticleCreateInput`, etc. for each configured collection. Plan 017 can proceed using the spec contract documented in `docs/references/openapi-sdk-generation.md`.

---

## Alternative Approaches Considered

### Manual spec assembly (separate from route definitions)

Write routes as plain Hono handlers and maintain a separate `spec.ts` file that hand-codes the OpenAPI paths object. This is the approach used by many existing Hono projects before `@hono/zod-openapi` reached stability.

**Why rejected:** A manually maintained spec immediately drifts from the actual routes. Every time a query parameter is added, a response field changes, or a new route is added, two files must be updated instead of one. For a CMS with 7 routes per collection and potentially 20+ collections, this is 140+ paths to maintain in two places. The spec will be wrong within weeks of launch. The single `createRoute` declaration that generates both the handler metadata and the spec path entry is strictly better.

### `zod-to-openapi` (standalone, not tied to Hono)

`zod-to-openapi` (from `@asteasolutions/zod-to-openapi`) is a standalone library that generates OpenAPI schemas from Zod types without Hono integration. It requires manually constructing the `OpenAPIRegistry`, registering each schema and path, and generating the document separately from the route definitions.

**Why rejected:** This produces the same drift problem as manual spec assembly — the Zod schemas are in sync with the spec but the route definitions (method, path, middleware, validation) are not captured in the registry. `@hono/zod-openapi` is the integrated option that collapses both into one declaration. For the few parts of the spec that `@hono/zod-openapi` cannot cover (the auth spec from better-auth), `zod-to-openapi` is not needed — `@better-auth/openapi` handles auth separately.

### Swagger UI over Scalar

Swagger UI is the most widely deployed OpenAPI renderer. It is familiar to most API developers, has broad tooling support, and is available as `@hono/swagger-ui`.

**Why rejected (and confirmed by the ideation document):** The ideation explicitly names Scalar as the chosen UI. Scalar is faster than Swagger UI (no iframe, CDN-loaded), dark-mode by default, mobile-friendly, OpenAPI 3.1 native (Swagger UI's 3.1 support lags), and used by Hono's own documentation. Scalar is the current-generation replacement for Swagger UI in the TypeScript/Hono ecosystem. The only reason to choose Swagger UI would be familiarity in enterprise contexts — not a relevant concern for a developer-first CMS library.

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@better-auth/openapi` plugin API changes | Medium | Medium | Pin the better-auth version; the merge layer is isolated in `merge-auth-spec.ts` so breakage is locally contained |
| `deepObject` filter params not rendering correctly in Scalar | Medium | Low | Thoroughly test with the actual Scalar version before release; the description fallback always works |
| Spec grows too large with many collections causing slow Scalar load | Low | Medium | Scalar handles large specs well; test with 20+ collections; implement lazy spec loading if needed |
| `operationId` conflicts across collections | Very Low | Low | Validation check at startup with a console.warn; numeric suffix fallback |
| ETag hash collision causing stale spec delivery | Negligible | Medium | FNV-1a 64-bit collision probability is 1 in 2^64 for any two inputs; acceptable |
| `openapi-typescript` incompatibility with generated spec | Low | Medium | Run `openapi-typescript` as part of U7 verification; fix any schema registration issues before Plan 017 begins |
| Production Scalar exposure (developer forgets it's enabled) | Low | Medium | The default-off-in-production behavior prevents accidental exposure; the gate is `NODE_ENV` based, not a flag developers must set |

---

## Dependencies and Prerequisites

| Prerequisite | Plan | Why Required |
|---|---|---|
| Content routes exist | Plan 006 | Cannot migrate routes to `createRoute` until they exist |
| better-auth integration | Plan 008 | Cannot retrieve auth instance for `@better-auth/openapi` |
| Media API routes exist | Plan 009 | Hand-coded media schemas must match actual endpoints |
| `defineCollection` schema types | Plans 001–002 | `deriveCreateInputSchema` reads collection field definitions |
| `@hono/zod-openapi` | npm | Core library for route + spec declaration |
| `@scalar/hono-api-reference` | npm | Scalar UI rendering |
| `@better-auth/openapi` | npm | Auth spec generation (optional peer dep) |

---

## System-Wide Impact

- **`packages/core`:** Gains `openapi/` subdirectory. `createCMS` bootstrap gains spec assembly step. Content router switches from `Hono` to `OpenAPIHono`.
- **`packages/core` bundle size:** `@scalar/hono-api-reference` adds ~15KB gzipped to the server bundle (Scalar loads from CDN for the browser UI; only the route handler code is in the server bundle). `@hono/zod-openapi` adds ~5KB.
- **Plan 006 content routes:** Mechanical migration to `createRoute` — behavior unchanged, declaration syntax changes.
- **Plan 017 SDK generation:** Now has a stable, structured spec to generate from. `operationId` naming convention is the primary contract.
- **Cold start time:** Spec assembly (`buildSpec`) adds a one-time cost at startup. With 20 collections × 8 routes, the spec has ~160 paths. JSON serialization of a typical spec at this size takes < 5ms. Negligible for all target runtimes.
- **External consumers:** Postman, Insomnia, and Scalar desktop can import the spec by URL (`GET /cms/openapi.json`) without any additional configuration.

---

## Completion Checklist

Before marking this plan complete and beginning dependent work:

- [ ] U1: `app.getOpenAPI31Document(...)` returns a document containing all seven operation types for each registered collection.
- [ ] U1: Existing content route integration tests pass unchanged after `createRoute` migration.
- [ ] U2: `deriveCreateInputSchema` excludes `id`, `createdAt`, `updatedAt`, `status` fields.
- [ ] U2: Relation fields in write schemas are `z.string()` (ID reference).
- [ ] U2: Relation fields in read schemas are `z.union([z.string(), RelatedSchema])`.
- [ ] U2: `fieldPermissions`-restricted fields are `.optional()` in the response schema.
- [ ] U3: All five query parameter types (`filters`, `sort`, `pagination`, `populate`, `fields`) appear in the `GET /api/{collection}` path parameters.
- [ ] U3: The assembled spec validates against the OpenAPI 3.1 JSON Schema.
- [ ] U3: `pagination` Zod schema coerces string inputs to numbers.
- [ ] U4: `prefixAuthSchemas` correctly renames all auth component schemas.
- [ ] U4: `rewriteRefs` correctly rewrites all `$ref` pointers in the auth spec.
- [ ] U4: The merged spec contains paths from both CMS and auth.
- [ ] U4: The merged spec validates without dangling `$ref` pointers.
- [ ] U5: Scalar UI renders at `/cms/docs` in development.
- [ ] U5: `GET /cms/docs` returns 404 in production with `openapi: true`.
- [ ] U5: `GET /cms/docs` returns 200 in production with `openapi: { docs: '/cms/docs' }`.
- [ ] U5: Bearer token input is visible in the Scalar try-it panel.
- [ ] U6: `GET /cms/openapi.json` returns 200 with correct headers.
- [ ] U6: Conditional GET with correct ETag returns 304.
- [ ] U6: CORS headers are present (`Access-Control-Allow-Origin: *`).
- [ ] U6: Cache-Control is `no-store` in development, `public, max-age=3600` in production.
- [ ] U7: All path entries have unique, non-empty `operationId` values.
- [ ] U7: All response and request schemas are named components (no inline schemas in `paths`).
- [ ] U7: `openapi-typescript` generates valid TypeScript from the live spec with zero errors.
