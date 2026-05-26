---
date: 2026-05-15
topic: hono-cms-rebuild
focus: Build a Hono-based universally-deployable CMS alternative to Strapi — IAC philosophy, multi-runtime (CF Workers, Vercel Edge, Node.js, Convex), cheaper for small projects
mode: repo-grounded
---

# Ideation: Hono-Based Universally-Deployable CMS (Strapi Alternative)

## Grounding Context

**Codebase (Strapi v5.46.0):**
- Yarn workspaces + Nx monorepo, TypeScript, Node 20–24
- HTTP framework: **Koa.js** — deeply coupled to all middleware, session, auth, and request context; no edge-runtime adapter exists or is planned
- Plugin system: dual entry points (`strapi-server` / `strapi-admin`), content types as JSON schemas compiled at boot from disk files
- Database: **Knex.js** with auto-schema-sync; TCP-connection model; no edge-compatible path (D1, Turso, Neon HTTP)
- Admin panel: React 18 + Webpack, bundled and served by the same Koa server — cannot be deployed independently or edge-cached
- Deployment: Node.js-only single process; no serverless or edge support
- Auth: JWT + CASL-based RBAC evaluated per-request; SessionManager with httpOnly refresh cookies; a full permissions table in the database
- Content API: `strapi.documents` (Document Service v5) — deprecated EntityService removed
- Key pain points: monolithic bootstrap, Koa coupling blocking edge, schema changes require full redeploy, CT Builder locked to dev mode, EE/CE runtime gates, admin tight coupling, pricing $18–$450/month cloud

**External signals:**
- **SonicJS** — production Hono + D1 + Drizzle CMS; Cloudflare-only; HTMX admin; closest prior art but single-runtime
- **HonoHub** — alpha Hono + Drizzle + Zod CMS middleware (rhinobase); pre-stable
- **Payload CMS v3** confirmed on CF Workers; D1 read replicas cut P50 latency 60% (300ms → 120ms)
- **Hono RPC**: `typeof app` export gives full end-to-end type safety to any TypeScript consumer with zero codegen
- **Drizzle ORM**: adapters for D1, Turso/libSQL, Neon, Postgres, MySQL; `drizzle-kit generate` = plan; `drizzle-kit migrate` = apply
- **apollo-server-integration-next** (`@as-integrations/next`) — Apollo Server integration using the Web Standards `Request`/`Response` API; `startServerAndCreateHandler` returns a native `Response` making it directly compatible with Hono (`app.all('/graphql', c => handler(c.req.raw))`), Cloudflare Workers, Vercel Edge, and Next.js App Router — same code, all runtimes
- **better-auth**: TypeScript-native auth library with Hono as a first-class integration, Drizzle as a first-class DB adapter, and a plugin system covering 2FA, Organizations, SSO, OIDC Provider, API Keys, MCP, Passkeys, Magic Link, and payment integrations (Stripe, Polar, etc.). Convex supported natively. Auth tables live in the same DB as content tables — same Drizzle config drives both.
- **Strapi pricing pain**: real developer community complaints; $50/month per extra environment; CT Builder locked to dev mode
- **SQLite/D1/Turso** production-ready at edge for read-heavy workloads as of 2026
- **SST Ion** — schema/config file drives cloud resource provisioning (TypeScript → CloudFormation)

## Topic Axes

1. Deployment portability — runtime adapters for CF Workers, Vercel Edge, Node.js, Convex
2. Schema & content type system — code-first TypeScript definitions, migrations, validation
3. Plugin/extension architecture — extensibility surface without tight coupling
4. Database abstraction — adapter pattern for D1, Turso, Neon, standard SQL, Convex
5. Admin panel & DX — management UI architecture, typed client SDK, developer ergonomics

---

## Ranked Ideas

### 1. Typed `DatabaseAdapter` Interface Per npm Package

**Description:** The entire database abstraction is a TypeScript interface that separate npm packages implement: `@hono-cms/adapter-d1` (Cloudflare D1 via Drizzle), `@hono-cms/adapter-postgres` (Node.js/Vercel via Drizzle Postgres), `@hono-cms/adapter-turso` (libSQL), `@hono-cms/adapter-convex` (Convex document store with reactive queries), `@hono-cms/adapter-git` (git-backed JSON for static sites at $0). The active adapter is declared in the schema config at build time — not a runtime switch. Each adapter ships its own Drizzle schema generator so migrations are adapter-aware. Runtime database switching is explicitly unsupported by design.

**Axis:** Database abstraction

**Basis:**
- `direct:` Strapi's Knex.js TCP-connection model is the confirmed architectural blocker for all edge deployment. This is not speculation — it is the reason SonicJS is Cloudflare-only and no production Strapi-on-edge deployment exists.
- `external:` Drizzle ORM's dialect-per-driver model (`drizzle-orm/sqlite-core` vs `drizzle-orm/pg-core`) demonstrates typed adapter separation in production. Payload v3 uses Drizzle for exactly this multi-backend portability.
- `reasoned:` D1 uses Workers-native bindings; Postgres requires TCP incompatible with Workers; Convex has no SQL surface; Git has no query model. A runtime config switch handles dialect differences but cannot handle semantic differences. Only a typed adapter interface makes the "universally deployable" promise structurally true.

**Rationale:** This is the single unblocking architectural decision for edge deployment. Every other idea in this list depends on it — without a typed adapter layer, the system has the same deployment constraints as Strapi regardless of every other decision made.

**Downsides:** The adapter interface must be expressive enough to cover SQL and document stores without becoming least-common-denominator. Relational operations (joins, polymorphic relations) are hard to abstract across SQL and Convex. The Convex adapter may require adopting Convex's server function model, which changes the request architecture.

**Confidence:** 92%

**Complexity:** High (interface design) / Low (individual adapters once interface is stable)

**Status:** Unexplored

---

### 2. CMS as a Deployable Library

**Description:** Invert the deployment model entirely. Instead of a standalone CMS process you deploy, the CMS is an npm package: `import { createCMS } from '@hono-cms/core'`. Pass your schema and database adapter, receive a Hono router, mount it at any path inside any existing application. The developer brings the runtime; the CMS is a build-time dependency. Cold starts are deterministic because there is no bootstrap phase — schema is pre-compiled, adapters are tree-shaken. Works in a Cloudflare Worker, a Vercel Edge Function, a Next.js API route, a Node.js Express app, or standalone.

**Axis:** Deployment portability

**Basis:**
- `external:` This is the pattern of every successful modern TypeScript infrastructure library: Lucia (auth), Drizzle (ORM), NextAuth (auth), Hono itself. Libraries you import, not services you run. Payload v3 uses the same embedded-library model.
- `reasoned:` "CMS as a library" is the architectural decision that enables the $0/month cost model. There is no separate CMS server to pay for, no Docker container to maintain, no cold start penalty from a full Strapi bootstrap.
- `direct:` Hono explicitly supports `app.route('/cms', subApp)` where `subApp` is a full Hono instance — this is a documented first-class feature, not a workaround.

**Rationale:** For small projects the operational surface of running a separate CMS server is the largest hidden cost. If the CMS is a Hono sub-app that deploys wherever the main app deploys, that cost drops to zero. This also means the CMS inherits the main app's deployment profile and auth context without CORS, without separate env vars, without a second server.

**Downsides:** Library model requires the developer to own the runtime — more setup upfront than a hosted service. Projects that want a fully managed experience need a wrapper (a "starter" template). Debugging is harder when CMS logic is interleaved with application logic.

**Confidence:** 90%

**Complexity:** Low

**Status:** Unexplored

---

### 3. UI-Generated Schema with Auto-Migration in Dev + Plan/Apply CLI in Prod

**Description:** The developer never writes schema files manually. The admin UI is the schema editor — identical to Strapi's Content-Type Builder. When a developer adds a field or creates a collection in the admin UI:

**Dev mode (automatic):**
1. CMS writes/updates the TypeScript collection file in `./cms/collections/` (e.g., `articles.ts`)
2. CMS calls `drizzle-kit generate` internally — produces a SQL migration file
3. CMS applies the migration to the local dev DB immediately
4. REST routes, GraphQL schema, and admin form fields update without a manual restart

**Prod mode (safe, explicit):**
1. The committed `./cms/collections/` files are the source of truth
2. The admin UI displays content types but **cannot modify structure** — CT Builder is disabled in prod
3. `cms schema plan` diffs the committed TypeScript files against the live DB state and outputs a human-readable plan: "Add optional field `publishedAt` to `articles`" — not raw SQL
4. `cms schema apply` executes the plan, commits the migration file to `db/migrations/`
5. `cms schema check --assert-clean` runs in CI and fails if the live DB has drifted from the committed schema

The generated TypeScript files in `./cms/collections/` **are committed to git** — they are the version-controlled schema record. A PR that adds a `salary` field to `employees` is visible in the diff alongside the generated migration file. Reverting the PR reverts the schema.

```
cms/collections/
  articles.ts       ← generated by admin UI, committed to git
  authors.ts
  media.ts
db/migrations/
  0001_init.sql     ← generated by cms schema apply, committed to git
  0002_add_published_at.sql
```

**Axis:** Schema & content type system

**Basis:**
- `direct:` Strapi's CT Builder is locked to dev mode and schema changes require a full production redeploy — the two most consistently cited pain points. This model keeps the CT Builder UX in dev but adds a safe production path.
- `direct:` Strapi AGENTS.md: "Never write raw migrations for content type schema changes" — the prohibition exists because the safe workflow does not exist. This idea provides it.
- `external:` Atlas (Ariga.io) and Drizzle's `drizzle-kit generate` both implement the plan/apply model for database schema management. The CMS wraps Drizzle's tooling internally and elevates the output to content-type-semantic language rather than raw SQL diffs.
- `external:` Terraform's plan/apply mental model — the user explicitly framed the project as "IAC for content." Plan/apply is the production-safe implementation of that framing.

**Rationale:** This is the central UX promise: Strapi's zero-friction dev experience (click to add a field, it just works) combined with IaC discipline in production (schema changes are code, reviewable, version-controlled, applied safely). The two modes share the same generated files — there is no separate "dev schema" and "prod schema." What you build in the admin UI in dev is exactly what ships to prod after review.

**Downsides:** Generated TypeScript files that no developer wrote create an unfamiliar editing experience — the files exist in the repo but are owned by the CMS tooling, not the developer. Parallel schema changes in separate branches create migration file conflicts that require manual resolution. Destructive changes (column drops, renames) require explicit human approval in the plan step — this is correct behavior but adds friction for rapid iteration.

**Confidence:** 90% (upgraded from 88%)

**Complexity:** Medium

**Status:** Unexplored — refined 2026-05-15 (schema is UI-generated in dev, committed to git, plan/apply in prod; developer never writes schema files manually)

---

### 4. Plugin = `(app: Hono) => Hono` + Capability Declarations

**Description:** The entire plugin contract is one TypeScript function type: `type Plugin<Env> = (app: Hono<Env>) => Hono<Env>`. A plugin receives the Hono app, mounts its routes and middleware via `.route()` and `.use()`, and returns the composed app. There is no plugin registry, no marketplace, no CLI install command, no dual entry point system, no `initialize()` method. Plugins are npm packages; installation is `npm install @org/hono-cms-plugin-seo`. Each plugin also exports a `capabilities` object declaring its requirements: `{ reads: ['articles'], writes: ['media'], requiresEnv: ['S3_BUCKET'] }`. The CMS bootstrap validates all capability declarations against the active adapter and env vars before the first request is handled, so incompatible plugins fail at startup rather than under load.

**Axis:** Plugin/extension architecture

**Basis:**
- `direct:` Strapi's dual entry point system (`strapi-server` + `strapi-admin`) is the primary plugin author friction source. A plugin that violates the contract silently fails or crashes the server.
- `external:` Hono middleware is already distributed as npm packages (`hono/cors`, `hono/jwt`) and composed via `.use()`. Express proved this model viable for 15+ years.
- `reasoned:` Making `(app: Hono) => Hono` the only contract removes all ceremony and makes the entire plugin API self-documenting. A contract violation is a TypeScript compile error. Banning `initialize()` from the type signature makes async startup a compile error, ensuring Workers compatibility for all plugins by construction.

**Rationale:** A single-function contract means the entire plugin ecosystem is auditable via npm, any Hono app is a valid plugin, and there is no proprietary API surface to document or maintain. The capability declaration system prevents the silent-failure-at-runtime class of plugin bugs that Strapi plugin authors encounter on CF Workers when a required binding is absent.

**Downsides:** The function composition model loses lifecycle hooks — plugins can't run cleanup on shutdown or respond to content events without the webhook model (see rejection summary). More complex plugins needing database access must accept the adapter as a parameter, slightly complicating the contract. Cross-plugin ordering isn't guaranteed without the priority system SonicJS uses.

**Confidence:** 87%

**Complexity:** Low

**Status:** Unexplored

---

### 5. Decoupled Static Admin SPA (TanStack + Jotai) + Hono RPC Typed Client

**Description:** The admin panel is a Vite-built React SPA deployed independently to Cloudflare Pages, Vercel, or any CDN — zero admin code in the API worker bundle. The CMS exposes **two API surfaces**, both auto-generated from the same schema definitions:

- **REST via Hono RPC** — `typeof app` export; zero-codegen typed `hc` client for TypeScript consumers; primary interface for the admin SPA and external frontends
- **GraphQL via Apollo Server** — mounted internally at `GET|POST /graphql` by `createCMS`; schema auto-generated from collection definitions (each collection → GraphQL type + `findOne`/`findMany`/`create`/`update`/`delete` operations); `createCMS` uses `apollo-server-integration-next` (`startServerAndCreateHandler`) internally — the developer never imports Apollo Server or the integration package; the GraphQL context function is wired internally to the better-auth session so permissions (idea #8) apply uniformly; enabled via a top-level config key:

```ts
const cms = createCMS({
  db: { provider: 'sqlite', options: { url: env.DATABASE_URL } },

  // Points to the directory where the CMS generates and maintains schema files.
  // The developer never writes these files — the admin UI generates them.
  // In dev: every schema change in the UI auto-updates the TypeScript files
  //         and auto-runs migrations against the local DB.
  // In prod: committed schema files are the source of truth;
  //          the UI shows content types but cannot modify structure;
  //          `cms schema plan` + `cms schema apply` are the safe migration path.
  schema: { dir: './cms/collections' }, // default; can be omitted if convention is fine

  auth: { plugins: [organization(), apiKey(), twoFactor()] },
  graphql: true, // or { path: '/graphql', introspection: true, playground: false }
})

export default cms.handler // Hono app — REST + GraphQL + auth routes, all composed
```

Both surfaces use the same underlying content service layer. A consumer picks REST for type-safe TypeScript clients or GraphQL for flexible cross-platform queries — the CMS doesn't force a choice. The admin SPA uses REST via Hono RPC; mobile apps, third-party integrations, and API explorers use GraphQL.

The SPA is built on the **TanStack + Jotai** stack — each library chosen for a specific admin problem it solves headlessly:

| Library | Role in the admin |
|---|---|
| **TanStack Router** | File-based type-safe routing; route params and search params are typed; integrates with Hono RPC types for end-to-end URL type safety |
| **TanStack Query** | Server state for all content API calls via the `hc` client; handles caching, background refetch, optimistic updates, and stale-while-revalidate for content lists |
| **TanStack Table** | Headless table primitive for content list views; column definitions typed from the schema; paired with TanStack Virtual for large datasets |
| **TanStack Form** | Headless form handler for content editing; field definitions are derived from the schema at runtime — no hand-written form JSX per content type; validation wired to the same Zod validators the API uses |
| **TanStack Virtual** | Virtualization for content lists, media galleries, and large relation selectors — handles collections with thousands of records without pagination overhead |
| **TanStack HotKeys** | Type-safe keyboard shortcuts with no magic `useEffect` listeners — `Ctrl+S` auto-save, `Ctrl+Shift+P` publish, `Ctrl+K` command palette; shortcuts are declared as typed config |
| **TanStack Pacer** | Debounce auto-save (500ms after last keystroke), throttle live-search queries, rate-limit bulk publish operations, queue draft saves when offline |
| **Jotai** | Atomic state for UI-only concerns: selected items in a content list, expanded sidebar sections, unsaved-changes indicator, command palette open state — no Redux boilerplate, no context re-render waterfalls |

Because better-auth only ships API endpoints (no auth UI), the admin SPA also owns **all auth pages**: login, register, forgot password, magic link landing, 2FA setup, organization management, member invitations, API key management. These are built with TanStack Form + TanStack Router and call the better-auth API via the same `hc` client.

**Axis:** Admin panel & DX

**Basis:**
- `direct:` Strapi: "Koa.js HTTP server + React/Redux admin unified process." The bundled admin is the primary reason Strapi cannot run on CF Workers (compressed bundle size limit).
- `external:` Payload v3 uses this exact decoupled admin pattern on CF Workers. TanStack Router, Query, Table, Form, and Virtual are all production-stable in 2026 with strong TypeScript-first APIs.
- `direct:` Hono RPC `hc` client — zero-codegen typed API calls from the admin.
- `reasoned:` TanStack Form + schema-derived field definitions mean the admin never needs a hand-written form per content type. The schema defines fields; TanStack Form renders them. Adding a new field to a collection adds it to every admin form automatically. TanStack Virtual + Table handles a 10k-row content list with the same code as a 10-row one. TanStack Pacer handles auto-save without race conditions or debounce bugs from manual `setTimeout` wiring.

**Rationale:** The specific library choices are not arbitrary — each one eliminates a class of admin-specific bugs. TanStack HotKeys replaces `useEffect`-based keyboard listeners that fire twice in StrictMode. TanStack Pacer replaces hand-rolled debounce utilities that leak across renders. TanStack Form replaces uncontrolled-vs-controlled state confusion in complex nested content type forms. Jotai replaces useState prop drilling for cross-component UI state. Together they produce an admin that is fast (Virtual), type-safe (Router + RPC), and low-maintenance (Form derives from schema).

**Downsides:** TanStack ecosystem has multiple moving packages — version pinning and coordinated upgrades add maintenance overhead. CORS between admin SPA and API is a first-class concern requiring explicit configuration. Real-time features (collaborative editing, live previews) need SSE or WebSockets — not a Workers default. The auth UI pages (login, org management) need to be built and maintained as part of the admin SPA; they're not provided by better-auth.

**Confidence:** 91%

**Complexity:** Medium

**Status:** Unexplored — refined 2026-05-15 (added TanStack + Jotai stack rationale; added better-auth UI ownership requirement)

---

### 6. better-auth as Canonical Auth Integration (CMS-Owned DB Config)

**Description:** The CMS ships with better-auth as its auth layer, configured through a unified `createCMS` API that owns the database connection. The developer passes one `db` config object; the CMS internally creates the Drizzle adapter and shares it with better-auth — no duplicate DB configuration, no pre-constructed instances to wire together. Auth capabilities are declared as a nested `auth` config with better-auth plugins. The CMS handles the internal wiring.

```ts
import { createCMS } from '@hono-cms/core'
import { organization, apiKey, twoFactor } from 'better-auth/plugins'

const cms = createCMS({
  db: {
    provider: 'sqlite',      // 'd1' | 'postgres' | 'turso' | 'mysql' | 'convex'
    options: {
      url: env.DATABASE_URL, // or binding: env.DB for D1
    },
  },
  // Schema is derived from content type definitions — auto-migrates in dev,
  // requires cms schema plan + apply in production (idea #3)
  schema,
  auth: {
    // All better-auth options except `database` — the CMS injects that from db above
    plugins: [organization(), apiKey(), twoFactor()],
    // emailAndPassword, socialProviders, trustedOrigins, etc. supported as-is
  },
})

export default cms.handler // Hono app, ready to mount or deploy
```

Internally, `createCMS` runs roughly:
1. Creates the Drizzle client from `db` config (provider-aware: D1 binding vs TCP vs libSQL)
2. Passes the same Drizzle client to better-auth via `drizzleAdapter` — no second DB connection
3. Mounts the better-auth Hono handler at `/api/auth/*`
4. Runs schema sync (dev: auto-migrate; prod: assert-clean or plan output)
5. Returns the composed Hono app with content routes + auth routes

Auth tables (`users`, `sessions`, `accounts`, `organizations`, `api_keys`) live in the same database as content tables. The `cms schema plan` CLI from idea #3 includes both content and auth schema in a single migration journal.

**Axis:** Admin panel & DX

**Basis:**
- `external:` better-auth lists Hono as a first-class backend integration and Drizzle as a first-class database adapter. No glue code — the internal wiring `createCMS` does is exactly what the better-auth docs show.
- `external:` better-auth's plugin ecosystem covers: 2FA, Passkeys, Magic Link, Email OTP, Phone Number, Anonymous, Generic OAuth, One Tap (authentication); Admin, Agent Auth, API Key, MCP, Organization (authorization); OIDC Provider, OAuth Provider, SSO, SCIM (enterprise); Stripe, Polar, and payment integrations. Convex is a native integration.
- `reasoned:` Accepting a `db` config object (not a pre-built instance) in `createCMS` eliminates the most common misconfiguration — two separate DB connections for content and auth that drift apart. One config drives both. Internally, `createCMS` is the composition layer; the developer sees zero better-auth internals unless they need to extend them.
- `reasoned:` Schema auto-migration in dev mode (on every schema change from the UI) and plan/apply in prod mirrors exactly how Strapi's CT Builder works in dev — but without the "can only run in dev mode" constraint, because the mechanism is the same Drizzle migration journal used in all environments.

**Rationale:** The unified `db` config is the key API decision. It means the developer configures the database exactly once — and that configuration propagates to content storage, auth storage, and migrations. No opportunity for the auth DB and content DB to diverge. Upgrading auth capabilities (adding SSO, enabling org management) is an `auth.plugins` array change in one file. The CMS never owns auth logic and never needs to be updated when better-auth ships new plugins.

**Downsides:** `createCMS` must internalize the DB→adapter logic for every supported provider, which adds surface area to the core. better-auth's schema evolves with its plugins — when a new plugin is added, its tables appear in the next `cms schema plan` output; developers may be surprised by unexpected migrations. Fine-grained content-level authorization (which roles can edit which fields) is not covered by better-auth's Organization plugin — that remains the CMS's responsibility via schema-level predicates.

**Confidence:** 90% (upgraded from 88%)

**Complexity:** Low (config API) / Medium (internal adapter wiring per provider)

**Status:** Unexplored — refined 2026-05-15 (unified db config; CMS owns internal wiring; schema auto-migration behavior documented)

---

### 7. Schema-Driven Infrastructure Provisioning (IaC Deploy Command)

**Description:** The TypeScript schema file is the single source of truth for both API shape and cloud infrastructure. `cms deploy --target=cloudflare` reads `schema.ts`, generates a Wrangler config with D1 bindings, KV namespaces for caching, and R2 buckets for media collections, then deploys the worker. `cms deploy --target=vercel` emits Vercel project config with the appropriate database integration (Neon, KV). `cms deploy --target=node` generates a Docker Compose file with Postgres. The developer never manually configures cloud resource bindings — the schema model knows what storage primitives each content type requires and provisions them.

**Axis:** Deployment portability + Schema & content type system

**Basis:**
- `external:` SST Ion (formerly SST v2) already does this for AWS — a TypeScript config file drives CloudFormation resource creation from application-level constructs. SonicJS demonstrates a full CMS fitting in a single Cloudflare Worker with D1 + KV + R2.
- `reasoned:` The biggest friction for small projects deploying a CMS is not the code — it's manually provisioning databases, configuring env bindings, and wiring up storage. If the schema file drives all of this, the gap between "defined a new content type" and "deployed to production" collapses to a single command. This is the operational completion of the "IAC for content" promise.
- `direct:` Strapi's deployment complexity (custom Dockerfile, manual env vars, database setup, migration management) is cited in the grounding as a primary reason small projects reach for the $18–$450/month cloud offering despite the cost.

**Rationale:** "Schema drives infrastructure" turns the IaC framing from a philosophy into a workflow. After `cms schema apply` runs the migration, `cms deploy` provisions the cloud resources that schema requires. A developer adding a `media` field to a content type gets R2 storage provisioned automatically on next deploy. This compounding effect is highest-leverage: the more content types the project adds, the more infra work is automated.

**Downsides:** Target-specific provisioning logic adds significant surface area to maintain. Cloud provider APIs change; Wrangler config format evolves. This is ambitious for v1 — there is risk of building brittle infra automation before the core CMS is proven. The SST model required years of iteration to stabilize. A more conservative v1 approach is to ship excellent documentation for each target and automate provisioning in v2.

**Confidence:** 73%

**Complexity:** High

**Status:** Unexplored

---

### 8. Schema-Level RBAC — Permissions Declared in `defineCollection`, Roles from better-auth

**Description:** Access control is declared as part of the collection definition — not configured through an admin UI, not evaluated from a database permissions table, not scattered across route handlers. Each collection declares which roles can perform which operations. Roles are provided by better-auth (Organization plugin member roles, Admin plugin roles, or custom roles). The CMS permission middleware reads the role from the better-auth session and checks it against the collection's permission matrix before routing to any handler — REST route or GraphQL resolver.

```ts
const articles = defineCollection({
  name: 'articles',
  schema: z.object({
    title: z.string(),
    body: z.string(),
    status: z.enum(['draft', 'published']),
    _internalNotes: z.string().optional(),
  }),
  permissions: {
    // unauthenticated
    public:        { read: true },
    // better-auth roles — from Organization plugin or Admin plugin
    authenticated: { read: true },
    editor:        { read: true, create: true, update: true },
    admin:         { read: true, create: true, update: true, delete: true, publish: true },
  },
  fieldPermissions: {
    // fields invisible to roles not listed — stripped from all responses
    _internalNotes: ['admin'],
    status:         ['editor', 'admin'],
  },
})
```

The permission middleware runs **before** any handler — wired internally by `createCMS`, not by the developer:
1. Extract session from better-auth (internal — `createCMS` shares the auth instance with the middleware)
2. Resolve the user's role(s) from the session (org membership, Admin plugin flag, or custom claim)
3. Check the requested operation against `collection.permissions[role]`
4. For field-level: strip protected fields from all responses; reject writes to protected fields

Both REST (Hono RPC routes) and GraphQL (Apollo resolvers) pass through the same middleware — because both are mounted by `createCMS` internally. The developer does not wire permission checks; they declare them in the schema. GraphQL field-level permissions are enforced via resolver-level checks derived from `fieldPermissions` — a `_internalNotes` field has its resolver return `null` for non-admin roles rather than being removed from the schema (which would break client queries that include it).

Permissions live in version control alongside the schema. A PR that grants editors `delete` access is reviewable and reversible like any other code change.

**Axis:** Schema & content type system + Plugin/extension architecture

**Basis:**
- `direct:` Strapi AGENTS.md: RBAC is evaluated at runtime from a permissions table (CASL JSON Logic engine). This means permissions can be changed through the admin UI at any time — they are not version-controlled, not reviewable in PRs, and not auditable via git history. The user reported that misconfigured Strapi permissions are a common source of accidental public endpoint exposure.
- `reasoned:` Declaring permissions in `defineCollection` completes the IaC promise: schema = content types + field shapes + validation + **access rules**. One `git diff` shows the complete state of what data exists, what shape it has, and who can touch it. The "accidentally public endpoint" class of bugs becomes a lint rule — `permissions: {}` with no `public` entry is flagged at build time, not discovered after a security audit.
- `external:` Polar, Supabase, and Hasura all use schema/config-level access declarations (Row Level Security, Hasura permission rules defined in metadata). The innovation here is making it TypeScript-native and co-located with the content type, rather than a separate permission config language.
- `reasoned:` Field-level permissions solve a Strapi gap — Strapi's field-level permission UI exists but is complex to configure correctly and easy to misconfigure for nested relations. Declaring `fieldPermissions: { _internalNotes: ['admin'] }` is one line; misconfiguring it is a TypeScript error if the field name doesn't match the schema.

**Rationale:** The permission system is the third dimension of the schema (after shape and validation). Without it, every API consumer needs to implement their own access checks. With it, the CMS enforces the same rules uniformly across REST and GraphQL, and those rules are auditable in the same PR as the schema change that created the field. The integration with better-auth roles means the CMS doesn't define what a "role" is — it reads whatever role system the developer configured in better-auth and maps it to collection operations.

**Downsides:** Role names in `permissions` must match whatever better-auth returns in the session — a mismatch silently denies access rather than erroring. Dynamic, data-dependent permissions ("user can only edit their own posts") can't be expressed as a static role→operation matrix; these require a `filter` predicate in the collection definition (e.g., `{ update: { filter: (ctx) => ({ authorId: ctx.user.id }) }}`), which increases API surface. GraphQL field-level enforcement via resolver null-return (rather than schema removal) is a design choice that may surprise clients that introspect the schema and see fields they can't read.

**Confidence:** 87%

**Complexity:** Medium

**Status:** Unexplored — added 2026-05-15 (RBAC declared in schema; roles from better-auth; unified enforcement across REST + GraphQL)

---

### 9. Storage Adapter — Binary File Handling Mirroring the DB Adapter Pattern

**Description:** Media/file handling is architecturally separate from the DB adapter and needs its own typed interface. A `storage` config key in `createCMS` accepts a provider declaration; `createCMS` creates the storage client internally and shares it with the content layer — same pattern as `db`. The schema gains a `type: 'media'` field type that references the storage layer; the CMS handles multipart upload routing, file metadata persistence in the DB, and URL generation automatically.

```ts
createCMS({
  db:      { provider: 'sqlite', options: { url: env.DATABASE_URL } },
  storage: { provider: 'r2',    binding: env.BUCKET },
  //        { provider: 's3',    options: { bucket, region, credentials } }
  //        { provider: 'blob',  token: env.BLOB_TOKEN }    // Vercel Blob
  //        { provider: 'local', dir: './uploads' }          // Node.js / dev
  ...
})
```

The admin SPA includes a **media library** — a full-screen asset browser built on TanStack Virtual (handles thousands of assets without pagination jank) and TanStack Query (optimistic uploads, background refetch). The `type: 'media'` field renders a file picker in collection forms that writes the storage URL + metadata (size, mime type, dimensions for images) back to the DB.

**Axis:** Database abstraction + Admin panel & DX

**Basis:**
- `direct:` Every production CMS requires binary file handling. Strapi's upload provider system (local, S3, Cloudinary) is one of its most-used extension points. Omitting storage means the CMS can only handle text content.
- `external:` Cloudflare R2, Vercel Blob, and AWS S3 each expose different APIs (Workers binding, HTTP token, AWS SDK respectively). The typed adapter pattern from idea #1 applies directly — one `StorageAdapter` interface, separate npm packages per provider.
- `reasoned:` Storing file metadata (URL, size, mime type, alt text) in the same DB as content — via a `media` table — enables the relation system (idea #11) to reference assets: `thumbnail: { type: 'media' }` is a relation to the media table, not a raw string URL.

**Downsides:** Image optimization (resizing, format conversion, responsive variants) is not covered by the storage adapter alone — requires a separate image transformation service (Cloudflare Images, imgix, or a Workers-based sharp pipeline). Large file uploads on edge runtimes have CPU/memory limits; multipart chunked uploads may need to route through a dedicated upload Worker.

**Confidence:** 91%

**Complexity:** Medium

**Status:** Unexplored — added 2026-05-15

---

### 10. Draft & Publish — Opt-In Content State Machine Per Collection

**Description:** Collections opt into a draft/publish lifecycle via `draftAndPublish: true`. This adds a `status` field (`'draft' | 'published'`) managed entirely by the CMS — it is not a user-defined field. The public content API automatically filters to `status: 'published'` on all queries unless the request carries an admin session or a valid preview token. The admin sees all records regardless of status.

```ts
// generated by admin UI — developer never writes this manually
defineCollection({
  name: 'articles',
  draftAndPublish: true,
  permissions: { public: { read: true }, editor: { read: true, create: true, update: true }, admin: { read: true, create: true, update: true, delete: true, publish: true } },
  fields: { ... }
})
```

State transitions:
- `cms.documents.publish(id)` — draft → published; fires `articles.publish` webhook event
- `cms.documents.unpublish(id)` — published → draft
- `cms.documents.create(...)` — always creates as draft

**Preview mode:** A signed short-lived token (`?preview=<token>`) bypasses the `status: 'published'` filter for that specific document. The admin SPA generates preview URLs; the token is verified by the CMS permission middleware without requiring a full admin session. Frontends built on the public API can show draft content in preview mode without any changes to their data fetching logic.

**Axis:** Schema & content type system

**Basis:**
- `direct:` Strapi v5's Document Service models draft/published as a core primitive — every content type in Strapi supports this. It is one of Strapi's most-used features and a baseline expectation for any CMS.
- `reasoned:` Making `status` a CMS-managed field (not a user-defined enum) prevents the common mistake of defining a `status` field manually and forgetting to filter on it in the public API. The CMS enforces the filter; the developer cannot accidentally skip it.
- `external:` Payload CMS v3 and Contentful both implement draft/publish as a first-class collection property with preview token support. The signed token preview pattern is the standard approach for headless CMS preview integrations with Next.js and similar frameworks.

**Downsides:** Collections with `draftAndPublish: true` double the DB rows for any document that has been published at least once (draft and published versions coexist). Scheduled publishing (publish at a future time) is not covered — requires a cron-based mechanism or a Convex scheduled action, left to a plugin. Multi-step editorial workflows (draft → review → approved → published) are out of scope for the core state machine.

**Confidence:** 92%

**Complexity:** Medium

**Status:** Unexplored — added 2026-05-15

---

### 11. Relations + Auto-Generated SDK Types on Every Schema Change

**Description:** Collections declare relations in the UI-generated schema. Drizzle handles the join tables automatically. The REST API supports `?populate=author,tags`; GraphQL resolves nested types automatically. Critically: **every time the schema changes in the admin UI, the CMS regenerates a typed SDK** — a TypeScript client that mirrors the current database schema and collection definitions. Developers import the SDK into their frontend and get full type safety with zero manual type writing.

```ts
// Auto-generated by CMS on schema change — committed to git, never written manually
// cms/sdk/index.ts

export type Article = {
  id: string
  title: string
  body: string
  status: 'draft' | 'published'
  author: Author           // populated relation
  tags: Tag[]              // populated many-to-many
  thumbnail: MediaFile     // media relation
  createdAt: Date
  updatedAt: Date
}

export type CMSClient = {
  articles: {
    findMany: (params?: QueryParams<Article>) => Promise<PaginatedResponse<Article>>
    findOne:  (id: string, params?: PopulateParams) => Promise<Article>
    create:   (data: CreateInput<Article>) => Promise<Article>
    update:   (id: string, data: UpdateInput<Article>) => Promise<Article>
    delete:   (id: string) => Promise<void>
    publish:  (id: string) => Promise<Article>
  }
  // ... one namespace per collection, typed from schema
}
```

The SDK is generated by the same process that generates the TypeScript collection files — it runs after every UI schema change in dev (alongside the auto-migration) and on every `cms build` in prod. Developers install it locally or import it from a path the CMS exposes. This is the Convex model applied to a SQL CMS: schema change → type regeneration → type errors surface immediately in the frontend.

Relations are defined in the admin UI CT Builder (same UX as Strapi — select relation type, target collection, field name). The CMS generates the Drizzle relation definitions, the join tables, and the SDK types that include the populated shapes.

**Axis:** Schema & content type system + Admin panel & DX

**Basis:**
- `external:` Convex generates TypeScript types on every schema change — the `api` object in `convex/_generated/api.d.ts` is regenerated automatically and immediately reflects schema changes. This is the strongest proof that the pattern works at scale for real-world apps.
- `external:` Payload CMS v3 auto-generates TypeScript types from CollectionConfig — the `payload-types.ts` file mirrors the schema. The innovation here extends this to relations (populated types) and exposes it as a standalone SDK the developer imports.
- `reasoned:` Without auto-generated types, every schema change requires the developer to manually update TypeScript interfaces in their frontend — the most common source of drift between a CMS and its consumers. Auto-generation makes the type system the notification mechanism: a field rename is a compile error in the frontend immediately, not a runtime 400 discovered hours later.

**Downsides:** Generated SDK must handle the difference between a populated relation (full `Author` object) and an unpopulated one (just the `id`) — without careful typing, callers can get runtime surprises when populate is omitted. The SDK generation adds a step to the dev loop that must be fast (< 1 second) to avoid friction; slow codegen breaks the auto-save/auto-migrate flow.

**Confidence:** 89%

**Complexity:** Medium (relation definitions + join tables) / High (SDK type generation for populated vs unpopulated relations)

**Status:** Unexplored — added 2026-05-15 (relations in UI CT Builder; Drizzle join tables; auto-generated typed SDK on schema change)

---

### 12. Content Query API — Strapi-Compatible Filter Syntax + `qs` for Parse/Stringify

**Description:** The public content API exposes a consistent, documented query contract across both REST and GraphQL. REST uses the Strapi-compatible filter syntax — familiar to developers already in the headless CMS ecosystem — parsed and stringified via the `qs` package (the same library Strapi recommends). GraphQL exposes the same operations as typed arguments on query types.

**REST query contract:**
```
GET /api/articles
  ?filters[title][$contains]=hello          // field filter
  ?filters[status][$eq]=published
  ?filters[author][name][$startsWith]=John  // nested relation filter
  ?sort=createdAt:desc,title:asc            // multi-field sort
  ?pagination[pageSize]=20&pagination[page]=1   // offset pagination
  ?pagination[limit]=20&pagination[cursor]=abc  // cursor pagination (edge-preferred)
  ?populate=author,tags                     // relation population
  ?populate[author][fields]=name,avatar     // selective field population
  ?fields=title,status,createdAt            // field selection (reduce payload)
```

`qs` handles the nested bracket syntax for parsing on the server and stringifying on the client. The same `qs` instance is re-exported from the CMS SDK so frontend developers use the same library to build query strings that the CMS parses.

**GraphQL equivalent:**
```graphql
query {
  articles(
    filters: { title: { contains: "hello" }, status: { eq: "published" } }
    sort: ["createdAt:desc"]
    pagination: { limit: 20, cursor: "abc" }
  ) {
    data { id title status author { name avatar } }
    meta { pagination { total cursor } }
  }
}
```

Cursor-based pagination is the preferred default — stateless, edge-compatible, correct under concurrent inserts. Offset pagination is available as a fallback for admin list views where jumping to a specific page is useful.

**Axis:** Admin panel & DX + Schema & content type system

**Basis:**
- `external:` Strapi's filter syntax (`filters[field][operator]=value`) is the established convention in the headless CMS ecosystem. Adopting it means developers familiar with Strapi migrate with zero learning curve. `qs` is the parser Strapi recommends — using the same library on both sides eliminates encoding/decoding edge cases.
- `reasoned:` Cursor-based pagination is the correct choice for edge runtimes — offset pagination requires a `COUNT(*)` query that is expensive on large tables and inconsistent under concurrent writes. Cursor pagination is O(1) for the database and stateless for the server.
- `direct:` The auto-generated SDK (idea #11) re-exports a typed `buildQuery` helper that wraps `qs.stringify` with the collection's field types — so `buildQuery<Article>({ filters: { title: { $contains: 'hello' } } })` is fully type-checked against the generated `Article` type.

**Downsides:** The bracket syntax (`filters[field][operator]`) is not intuitive for developers unfamiliar with Strapi. Full-text search is not covered — filtering handles exact/contains/starts-with but not ranked full-text; that requires a search plugin (Algolia, MeiliSearch, or DB full-text index). Deeply nested relation filters can produce expensive JOIN chains that need query complexity limits to prevent abuse.

**Confidence:** 90%

**Complexity:** Medium

**Status:** Unexplored — added 2026-05-15 (Strapi-compatible syntax; qs for parse/stringify; cursor pagination default; SDK re-exports typed buildQuery)

---

### 13. UI-Managed Webhooks + Static Config for System Hooks

**Description:** Webhooks are managed in two layers. **UI-managed webhooks** are created through the admin panel — a dedicated Webhooks section where operators add URLs, select the events they care about (per entity, per operation), and see delivery logs with retry status. **Static config webhooks** are declared in `createCMS` for system-level and CI/CD pipeline hooks that should not be editable through the UI:

```ts
createCMS({
  ...
  webhooks: [
    // Static — system-level hooks not editable via admin UI
    { url: env.DEPLOY_HOOK_URL,  events: ['schema.change'] },
    { url: env.CACHE_PURGE_URL,  events: ['*.publish', '*.unpublish'] },
  ]
})
```

UI-managed webhooks are stored in the DB (a `webhooks` table, part of the CMS core schema). The admin webhook UI shows: URL, events subscribed, last delivery status, delivery log (last N attempts with HTTP status codes and response times), and a "Test" button that sends a sample payload. Operators can add/remove webhooks without a redeploy.

Event naming follows a consistent pattern: `{collection}.{operation}` — e.g., `articles.create`, `articles.publish`, `articles.delete`. Wildcard patterns: `*.publish` matches publish on any collection. Webhook delivery is stateless HTTP POST with a typed JSON payload and an `X-CMS-Signature` HMAC header for verification. Retry logic (exponential backoff, max 3 attempts) runs via a scheduled job or Convex action depending on the adapter.

**Axis:** Plugin/extension architecture + Admin panel & DX

**Basis:**
- `direct:` Strapi's webhook system is UI-managed — operators add webhook URLs in the admin settings panel. This is the expected UX for non-developer operators who manage integrations (Algolia reindex, Slack notifications, Zapier triggers).
- `reasoned:` Static config webhooks are necessary for the use cases that should not be operator-editable: schema change notifications to a CI/CD pipeline, cache purge hooks tied to the deployment infrastructure. Mixing both in the same `createCMS` config (for static) and admin UI (for dynamic) gives each use case the right management surface.
- `external:` Contentful and Sanity both provide UI-managed webhooks with delivery logs and test buttons as standard features. The HMAC signature verification pattern (`X-Webhook-Signature`) is the standard for webhook authenticity verification.

**Downsides:** UI-managed webhooks require a `webhooks` table in the DB — the CMS core schema grows. Webhook delivery on Cloudflare Workers requires Durable Objects or a queue (Workers AI, Queues) for retry logic since Workers are stateless and can't schedule future work natively. On Node.js, a simple in-memory retry queue works; on edge, the retry mechanism is adapter-dependent.

**Confidence:** 88%

**Complexity:** Medium (webhook delivery + logs) / High (reliable retry on edge runtimes)

**Status:** Unexplored — added 2026-05-15 (UI-managed for operators; static config for system/pipeline; delivery logs and test button in admin)

---

### 14. `createCMS` Returns a Hono App + Exposed Internals (`cms.fetch`, `cms.auth`, `cms.db`)

**Description:** `createCMS` returns the Hono app itself extended with the internal instances the developer may need to access directly. The return type is `Hono & { auth: BetterAuth; db: DrizzleInstance }` — implemented via `Object.assign(app, { auth, db })`. All native Hono methods are available unchanged (`fetch`, `use`, `route`, `all`, etc.), plus `cms.auth` and `cms.db` for operations outside the generated CMS routes.

```ts
// lib/cms.ts
export const cms = createCMS({ db, storage, cache, auth, graphql: true })
// typeof cms = Hono & { auth: BetterAuth; db: DrizzleInstance }
```

`cms.fetch` is Hono's native fetch — signature `(req: Request, env, ctx) => Promise<Response>` — and is WinterTC-compliant. Every framework that follows the WinterTC standard mounts it directly:

```ts
// Cloudflare Worker — cms IS the export
export default cms                    // Workers calls cms.fetch automatically

// Elysia — .mount() accepts any WinterTC fetch function directly
new Elysia()
  .get('/', () => 'my app')
  .mount('/cms', cms.fetch)           // Elysia docs: mount(path, fetchFn)
  .listen(3000)

// Hono — embed CMS inside an existing Hono app
app.all('/cms/*', (c) => cms.fetch(c.req.raw))

// Next.js App Router — catch-all route
// app/api/cms/[...handler]/route.ts
const handler = (req: Request) => cms.fetch(req)
export { handler as GET, handler as POST, handler as PUT,
         handler as PATCH, handler as DELETE, handler as OPTIONS, handler as HEAD }

// Node.js standalone
import { serve } from '@hono/node-server'
serve({ fetch: cms.fetch, port: 3000 })
```

Because `cms` is a real Hono instance, the developer can extend it after creation:
```ts
cms.use('/api/*', myRateLimitMiddleware)  // add middleware on top
cms.route('/custom', myExtraRoutes)       // add routes alongside CMS routes
```

And access internals directly:
```ts
// Custom route that needs the better-auth session
app.get('/me', async (c) => {
  const session = await cms.auth.api.getSession({ headers: c.req.raw.headers })
  return c.json(session?.user)
})

// Custom query outside the CMS API
const latest = await cms.db.query.articles.findFirst({ orderBy: desc(articles.createdAt) })
```

The CLI (`cms dev`, `cms schema plan/apply/check`, `cms deploy`) handles schema management and optional standalone startup. It is not required when the host framework owns the server lifecycle — `cms.fetch` is the only integration point needed.

**Axis:** Deployment portability

**Basis:**
- `external:` Hono's `.fetch` is `(req: Request, env, ctx) => Promise<Response>` — the WinterTC-compliant interface. Elysia's `.mount(path, fetchFn)` accepts exactly this signature. `Object.assign(app, { auth, db })` is the standard pattern for attaching typed properties to a Hono instance without subclassing.
- `direct:` User provided working integration patterns for Next.js, Hono, and Elysia — all confirmed using `cms.fetch` as the mounting point.
- `reasoned:` Returning the Hono app itself (not a wrapper object containing it) means the developer never has to type `cms.app.use(...)` or `cms.app.route(...)` — the CMS instance IS the app, composable at zero ceremony. `cms.auth` and `cms.db` are attached properties, not a separate API surface.

**Rationale:** Most production apps embed the CMS rather than running it standalone — same deployment, shared auth context, no CORS. The `Object.assign` return makes embedding two lines regardless of framework. Exposing `cms.auth` and `cms.db` directly means the developer isn't locked into the CMS-generated routes — they can write custom Hono handlers that use the same DB connection and auth session the CMS uses internally.

**Downsides:** `Object.assign(app, { auth, db })` requires TypeScript to be told the return type explicitly — the inference doesn't propagate automatically. Embedding at a sub-path means the admin URL is `example.com/cms/admin`, not a standalone domain; teams wanting an isolated admin need a separate deployment. The host framework's middleware runs before CMS routes, which can interact with CMS auth if both validate the same `Authorization` header.

**Confidence:** 93%

**Complexity:** Low

**Status:** Unexplored — refined 2026-05-15 (returns Hono app via Object.assign + auth + db; cms.fetch is the WinterTC mount point; Elysia, Hono, Next.js, Workers patterns documented)

---

### 15. Cache Layer — Upstash Redis (Edge-Compatible HTTP Redis) as First-Class Config

**Description:** A `cache` config key in `createCMS` follows the same provider pattern as `db` and `storage`. The CMS uses the cache internally for session caching, content response caching, rate limiting, preview token storage, and webhook retry state — the developer never calls Redis directly for these concerns.

```ts
createCMS({
  db:      { provider: 'sqlite',   options: { url: env.DATABASE_URL } },
  storage: { provider: 'r2',       binding: env.BUCKET },
  cache:   { provider: 'upstash',  url: env.UPSTASH_REDIS_REST_URL,
                                   token: env.UPSTASH_REDIS_REST_TOKEN },
  //        { provider: 'kv',      binding: env.KV }    // Cloudflare KV (reads only)
  //        { provider: 'memory' }                       // dev / Node.js (in-process, non-distributed)
  auth:    { plugins: [organization(), apiKey(), twoFactor()] },
  graphql: true,
})
```

Internally `createCMS` uses `@upstash/redis/cloudflare` — `Redis.fromEnv(env)` reads `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from the env automatically. All operations go over `fetch` (HTTP REST), no TCP — edge-compatible by design. As of 2026, Upstash routes read requests to the replica colocated with the Worker's PoP for sub-10ms reads.

**What the CMS uses the cache for internally:**

| Concern | Cache usage |
|---|---|
| **Session caching** | Hash the `Authorization` token → cache the better-auth session object with a short TTL (30s–60s). Eliminates a DB hit on every authenticated request. |
| **Content response cache** | Cache REST/GraphQL responses for `public`-permissioned collections with configurable TTL. Invalidated automatically on `create`, `update`, `delete`, `publish`. |
| **Rate limiting** | `@upstash/ratelimit` provides distributed rate limiting across all Worker instances — single Redis atomic operation, consistent across PoPs. Applied to content mutation endpoints. |
| **Preview tokens** | Draft preview tokens (idea #10) stored as Redis keys with TTL (e.g., 1 hour). Expiry is automatic — no cron job needed to clean up expired tokens. |
| **Webhook retry state** | Failed webhook deliveries store retry count + next-attempt timestamp in Redis. Background process (Workers Cron Trigger or Convex scheduler) polls and retries. |

The `memory` provider is the default for local dev — in-process, no external service needed. On Node.js without a Redis instance, `memory` works correctly for a single-process deployment. For distributed Node.js (multiple instances), `upstash` or a self-hosted Redis provider is required for session cache consistency.

**Axis:** Deployment portability + Database abstraction

**Basis:**
- `external:` Upstash Redis is confirmed working on Cloudflare Workers via `@upstash/redis/cloudflare` — official Cloudflare Workers integration documentation. HTTP-only, no TCP, sub-10ms reads from colocated replicas in 2026.
- `external:` `@upstash/ratelimit` implements distributed rate limiting using Redis atomic operations — works identically across Worker instances globally, which is impossible with in-memory rate limiting.
- `reasoned:` Session caching is the highest-leverage cache use for a CMS: better-auth's `getSession` hits the DB on every authenticated request. Caching the session object for 30–60 seconds reduces DB load proportionally to request rate. For a CMS with 100 req/s, this eliminates ~5,000–6,000 DB reads per minute for no loss in correctness (30s stale session is acceptable for content management).
- `reasoned:` Preview tokens need TTL-based expiry that is atomic and consistent. Redis TTL is the canonical solution — no cron job, no cleanup query, no expired-token accumulation in the DB.

**Downsides:** Upstash adds an external service dependency and additional env vars. Cache invalidation on content mutations must be correct — a bug that fails to invalidate the content cache after a publish produces stale public content, a critical correctness issue. The `memory` provider does not share state across processes, so it must be clearly documented as dev-only. KV (Cloudflare KV) has eventual consistency — suitable for content caching but not for session caching or rate limiting where consistency matters.

**Confidence:** 85%

**Complexity:** Low (config + internal wiring) / Medium (cache invalidation correctness on content mutations)

**Status:** Unexplored — added 2026-05-15 (Upstash HTTP Redis, edge-compatible; session cache, content cache, rate limiting, preview tokens, webhook retry state)

---

### 16. Email Provider — Adapter for Auth Flows and CMS Notifications

**Description:** better-auth requires an email provider for magic links, OTP, email verification, and password reset. Without one those auth flows silently fail. A `email` config key follows the same provider pattern as `db`, `storage`, and `cache` — `createCMS` creates the email client internally and passes it to better-auth and to any CMS notification (e.g., webhook delivery failure alert).

```ts
createCMS({
  email: { provider: 'resend',   apiKey: env.RESEND_API_KEY },
  //      { provider: 'postmark', token: env.POSTMARK_TOKEN }
  //      { provider: 'smtp',     host, port, user, pass }
  //      { provider: 'console' }  // dev — logs email content to stdout, no sending
  ...
})
```

`console` is the default when no `email` key is provided — auth flows that require email log the email content to stdout in dev instead of failing, so the developer can copy magic link URLs from the terminal without configuring a real provider.

**Axis:** Deployment portability + Admin panel & DX

**Basis:**
- `direct:` better-auth's magic link, email OTP, and email verification plugins all require an email sender. Omitting it breaks those auth flows silently — the user submits the form and nothing happens.
- `external:` Resend is the standard transactional email provider for edge/serverless TypeScript projects in 2026 — HTTP API, no SMTP TCP connection, works on Cloudflare Workers natively.
- `reasoned:` The `console` provider for dev removes the "configure email just to test auth" friction — the #1 reason developers skip email verification locally and then forget to enable it in production.

**Downsides:** Email deliverability is an external concern (SPF, DKIM, domain reputation) the CMS cannot manage. Custom email templates (branded magic link emails) need an extension point — the provider config needs an optional `templates` key for each email type.

**Confidence:** 93%

**Complexity:** Low

**Status:** Unexplored — added 2026-05-15

---

### 17. Background Jobs (Crons) — QStash as Universal Default, Vercel Built-In

**Description:** Three already-designed features need a job execution mechanism: webhook retry (#13), scheduled publishing (#10), and cache invalidation sweeps (#15). A `crons` config key handles this. Crons work by hitting CMS-internal HTTP endpoints — the CMS exposes job handler routes (`POST /cms/jobs/webhook-retry`, `POST /cms/jobs/scheduled-publish`, `POST /cms/jobs/cache-sweep`) that the cron provider calls on schedule. Because these are standard HTTP endpoints served by `cms.fetch`, they work without any runtime-specific code in the CMS core.

```ts
createCMS({
  crons: { provider: 'qstash', token: env.QSTASH_TOKEN },
  //      { provider: 'vercel' }      // no token — Vercel Cron is same-deployment, hits /cms/jobs/* routes
  //      { provider: 'cloudflare' }  // uses Wrangler cron triggers → Worker scheduled export
  //      { provider: 'none' }        // disable background jobs (dev/simple deployments)
  ...
})
```

**QStash is the universal default** — it is an HTTP message queue (Upstash) that works on all runtimes by sending authenticated POST requests to your endpoints. No TCP, no persistent connection, compatible with Cloudflare Workers, Vercel Edge, Node.js, and Elysia. When a webhook delivery fails, the CMS enqueues a retry task to QStash with a delay; QStash calls `POST /cms/jobs/webhook-retry` at the right time.

**Vercel** built-in cron does not need a separate provider or token — it hits the same `/cms/jobs/*` endpoints from within the same deployment, configured via `vercel.json`. **Cloudflare** uses Cron Triggers which invoke the Worker's `scheduled` export rather than an HTTP endpoint — the CMS exposes a `cms.scheduled` export for this case alongside `cms.fetch`.

**Axis:** Deployment portability + Plugin/extension architecture

**Basis:**
- `direct:` Webhook retry (#13) and scheduled publishing (#10) were designed without specifying how retries or timers fire on edge. This fills that gap.
- `external:` QStash (Upstash) is the standard HTTP queue for edge runtimes — same HTTP-over-fetch pattern as Upstash Redis. Vercel Cron and Cloudflare Cron Triggers both work by calling HTTP endpoints — the CMS job routes are those endpoints.
- `reasoned:` Exposing job execution as HTTP endpoints (not a Worker-specific `scheduled` export) means the job handler logic lives in the CMS core once. Runtime-specific entry points (`cms.scheduled` for Cloudflare, route handlers for QStash/Vercel) are thin shims that call the same underlying handler.

**Downsides:** QStash adds another Upstash service alongside Redis — two Upstash accounts or one account managing both. Job endpoint security (ensuring only the cron provider can call `/cms/jobs/*`) requires signature verification per provider — QStash signs requests with HMAC, Vercel with a shared secret, Cloudflare with its own mechanism.

**Confidence:** 88%

**Complexity:** Medium

**Status:** Unexplored — added 2026-05-15 (QStash universal default; Vercel built-in; crons hit /cms/jobs/* HTTP endpoints; cms.scheduled for Cloudflare)

---

### 18. OpenAPI Spec + Scalar API Docs — Auto-Generated from Schema

**Description:** The CMS auto-generates an OpenAPI 3.1 spec from the collection definitions and serves it at `GET /cms/openapi.json`. A **Scalar** UI (not Swagger) is served at `GET /cms/docs` — Scalar is the modern, visually polished API reference used by Hono, Elysia, and other modern frameworks. better-auth's OpenAPI plugin covers auth endpoints (`/api/auth/*`); the CMS extends the same spec with all content API routes, query parameters (filters, sort, pagination, populate), and field schemas derived from the collection Zod definitions.

```ts
createCMS({
  openapi: true,
  // or: { path: '/openapi.json', docs: '/docs', title: 'My CMS API' }
  ...
})
```

The spec is the same source of truth used for SDK generation (idea #11 typed SDK), GraphQL schema introspection, and Postman/Insomnia import. Non-TypeScript consumers (mobile apps, Python scripts, third-party integrations) use the spec to understand the API without reading the CMS source code.

**Axis:** Admin panel & DX

**Basis:**
- `external:` Scalar is the API documentation UI used by Hono's official docs, ElysiaJS, and Nitro — it renders faster than Swagger UI, is dark-mode by default, has better mobile support, and supports OpenAPI 3.1 natively. Swagger UI is visually dated and slow on large specs.
- `external:` better-auth ships an OpenAPI plugin that auto-documents its endpoints. The CMS REST routes need the same treatment — generated from the Zod schemas in collection definitions via `zod-to-openapi` or equivalent.
- `reasoned:` The OpenAPI spec is the bridge between the TypeScript-first CMS and every non-TypeScript consumer. Without it, mobile developers building on top of the CMS have no documentation and must infer the API from trial and error.

**Downsides:** Keeping the spec accurate for complex query parameters (nested `filters[author][name][$startsWith]`) requires careful mapping from the `qs` filter schema to OpenAPI parameter definitions — this is non-trivial. The spec grows large for CMS instances with many collections; Scalar handles large specs well but initial load time increases.

**Confidence:** 89%

**Complexity:** Medium

**Status:** Unexplored — added 2026-05-15 (OpenAPI 3.1 auto-generated from schema; Scalar UI at /cms/docs; integrates better-auth OpenAPI plugin)

---

### 19. AI-Powered i18n — Translation via AI SDK, Any Provider or Vercel AI Gateway

**Description:** Localization is opt-in per collection and translation is AI-powered. The `i18n` config at the CMS level declares supported locales and the AI provider to use for translation. When an editor saves content in the default locale, the CMS can auto-translate to all configured locales using the AI SDK — the translation is stored as a draft locale variant that editors can review and refine.

```ts
createCMS({
  i18n: {
    locales: ['en', 'es', 'fr', 'de'],
    default: 'en',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',         // fast + cheap for translation tasks
    // or via Vercel AI Gateway (provider-agnostic routing):
    // provider: 'gateway', model: 'anthropic/claude-haiku-4-5'
    // provider: 'openai',  model: 'gpt-4o-mini'
  },
  ...
})
```

Collection opt-in:
```ts
defineCollection({
  name: 'articles',
  localization: true,   // enables locale variants for this collection
  fields: { ... }
})
```

The query API gains `?locale=es` — returns the Spanish locale variant if it exists, falls back to the default locale if not. The admin CT Builder gains a locale switcher on every content form. The AI translation runs as a background job (idea #17) — not blocking the save operation. Locale management (add/remove supported locales, bulk re-translate after locale addition) is exposed in the admin settings.

Drizzle stores locale as a column on the content table — same pattern as `status` for draft/publish. The SDK auto-generated types (idea #11) include locale-aware query params.

**Axis:** Schema & content type system + Admin panel & DX

**Basis:**
- `external:` The Vercel AI SDK abstracts any LLM provider behind a uniform interface — `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/mistral` etc. are interchangeable. Vercel AI Gateway adds provider-agnostic routing with caching, rate limiting, and cost tracking on top.
- `reasoned:` Manual translation workflows in a CMS (export JSON → send to translator → import back) are slow and error-prone. AI translation as a first-class CMS feature — where the AI draft is immediately available and editors refine rather than translate from scratch — cuts localization time by 60–80% for typical CMS content (blog posts, product descriptions, marketing copy).
- `reasoned:` Using `claude-haiku-4-5` (or `gpt-4o-mini`) for translation keeps per-document translation cost under $0.01 for typical article length. For a CMS targeting small projects, this is negligible — and it ships a capability that enterprise CMSes charge thousands for.

**Downsides:** AI translation quality varies by language pair, domain, and model. Technical, legal, or brand-specific content requires human review regardless of AI quality — the CMS should mark AI-translated content with a `translatedBy: 'ai'` flag visible in the admin. Translation runs as a background job — the locale variant is not immediately available after save; editors see a "translating..." state. Cost is external to the CMS — unexpected high content volume can generate unexpected AI API costs.

**Confidence:** 82%

**Complexity:** Medium (locale data model + query API) / Low (AI SDK integration — the SDK handles the provider abstraction)

**Status:** Unexplored — added 2026-05-15 (AI SDK powered; any provider or Vercel AI Gateway; auto-translate on save as background job; human-refinable draft locale variants)

---

### 20. Health Check Endpoint

**Description:** `GET /cms/health` returns a JSON status object with the connectivity state of every configured CMS subsystem. Responds `200 OK` when all systems are reachable, `503 Service Unavailable` when any critical subsystem is degraded. Required for load balancers, Kubernetes liveness/readiness probes, uptime monitors (Better Uptime, Checkly), and deployment readiness gates.

```json
// GET /cms/health → 200 OK
{
  "status": "ok",
  "db":      { "status": "ok",      "latency_ms": 3 },
  "storage": { "status": "ok",      "latency_ms": 12 },
  "cache":   { "status": "ok",      "latency_ms": 8 },
  "email":   { "status": "ok" },
  "crons":   { "status": "ok" }
}

// GET /cms/health → 503 Service Unavailable
{
  "status": "degraded",
  "db":      { "status": "error", "error": "connection timeout" },
  "storage": { "status": "ok",    "latency_ms": 12 },
  ...
}
```

Always enabled — no config required. The endpoint is unauthenticated (no session required) but does not expose sensitive connection details in the error messages.

**Axis:** Deployment portability

**Basis:**
- `reasoned:` Health checks are the first thing needed after first deployment and the last thing implemented. Every load balancer, every platform (Fly.io, Railway, Render, Kubernetes) checks a health endpoint before routing traffic. Without it, a misconfigured DB connection produces silent 500s rather than a clear "this instance is unhealthy" signal.
- `external:` The `{ status, latency_ms }` shape per subsystem is the de-facto health check response format used by frameworks like Fastify (`@fastify/under-pressure`), NestJS (`@nestjs/terminus`), and Rails (`health_check` gem).

**Downsides:** Running connectivity checks on every health poll adds DB + cache + storage round-trips at the health check interval — if the health endpoint is polled every 5 seconds by a load balancer, this is 12 extra DB pings per minute. A lightweight version that only checks the last-known state (rather than making a live round-trip) is preferable for high-frequency polling.

**Confidence:** 95%

**Complexity:** Low

**Status:** Unexplored — added 2026-05-15

---

### 21. Audit Log — Core Feature, Not Enterprise-Gated

**Description:** Every content mutation (`create`, `update`, `delete`, `publish`, `unpublish`) writes a row to an `audit_log` table in the same DB as content. Strapi gates this behind enterprise pricing — for the new CMS it is a core, always-on feature. The audit log is powered by the same event system as webhooks (idea #13): the events that trigger webhook delivery also write audit log entries, sharing the implementation.

```ts
// audit_log table (part of CMS core schema, managed by cms schema plan/apply)
{
  id:           string
  userId:       string           // from better-auth session
  userEmail:    string           // denormalized for readability after user deletion
  collection:   string           // 'articles'
  documentId:   string
  operation:    'create' | 'update' | 'delete' | 'publish' | 'unpublish'
  diff:         json             // { before: {...}, after: {...} } — field-level changes
  timestamp:    Date
  ipAddress:    string           // from request context
}
```

Viewable in the admin under Settings → Audit Log — filterable by user, collection, operation, and date range. Exportable as CSV or JSON via `GET /cms/audit-log?format=csv`. Retention configurable: entries older than N days deleted via a cron job (idea #17).

**Axis:** Plugin/extension architecture + Admin panel & DX

**Basis:**
- `direct:` Strapi's audit log is enterprise-only — one of the most-requested features to be open in community discussions. Making it core rather than enterprise-gated is a direct competitive differentiator.
- `reasoned:` The `diff` field (before/after field values) is what makes an audit log useful rather than just a change count. Computing the diff at write time (before the mutation completes) is cheap; reconstructing it later from snapshots is expensive. The CMS middleware that applies schema-level RBAC (#8) is already in the request path — the audit log write happens in the same middleware layer after a successful mutation.
- `external:` The `{ userId, collection, documentId, operation, diff, timestamp }` schema is the industry standard for content audit trails — used by Contentful's Activity API, Sanity's history API, and WordPress's revision system.

**Downsides:** The `diff` JSON column grows large for documents with many fields or rich text bodies — storing full before/after snapshots per mutation can exhaust DB storage on high-write collections. A configurable field exclusion list (e.g., exclude `body` from diff for storage efficiency) is needed. Audit log writes are synchronous in the request path — a slow DB write adds latency to every content mutation.

**Confidence:** 87%

**Complexity:** Low (schema + middleware hook) / Medium (diff computation for nested relations)

**Status:** Unexplored — added 2026-05-15 (core, not enterprise-gated; powered by webhook event system; diff stored per mutation; admin viewer + CSV export)

---

### 22. Content Seeding — DX Nice-to-Have (NTH, Not v1 Priority)

**Description:** `cms seed` CLI command populates the DB with fixture data. A `seeds/` folder convention — each file exports a typed function using the CMS SDK. `cms dev` auto-runs seeding if the DB is empty on first start.

```ts
// seeds/articles.ts — written by developer, uses generated SDK types
import { cms } from '../lib/cms'
export async function seed() {
  await cms.db.insert(articles).values([
    { title: 'Hello World', body: '...', status: 'published' },
  ])
}
```

Not blocking for v1. Significantly improves first-run DX for demo projects and starter templates.

**Axis:** Admin panel & DX

**Basis:** `reasoned:` Empty databases on first `cms dev` require manual content creation before the frontend renders anything useful. Seeds eliminate this — the developer sees working content immediately.

**Confidence:** 80%

**Complexity:** Low

**Status:** Unexplored — NTH, not v1 priority. Added 2026-05-15

---

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | CQRS Read/Write Worker split | Scope overrun — adds operational complexity (two deployment artifacts, shared schema type package) that conflicts with "simple for small projects"; premature for v1 |
| 2 | $0 free-tier documentation | Below ambition floor — this is a marketing/documentation decision, not an architectural idea |
| 3 | Discriminated union content types | Better explored in brainstorm as a schema design detail; doesn't affect foundational architectural decisions |
| 4 | Drizzle edge-replica query router | Premature optimization; valuable roadmap item after core is built |
| 5 | Ejectable CMS scaffold | Interesting differentiation but below architectural ideation floor; better as v2 roadmap feature |
| 6 | eBPF-style sandboxed hooks | Over-engineered for stated use case; conflicts with "less expensive, simpler" positioning |
| 7 | CAN bus storage arbitration | Creative analogy but no concrete direction beyond the Typed Adapter idea (DB1); weaker expression of the same concept |
| 8 | Mechanical tolerance stackup migrations | Analogy is precise but translates to behavior covered by `cms schema check --assert-clean` in S1 |
| 9 | OSI session layer for edge edits | Valid edge-specific concern but derivative; addressed by the stateless-first design principle |
| 10 | Hermetic Nix derivations | Conceptually elegant but adds hash-addressed tooling complexity that conflicts with "simple for small projects" |
| 11 | DNS delegation zones for RBAC | Too specialized; better as a v2 multi-tenant plugin |
| 12 | OpenTelemetry semantic content events | Good v2 plugin interface design, not a core architectural decision for v1 |
| 13 | ICC color profile rendering manifest | Premature — requires stable schema IR first; the Hono RPC approach (A1) covers the schema-drives-UI requirement with less tooling investment |
| 14 | Priority-arbitrated storage bus | Merged into Typed Adapter (DB1) which expresses the same isolation goal with simpler semantics |
| 15 | ABI-first plugin design | Merged into Plugin = Hono (P2) — the `(app: Hono) => Hono` TypeScript type IS the ABI; designing it before any plugins exist is implied |
| 16 | Stateless webhook-first content events | Merged into Plugin = Hono (P2) — stateless eventing is the natural consequence of banning `initialize()` from the plugin type; webhooks are an adapter-level concern |
| 19 | Zero-Auth CMS (JWKS-only) | Superseded by idea #6 (better-auth) — better-auth covers Hono + Drizzle + Convex natively, provides a full plugin ecosystem, and keeps auth schema in the same migration journal as content schema |
| 17 | TypeScript schema → versioned IR → multi-target compilation | Architecturally sound (LLVM analogy) but High complexity and premature for v1; the simpler S1 approach (TypeScript objects → Drizzle + Hono RPC) captures 80% of the benefit at 20% of the build cost; revisit when multiple non-SQL adapters need to share schema semantics |
| 18 | BYO table / adapter over existing DB | Merits further exploration but deprioritized — the brownfield adoption story is valid, but leads to a different product (an API generation layer like PostgREST) rather than the IaC CMS the user wants to build |
