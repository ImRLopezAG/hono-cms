---
title: "feat: CLI Tooling — cms dev, schema plan/apply/check, init, deploy"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#7 Schema-Driven Infrastructure Provisioning", "#3 UI-Generated Schema"]
---

# Plan 011: CLI Tooling — `@hono-cms/cli`

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, architecture review

### Key Improvements

1. Position the CLI as the operational contract for generated artifacts and migration safety.
2. Add dry-run, machine-readable output, and workspace-doctor expectations.
3. Clarify that schema compilation/planning should be shared engine logic, not duplicated paths.

**Sequence:** 011 of 018  
**Estimated effort:** 3–5 days  
**Blocking:** Depends on Plans 001 (monorepo foundation), 002 (core library), and the schema package (Plan covering `@hono-cms/schema`). The `cms schema` command group depends on `cmsSchemaService` from `@hono-cms/schema`. The `cms dev` command depends on `@hono-cms/core` being importable. The `cms schema generate` command depends on the SDK generator (Plan 017).

---

## Summary

This plan covers `packages/cli/` → `@hono-cms/cli`: the `cms` CLI binary that is the primary developer interface for the entire CMS lifecycle. The CLI is the operational glue between the schema package (which computes migrations), the core package (which runs the server), and the developer's project. It handles dev-time hot-reload, production schema migration, CI drift detection, onboarding (init wizard), and v1.1+ infrastructure scaffolding (deploy).

The v1 surface area priorities in order:
1. **Schema management** (`plan`, `apply`, `check`, `generate`) — the IaC discipline that makes the CMS safe in production
2. **Dev server** (`dev`) — the primary day-to-day DX surface
3. **Init wizard** (`init`) — onboarding and first-run experience
4. **Deploy scaffolding** (`deploy`) — template generation only in v1; full IaC provisioning deferred to v1.1+

---

## Problem Frame

A CMS without a CLI forces developers to wire schema migrations by hand, manage dev server restarts manually, and guess at deployment configuration. Strapi's CT Builder locks schema changes to dev mode with no safe production promotion path. The `@hono-cms/cli` exists to close this gap: it is the command-line face of the IaC promise, making schema changes reviewable, migration files auditable, and dev experience seamless.

The CLI is not the runtime — it is the toolchain. At runtime, the CMS is a Hono app (`cms.fetch`). The CLI manages everything that surrounds that runtime: building it, migrating its database, seeding it, and scaffolding its infrastructure. The CLI imports from `@hono-cms/core`, `@hono-cms/schema`, and the adapters, but the reverse is never true — the CMS runtime has no dependency on the CLI package.

---

## Scope Boundaries

### In Scope (v1)

- Package scaffolding: `package.json`, `tsdown.config.ts`, `vitest.config.ts`, `tsconfig.json`, CLI entry point
- `cms schema plan` — human-readable migration plan, color-coded, `--json` flag
- `cms schema apply` — confirmation flow, destructive guard, migration file write
- `cms schema check --assert-clean` — CI gate, exit codes, `--format=json`
- `cms schema generate` — SDK type regeneration
- `cms dev` — dev server with hot reload, auto-migration, admin proxy
- `cms init` — interactive setup wizard with `@clack/prompts`
- `cms deploy --target=<cloudflare|vercel|node>` — template output to stdout (v1: print only, no provisioning)
- `cms build` — production build (compile collections, generate SDK types)
- `cms seed` — run `seeds/` folder if it exists
- `cms info` — print current schema, adapter, provider info

### Deferred to Follow-Up Work

- `cms deploy` automated provisioning — calling Wrangler/Vercel/Docker APIs (v1.1+, see U8 for full rationale)
- Plugin marketplace / `cms add <plugin>` command
- Multi-project / multi-environment workspace config
- `cms migrate rollback` — schema migration rollback (v1.1+)
- `cms export` / `cms import` — content data portability commands

### Outside This Product's Identity

- Replacing `turbo run build` or Bun-level build orchestration — the CLI wraps `tsdown`, it does not re-implement the monorepo build system
- Being a CMS admin UI (that is the `apps/admin` SPA)

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Make destructive or deployment-affecting commands dry-run first and provide JSON output for CI/editor integration.
- Use the CLI as the canonical freshness check for generated schema, SDK, and OpenAPI artifacts.
- Keep schema compilation and migration planning in a shared engine consumed by both runtime and CLI paths.

**Performance Considerations:**
- Skip rewrites when generated output hashes are unchanged to avoid unnecessary downstream rebuilds.
- Prefer targeted workspace operations over whole-repo recomputation where possible.

**Edge Cases:**
- Add a `doctor`-style validation path for env vars, provider config, public URLs, and workspace drift.
- Fail loudly when generated artifacts are stale or missing instead of silently rebuilding partial outputs in surprising contexts.

### 1. CLI Framework: citty (chosen over CAC and commander)

Three candidates evaluated:

| Criterion | citty (unjs) | CAC | commander |
|---|---|---|---|
| TypeScript native | Yes — written in TS, types included | Yes, but requires `@types/cac` | Yes, but TS types are afterthought-quality |
| Sub-command support | First-class via `defineCommand` + sub-commands map | First-class | First-class |
| Unjs ecosystem fit | Direct — unjs also authors `ofetch`, `consola`, `pathe`, `mlly` | No | No |
| Bundle size | ~4 KB gzipped | ~8 KB | ~45 KB |
| Async command handlers | Yes | Yes | Yes (since v8) |
| Active maintenance | Active (2026) | Sporadic | Active |
| Argument/option inference | Typed `args` and `rawArgs` per command | Manual | Manual |

**Decision: citty.** The unjs ecosystem coherence is decisive — this CLI will also use `consola` (unjs) for colored terminal output, `ofetch` (unjs) for any HTTP calls, `pathe` (unjs) for cross-platform path handling, and `mlly` (unjs) for ESM-aware dynamic imports of `cms.config.ts`. Using citty means all of these packages share the same author, release cadence, and ESM-first philosophy. commander is eliminated by bundle size and the fact that its TypeScript types require a separate package. CAC is eliminated by maintenance concern and the lack of unjs ecosystem fit.

**Command registration pattern** with citty:

Every sub-command is a `defineCommand(...)` call exported from its own file. The root `src/index.ts` assembles the command tree via `createMain` and invokes `runMain`. Commands nested under `schema` use a sub-command map. This pattern keeps each command file independently testable — the handler function is exported separately from the command definition so tests can call it directly without going through `runMain`.

```
// directional sketch — not implementation specification
packages/cli/src/
  index.ts                  ← runMain(createMain({ ... }))
  commands/
    dev.ts                  ← defineCommand({ handler: devHandler })
    build.ts
    init.ts
    info.ts
    seed.ts
    deploy/
      index.ts              ← defineCommand({ subCommands: { cloudflare, vercel, node } })
      cloudflare.ts
      vercel.ts
      node.ts
    schema/
      index.ts              ← defineCommand({ subCommands: { plan, apply, check, generate } })
      plan.ts
      apply.ts
      check.ts
      generate.ts
  lib/
    config-loader.ts        ← loadCMSConfig() — resolves + dynamically imports cms.config.ts
    db-client.ts            ← createDBFromConfig() — instantiates adapter for CLI use
    lock.ts                 ← acquireLock() / releaseLock() — .cms-schema.lock
    formatter.ts            ← formatSchemaPlan() — colors, tables, human output
    admin-proxy.ts          ← proxyToVite() — proxy admin SPA requests
```

### 2. Loading `cms.config.ts` at CLI Runtime

The CLI runs as a compiled ESM binary. It must dynamically import the developer's `cms.config.ts` (TypeScript, not pre-compiled) at runtime. The approach:

1. **Locate the config file:** Search `process.cwd()` for `cms.config.ts`, then `cms.config.js`, then a file exporting `createCMS(...)` (via heuristic). `pathe.resolve` handles cross-platform path normalization.
2. **Register TypeScript resolution:** The CLI ships with `tsx` as a peer dependency (or `@oxc-node/core` in 2026) for on-the-fly TypeScript execution. The CLI spawns itself with `tsx` or registers `tsx/esm` as a loader hook before the dynamic import.
3. **Dynamic import:** `const mod = await import(configFilePath)` — uses the native ESM dynamic import. The `mlly` package handles edge cases: cache-busting on file change (file watcher), resolution of `@hono-cms/core` workspace imports within the user's project.
4. **Extract the CMS instance:** The loaded module is expected to export `default` as the result of `createCMS(...)`. The CLI validates the shape: it must be a Hono instance with `auth` and `db` attached (i.e., `typeof cms.db !== 'undefined'`). If the validation fails, the CLI prints a clear diagnostic and exits 1.
5. **Cache-busting in dev mode:** When the file watcher detects a change to `cms.config.ts`, the CLI invalidates the import cache (via `mlly.clearImportCache`) and re-imports. This avoids requiring a full restart for config changes.

**Why not require the developer to compile first?** Requiring `bun run build` before `cms schema plan` would break the workflow for the most common case: the developer just edited a collection file and wants to see the migration plan. The CLI must be able to consume raw TypeScript source directly.

**Why not bundle the config into the CLI?** The config file is user code in the developer's project — it is not part of `@hono-cms/cli`. The CLI is installed globally or as a devDependency; the config file lives in the project. Dynamic import at runtime is the only way to consume user code without baking it into the binary.

### 3. How the CLI Accesses the Database (No Running Server)

`cms schema plan`, `cms schema apply`, and `cms schema check` all need a live DB connection to compare the schema definition against the current DB state. The CLI does not start a full Hono server to do this. Instead:

1. The CLI calls `loadCMSConfig()` to get the `cms` instance (which has `cms.db` attached via `Object.assign`).
2. It calls `createDBFromConfig(config.db)` — a small utility in `packages/cli/src/lib/db-client.ts` that instantiates the same Drizzle adapter the core uses, but without the full Hono app. This is a direct call to the adapter factory function (e.g., `createD1Adapter`, `createPostgresAdapter`) with the same config object.
3. The resulting `db` is passed directly to `cmsSchemaService.plan(collections, db)` from `@hono-cms/schema`.
4. The DB connection is closed (or the adapter cleaned up) before the CLI process exits.

**Why re-instantiate the adapter instead of using `cms.db`?** The `cms.db` returned by `createCMS` is wired to the full Hono context (env bindings, Cloudflare `ExecutionContext`). For Cloudflare D1, the `db` binding requires `c.env.DB` from a Worker's environment — which does not exist at CLI time on a developer's machine. The CLI utility adapter (`createDBFromConfig`) uses a local SQLite file or a direct Postgres TCP connection that does not require the Worker env. For this reason, the CLI's `--db` option (or the local dev DB URL in `.env`) is the target for schema operations, not the production D1 binding.

### 4. Why `cms deploy` is v1.1+ (Not v1)

The schema management and dev server commands are the highest-leverage features that unblock the core promise. Deploy automation has three distinct risks that make it unsuitable for v1:

- **Provider API volatility:** Wrangler configuration format, Vercel project APIs, and D1 provisioning APIs are all still evolving rapidly. A v1 integration would require immediate maintenance when these APIs change.
- **Credential surface:** Automated deploy requires the CLI to hold cloud provider API tokens. Getting the credential storage, scoping, and revocation model right is non-trivial and security-sensitive.
- **Iteration order:** The IaC deploy promise (schema drives infrastructure) is only as valuable as the schema system it reads from. Shipping deploy automation before the schema system is proven in production means debugging two new systems simultaneously.

The ideation document gives this idea 73% confidence — the lowest of the core ideas — and explicitly notes "The SST model required years of iteration to stabilize." v1 ships template generation (printing `wrangler.toml` to stdout) which is immediately useful with zero risk. Full provisioning is a v1.1 milestone, clearly marked.

### 5. Concurrent `cms schema apply` Lock File

Running `cms schema apply` from two terminals simultaneously (or two CI jobs against the same database) would produce two interleaved migration sequences, corrupting the migration journal. The CLI acquires an exclusive lock before any schema mutation:

- **Lock file path:** `<project-root>/.cms-schema.lock` — adjacent to `db/migrations/`.
- **Mechanism:** `flock`-style file locking via `node:fs.open` with `O_EXCL` flag (exclusive create). If the file exists, the CLI prints a warning ("Another schema apply is in progress — waiting...") and retries with a 500ms backoff, up to 30 seconds before failing.
- **Lock content:** The lock file contains a JSON object with `pid`, `startedAt`, and a human-readable description of the running operation. This lets the developer see what is holding the lock and kill the stale process if needed.
- **Cleanup:** The lock file is deleted in a `finally` block and also on `SIGINT`/`SIGTERM`. If the process crashes before cleanup, the lock file remains — a subsequent `cms schema apply` will read the `pid` from the lock file, check if that process is still running (via `process.kill(pid, 0)`), and if not, automatically clear the stale lock.

---

## High-Level Technical Design

This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

### Command Data Flow

```
Developer
    │
    ▼
cms schema plan
    │
    ├─ lib/config-loader.ts ──► imports cms.config.ts (tsx, dynamic import)
    │                               │
    │                               └─ extracts: collections[], db config
    │
    ├─ lib/db-client.ts ──────► createDBFromConfig(config.db)
    │                               │
    │                               └─ Drizzle adapter (local SQLite / Postgres TCP)
    │
    └─ @hono-cms/schema ──────► cmsSchemaService.plan(collections, db)
                                    │
                                    └─ SchemaPlan { additions[], modifications[], deletions[] }
                                    │
                                    └─ lib/formatter.ts ──► colored human output / --json
```

### `cms dev` Startup Sequence

```
cms dev
    │
    ├─ 1. loadCMSConfig() → cms instance
    ├─ 2. createDBFromConfig() → db
    ├─ 3. cmsSchemaService.plan() → check for drift
    │       └─ if drift: auto-apply migration (dev mode only)
    ├─ 4. serve(@hono/node-server, cms.fetch, { port })
    ├─ 5. print startup banner (URL + admin URL)
    ├─ 6. watch cms/collections/ → on change: re-plan → re-apply → hot reload
    └─ 7. watch all source → hot reload via tsx --watch or Node --watch
```

### Schema Command State Machine

```
cms schema plan
    → no changes: "Schema is clean. No migrations needed."
    → changes detected: print plan (colored)

cms schema apply
    → run plan
    → if destructive and no --allow-destructive: prompt / exit 1
    → acquire lock
    → confirm (y/N) unless --yes
    → cmsSchemaService.apply(plan, db)
    → write db/migrations/NNNN_<description>.sql
    → release lock
    → print success summary

cms schema check --assert-clean
    → run plan
    → no changes: exit 0
    → changes detected: print plan, exit 1
```

---

## Output Structure

```
packages/cli/
├── package.json                    ← bin: { "cms": "./dist/index.js" }, deps
├── tsconfig.json                   ← extends @hono-cms/config/tsconfig.lib.json
├── tsdown.config.ts                ← ESM only, platform: node, dts: false
├── vitest.config.ts
└── src/
    ├── index.ts                    ← CLI entry: runMain(createMain(...))
    ├── commands/
    │   ├── dev.ts
    │   ├── build.ts
    │   ├── init.ts
    │   ├── info.ts
    │   ├── seed.ts
    │   ├── schema/
    │   │   ├── index.ts            ← schema sub-command router
    │   │   ├── plan.ts
    │   │   ├── apply.ts
    │   │   ├── check.ts
    │   │   └── generate.ts
    │   └── deploy/
    │       ├── index.ts            ← deploy sub-command router
    │       ├── cloudflare.ts
    │       ├── vercel.ts
    │       └── node.ts
    ├── lib/
    │   ├── config-loader.ts
    │   ├── db-client.ts
    │   ├── lock.ts
    │   ├── formatter.ts
    │   └── admin-proxy.ts
    └── __tests__/
        ├── schema-plan.test.ts
        ├── schema-apply.test.ts
        ├── schema-check.test.ts
        ├── schema-generate.test.ts
        ├── dev.test.ts
        ├── init.test.ts
        └── deploy.test.ts
```

---

## Implementation Units

---

### U1. CLI Package Scaffold

**Goal:** Create the `packages/cli/` package with all required monorepo boilerplate, the `bin` field pointing to the CLI entry point, and a `tsdown` config that compiles to ESM-only with no declaration files. The entry point must be executable as `cms` from the shell after install.

**Requirements:** CLI must be installable globally (`bun install -g @hono-cms/cli`) and locally as a devDependency (run via `bunx cms` or as a script in `package.json`). The `tsdown` build must produce a single `dist/index.js` ESM file with a `#!/usr/bin/env node` shebang injected at the top. No `dist/index.d.ts` — the CLI is a binary, not a library.

**Dependencies:** Plan 001 (monorepo foundation — root workspace, tsconfig.base.json, shared configs must exist)

**Files:**
- `packages/cli/package.json`
- `packages/cli/tsconfig.json`
- `packages/cli/tsdown.config.ts`
- `packages/cli/vitest.config.ts`
- `packages/cli/src/index.ts`

**Approach:**

`package.json` declares:
- `"bin": { "cms": "./dist/index.js" }` — the field that causes npm/bun to symlink the binary into `.bin/cms` on local install and into the global binary path on global install
- `"type": "module"` — ESM package
- No `"exports"` field needed — the CLI is not imported, only executed
- Dependencies: `citty` (command framework), `@clack/prompts` (init wizard), `consola` (colored output), `pathe` (path handling), `mlly` (ESM utilities for dynamic import), `tsx` (TypeScript execution for loading user's config), `chokidar` (file watching in dev mode), `@hono/node-server` (dev server runtime)
- devDependencies: `@hono-cms/config workspace:*`, `@hono-cms/schema workspace:*`, `@hono-cms/core workspace:*`

`tsdown.config.ts` diverges from the shared base in two important ways:
- `format: ['esm']` — CLI is ESM-only; no CJS needed since it is never `require()`'d
- `dts: false` — no declaration files; the CLI is not consumed as a library
- `platform: 'node'` — enables Node.js built-ins (`node:fs`, `node:path`, `node:child_process`)
- `banner: { js: '#!/usr/bin/env node' }` — injects the shebang at the top of `dist/index.js` so the file is executable without a `node` prefix

`src/index.ts` calls `runMain(createMain({ ... }))` from citty, assembling the full command tree from the individual command files. It also handles the top-level `--version` flag by reading `version` from the package's own `package.json`.

**Installation modes:**

*Global install:* `bun install -g @hono-cms/cli` places `cms` in the bun global bin path (typically `~/.bun/bin/`). The developer runs `cms dev`, `cms schema plan`, etc. from any project directory. This is the intended DX for developers who work with `@hono-cms` projects regularly.

*Local install:* `bun add -D @hono-cms/cli` in a project adds `cms` to `./node_modules/.bin/cms`. Run as `bunx cms dev` or add to `package.json` scripts: `"dev": "cms dev"`. This is the recommended approach for CI and for projects that want to pin the CLI version.

*No install (one-off):* `bunx @hono-cms/cli dev` runs the published CLI without installing.

**Patterns to follow:** `packages/config/package.json` (workspace package scaffold pattern from Plan 001); `tsdown.config.base.ts` (shared base and mergeConfig pattern).

**Test scenarios:**
- `Test expectation: none` — This unit is pure scaffolding. Verification is build-level: `bun run build` produces `dist/index.js` with a shebang, the file is executable (`chmod +x` applied automatically by bun), and `node dist/index.js --version` prints the package version. `cms --help` after global install lists all top-level commands.

**Verification:**
- `bun run build` in `packages/cli/` exits 0 and produces `dist/index.js` (no `dist/index.d.ts`)
- `head -1 dist/index.js` prints `#!/usr/bin/env node`
- `node dist/index.js --help` prints the command list without errors
- `bun install -g .` from `packages/cli/` makes `cms` available in `$PATH`
- `turbo run build --filter=@hono-cms/cli` succeeds in the monorepo context

---

### U2. Schema Plan Command

**Goal:** Implement `cms schema plan` — the command that computes and displays the migration plan as a human-readable, color-coded diff between the current TypeScript collection definitions and the live database state. This is the foundation of every other schema command.

**Requirements:**
- Load `cms.config.ts` from `process.cwd()` via `loadCMSConfig()`
- Extract the `collections` array and `db` config from the loaded CMS instance
- Call `cmsSchemaService.plan(collections, db)` from `@hono-cms/schema` to produce a `SchemaPlan` object
- Format the `SchemaPlan` with `formatSchemaPlan()` from `lib/formatter.ts`:
  - Additions (`+`) in green
  - Non-destructive modifications (`~`) in yellow
  - Destructive modifications (`~` with `DESTRUCTIVE` label) in red
  - Deletions (`-`) in red
- Print footer hint lines: "Run `cms schema apply` to execute." and "Run `cms schema apply --dry-run` to see SQL without executing."
- When no changes are detected, print "Schema is clean. No migrations needed." and exit 0
- `--json` flag: print the raw `SchemaPlan` object as JSON to stdout (machine-readable for CI integrations and tooling)
- `--config <path>`: override the default config file search path

**Dependencies:** U1 (CLI scaffold), `@hono-cms/schema` (cmsSchemaService.plan), `lib/config-loader.ts`, `lib/db-client.ts`, `lib/formatter.ts`

**Files:**
- `packages/cli/src/commands/schema/plan.ts`
- `packages/cli/src/lib/config-loader.ts`
- `packages/cli/src/lib/db-client.ts`
- `packages/cli/src/lib/formatter.ts`
- `packages/cli/src/__tests__/schema-plan.test.ts`

**Approach:**

`config-loader.ts` exposes `loadCMSConfig(configPath?: string): Promise<CMSInstance>`. It:
1. Resolves the config file path: try `cms.config.ts`, then `cms.config.js`, then traverse up to find the nearest project root with a `package.json` if no config is found in cwd
2. Registers the `tsx` ESM loader hook via `register()` from `tsx/esm/api` before the dynamic import — this enables importing TypeScript without a pre-compilation step
3. Dynamic-imports the resolved path, validates the default export is a CMS instance, and returns it
4. On failure, prints a diagnostic message pointing to the config file location and exits 1

`db-client.ts` exposes `createDBFromConfig(dbConfig: DBConfig): Promise<DrizzleInstance>`. It reads the `provider` discriminant and calls the appropriate adapter factory. For D1 in a local dev context, it falls back to a local SQLite file at `.cms/dev.db` (the same file `cms dev` uses). For Postgres, it reads `DATABASE_URL` from the environment (`.env` file loaded via `dotenv` in `config-loader`).

`formatter.ts` exposes `formatSchemaPlan(plan: SchemaPlan, opts?: { json?: boolean }): string`. It maps `SchemaPlan` fields to colored terminal output using `consola`'s color utilities or `ansis` (a small ANSI color library). The format mirrors the design spec exactly:

```
Changes detected (N):
  + collection: description of addition
  ~ collection: description of modification
  ~ collection: description (DESTRUCTIVE — data preserved)
  - collection: description of deletion (DESTRUCTIVE)
```

**Test scenarios:**
- Happy path — no drift: mock `cmsSchemaService.plan` returning `{ additions: [], modifications: [], deletions: [] }`; assert output is "Schema is clean." and process exits 0
- Additions only: mock plan with two additions; assert output contains two green `+` lines and the footer hint
- Mixed changes: mock plan with one addition, one non-destructive modification, one destructive rename; assert output uses correct colors and labels for each change type
- Destructive deletion: mock plan with a column deletion; assert it is labeled red with "DESTRUCTIVE"
- `--json` flag: mock a plan object; assert stdout is valid JSON equal to the plan object (no color codes in JSON output)
- Config file not found: remove `cms.config.ts` from the test fixture directory; assert CLI exits 1 with a diagnostic message pointing to the missing file
- Invalid config export: mock a config file that exports a plain object (not a CMS instance); assert CLI exits 1 with a validation error

**Verification:**
- `cms schema plan` in a project with no schema drift prints "Schema is clean" and exits 0
- `cms schema plan` in a project with pending changes prints the plan with colored output
- `cms schema plan --json | jq .additions` is parseable and returns an array
- Exit code is always 0 for `plan` (it is read-only; it never fails on detected drift — that is `check`'s job)

---

### U3. Schema Apply Command

**Goal:** Implement `cms schema apply` — the command that executes the migration plan, writes the SQL migration file to `db/migrations/`, and prints a success summary. It is the production-safe gate between schema definition and database state.

**Requirements:**
- Show the schema plan output first (calls the plan formatter internally, same as `cms schema plan`)
- If no changes, print "Nothing to apply." and exit 0
- Prompt for confirmation `Apply these changes? (y/N)` unless `--yes` flag is passed
- If the plan contains destructive changes (renames, column drops, type changes) AND `--allow-destructive` is not passed: exit 1 with a clear message listing the destructive operations. The developer must explicitly opt in with `--allow-destructive` or be prompted with a second confirmation
- Acquire lock (`.cms-schema.lock`) before any mutation — see Key Technical Decision #5
- Call `cmsSchemaService.apply(plan, db)` from `@hono-cms/schema`
- Write the SQL migration file to `db/migrations/NNNN_<slug>.sql` with sequential numbering (zero-padded to 4 digits, starting at 0001; next number is `max(existing) + 1`)
- Release lock and print success summary: migration file path, number of statements applied, elapsed time
- `--dry-run`: run the plan and show SQL that would be executed (from `cmsSchemaService.generateSQL(plan)`) without applying or writing the file
- `--yes` / `-y`: skip confirmation prompt (for CI or scripting contexts — use with caution; document this clearly)
- `--allow-destructive`: allow destructive operations to proceed without a separate block

**Dependencies:** U2 (schema plan — plan display logic is reused), U1, `@hono-cms/schema`, `lib/lock.ts`

**Files:**
- `packages/cli/src/commands/schema/apply.ts`
- `packages/cli/src/lib/lock.ts`
- `packages/cli/src/__tests__/schema-apply.test.ts`

**Approach:**

`lock.ts` exposes `acquireLock(projectRoot: string): Promise<LockHandle>` and `releaseLock(handle: LockHandle): void`. The lock handle contains the file descriptor and cleanup logic. The `acquireLock` function:
1. Attempts `fs.open('.cms-schema.lock', 'wx')` — `wx` is create+exclusive, fails if file exists
2. On success: writes lock metadata JSON (`{ pid, startedAt, operation: 'schema-apply' }`) to the file
3. On failure (EEXIST): reads the existing lock file, checks if the recorded `pid` is still alive via `process.kill(pid, 0)` — if the process is dead, deletes the stale lock and retries; if alive, prints a waiting message and retries with 500ms backoff up to 30 seconds before giving up with exit code 1
4. Registers `SIGINT`/`SIGTERM` handlers to release the lock on interrupt

Migration file naming: the slug is derived from the plan description — e.g., "add publishedAt to articles, rename fullName to displayName in authors" is slugified to `add_publishedat_articles_rename_fullname_displayname_authors`, truncated to 60 characters. The full file name: `0002_add_publishedat_articles.sql`.

**Test scenarios:**
- Happy path — additive only: mock plan with two additions, `--yes` flag; assert `cmsSchemaService.apply` is called, migration file is written to `db/migrations/0001_add_title_articles.sql`, success summary printed, exit 0
- Confirmation prompt — user types `y`: mock plan, prompt response `y`; assert apply proceeds
- Confirmation prompt — user types `N` or presses Enter: mock plan, prompt response `N`; assert apply does NOT proceed, exit 0 with "Cancelled." message
- Destructive change without `--allow-destructive`: mock plan with a column drop; assert CLI exits 1 before prompting for confirmation, prints the destructive operations list
- Destructive change with `--allow-destructive` and `--yes`: assert apply proceeds
- `--dry-run`: mock plan; assert `cmsSchemaService.generateSQL` is called and SQL is printed, `cmsSchemaService.apply` is NOT called, no migration file is written
- Lock contention: create a `.cms-schema.lock` file with a non-existent PID; assert stale lock is cleared and apply proceeds
- Lock contention with live process: create a `.cms-schema.lock` file with the current process's PID; assert CLI waits and eventually times out with exit code 1
- Sequential numbering: pre-populate `db/migrations/` with `0001_init.sql`; assert new migration is written as `0002_<slug>.sql`

**Verification:**
- `cms schema apply --yes` on a project with additive pending changes succeeds and commits a migration file
- `cms schema apply --dry-run` prints SQL without writing any files
- Running two `cms schema apply` commands simultaneously results in one succeeding and the other waiting or failing gracefully

---

### U4. Schema Check Command

**Goal:** Implement `cms schema check --assert-clean` — the CI gate that fails with exit code 1 if the database has drifted from the committed schema definitions. Used as a pre-deploy guard in GitHub Actions.

**Requirements:**
- `--assert-clean`: if any drift is detected (the `SchemaPlan` has any non-empty arrays), exit 1; if no drift, exit 0
- Without `--assert-clean`: behaves the same as `cms schema plan` (shows the plan, always exits 0) — this mode is useful for quick human review without the CI gate behavior
- `--format=json`: print a structured JSON object `{ clean: boolean, plan: SchemaPlan }` to stdout; useful for consuming check results in scripts or external CI tools
- Exit codes are the machine-readable signal — the CLI must not exit 1 for reasons other than detected drift when `--assert-clean` is passed (e.g., a missing config file exits with a different non-zero code and a different error message)
- Print a clear human message in non-JSON mode: "Schema drift detected — run `cms schema apply` to fix." with the plan output above it

**Dependencies:** U2 (config loader, db client, plan formatter, schema service integration)

**Files:**
- `packages/cli/src/commands/schema/check.ts`
- `packages/cli/src/__tests__/schema-check.test.ts`

**Approach:**

`check.ts` calls `cmsSchemaService.plan(collections, db)` identically to `plan.ts`. The difference is in the exit behavior when `--assert-clean` is passed:
- Clean plan → print "Schema is clean." → exit 0
- Drift detected → print the full colored plan (same as `cms schema plan`) → print the error message → exit 1

The `--format=json` flag suppresses colored output and writes `{ "clean": true }` or `{ "clean": false, "plan": { ... } }` to stdout. The JSON output is machine-readable for external tools that parse CLI output.

**GitHub Actions integration** (this is the intended CI usage — documented in the plan for implementers):

```yaml
# .github/workflows/deploy.yml (user's project — not in the CMS monorepo)
- name: Assert schema is clean before deploy
  run: cms schema check --assert-clean --format=json
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

This step runs before the deploy step. If schema drift is detected (a collection was changed in code but not applied), the step fails, blocking the deploy. The `DATABASE_URL` env var is the production database — the check compares the TypeScript collection definitions in the repo against the production DB state.

**Test scenarios:**
- Clean schema with `--assert-clean`: mock plan returning empty arrays; assert exit code 0 and "Schema is clean." output
- Drift detected with `--assert-clean`: mock plan with one addition; assert exit code 1, colored plan output visible, error message "Schema drift detected" visible
- `--format=json` with clean schema: assert stdout is `{ "clean": true }`, valid JSON, no ANSI codes
- `--format=json` with drift: assert stdout is `{ "clean": false, "plan": { ... } }` with the full SchemaPlan object
- Without `--assert-clean`, drift detected: assert exit code 0 (check is informational, not a gate)
- Config error: if `cms.config.ts` is missing, exit code should be 2 (not 1, which is reserved for drift) with a diagnostic message — differentiate the error codes

**Verification:**
- In a repo with no pending migrations, `cms schema check --assert-clean && echo passed` prints "passed"
- In a repo with pending migrations, `cms schema check --assert-clean || echo failed` prints "failed"
- `cms schema check --assert-clean --format=json | jq .clean` returns `true` or `false`

---

### U5. Schema Generate Command

**Goal:** Implement `cms schema generate` — the command that regenerates the TypeScript SDK types from the current schema without running a migration. Used to refresh stale types after a git pull, after resolving a merge conflict in collection files, or after the schema package is updated.

**Requirements:**
- Load the current collection definitions from `cms.config.ts` (same config-loader as other schema commands)
- Call the SDK generator function from the SDK generation package (Plan 017 — `@hono-cms/sdk-generator` or the generator exposed by `@hono-cms/schema`)
- Write the generated types to `cms/sdk/index.ts` (default path, configurable via `--out <path>`)
- Print a summary: number of types generated, file path written, elapsed time
- `--check`: diff mode — compare the current generated output against the file on disk; exit 1 if they differ (analogous to `prettier --check`). Useful in CI to verify SDK types are committed and up-to-date

**Dependencies:** U1 (CLI scaffold), U2 (config-loader), Plan 017 (SDK generator — the generator function is called from the CLI but implemented in the schema/sdk-generator package)

**Files:**
- `packages/cli/src/commands/schema/generate.ts`
- `packages/cli/src/__tests__/schema-generate.test.ts`

**Approach:**

`generate.ts` calls `generateSDKTypes(collections): SDKGeneratorResult`. The generator returns the TypeScript source as a string (not a file path). The CLI writes it to the output path using `node:fs/promises.writeFile`. The `--check` flag reads the existing file and does a string comparison — if different, exits 1 with a message listing the file that is out of date.

The output file (`cms/sdk/index.ts`) is committed to git — it is the generated artifact, like Convex's `convex/_generated/api.d.ts`. This file should be regenerated whenever the schema changes, either automatically by `cms dev` (which calls generate after every collection file change) or manually via `cms schema generate`.

**Test scenarios:**
- Happy path: mock `generateSDKTypes` returning a TypeScript string; assert the string is written to `cms/sdk/index.ts`, success message printed, exit 0
- Custom output path `--out lib/cms-types.ts`: assert the file is written to the custom path
- `--check` with up-to-date file: mock `generateSDKTypes` returning identical content to the existing file; assert exit 0
- `--check` with stale file: mock generator returning content that differs from the existing file; assert exit 1 with message "SDK types are out of date — run `cms schema generate`"
- Output directory does not exist: assert `cms/sdk/` is created via `fs.mkdir({ recursive: true })` before writing

**Verification:**
- `cms schema generate` in a project with defined collections writes a valid TypeScript file to `cms/sdk/index.ts`
- `cms schema generate --check` returns exit 0 immediately after running `cms schema generate` (types are up to date)
- The generated `cms/sdk/index.ts` file is importable from a TypeScript project without errors

---

### U6. Dev Server Command

**Goal:** Implement `cms dev` — the primary daily-driver command that starts the Hono dev server with hot reload, auto-migration on startup, file watching for schema changes, and admin SPA proxying.

**Requirements:**
- Load `cms.config.ts` dynamically and start the Hono server via `@hono/node-server`
- Default port: 3000, configurable via `--port <n>` or `PORT` env var
- Auto-migration on startup: run `cmsSchemaService.plan()` and if drift is detected, apply it automatically (in dev mode only — this is never done in production)
- File watcher on `./cms/collections/` (configurable via the schema.dir config key): when collection files change, re-plan + re-apply + hot reload
- Hot reload of the Hono app on source file changes via tsx watch mode or Node.js `--watch`
- `--open` flag: open the admin SPA URL in the default browser (`open` package or `node:child_process exec start/open/xdg-open`)
- Print startup banner: server URL, admin URL, database provider, runtime mode
- Admin SPA proxy: if the admin package's build output does not exist at `apps/admin/dist/`, proxy admin SPA requests to `http://localhost:5173` (Vite dev server) — forward all `/admin/*` requests to the Vite dev server
- Graceful shutdown on `SIGINT`/`SIGTERM`: close the server, close the DB connection, print "Shutting down..."

**Dependencies:** U1 (CLI scaffold), U2 (config-loader, db-client), `@hono/node-server`, `chokidar` (file watching), `lib/admin-proxy.ts`

**Files:**
- `packages/cli/src/commands/dev.ts`
- `packages/cli/src/lib/admin-proxy.ts`
- `packages/cli/src/__tests__/dev.test.ts`

**Approach:**

The dev command uses a restart architecture: the Hono server runs in a child process (or in the same process with tsx's `--watch` mechanism). When source files change, the child process is restarted with the new version of `cms.config.ts`. This avoids the complexity of manually hot-swapping route handlers inside a live Hono instance.

`admin-proxy.ts` exposes `createAdminProxy(vitePort: number): RequestHandler`. When `cms dev` detects no pre-built admin dist, it adds a catch-all handler for `/admin/*` that proxies to the Vite dev server. The proxy uses `node-fetch` or the native `fetch` API to forward requests and stream responses back. WebSocket upgrade requests (for Vite HMR) are also forwarded via `http-proxy` or a minimal WebSocket proxy.

**Startup banner format:**

```
  @hono-cms/dev
  ─────────────────────────────────
  Server:  http://localhost:3000
  Admin:   http://localhost:3000/admin  (proxied to Vite :5173)
  DB:      SQLite (.cms/dev.db)
  Mode:    development

  Watching ./cms/collections/ for schema changes...
  Auto-migration applied (1 migration).
```

**Test scenarios:**
- Happy path startup: mock `loadCMSConfig`, mock `@hono/node-server`, mock `cmsSchemaService.plan` returning empty plan; assert server starts on default port 3000, startup banner is printed, no migration is applied
- Auto-migration on startup: mock plan returning one pending migration; assert `cmsSchemaService.apply` is called before the server accepts requests, banner includes "Auto-migration applied (1 migration)"
- Schema change via file watcher: trigger a chokidar `change` event on `cms/collections/articles.ts`; assert plan+apply cycle is triggered and the server is restarted
- `--port 4000`: assert server starts on port 4000
- `--open` flag: assert `open(adminURL)` is called after startup
- Admin SPA proxy: when `apps/admin/dist/` does not exist, assert a proxy handler is registered for `/admin/*`; when it does exist, assert static file serving is used instead
- Graceful shutdown: send SIGINT; assert server `close()` is called and DB connection is cleaned up

**Verification:**
- `cms dev` starts without errors in a project with a valid `cms.config.ts`
- Editing `cms/collections/articles.ts` triggers a schema re-check within 2 seconds
- `curl http://localhost:3000/api/health` returns 200 after startup
- `Ctrl+C` exits cleanly with exit code 0

---

### U7. Init Wizard Command

**Goal:** Implement `cms init` — the interactive setup wizard that creates a new `cms.config.ts`, updates `package.json`, writes `.env.example`, and installs selected adapter packages. This is the entry point for all new `@hono-cms` projects.

**Requirements:**
- Use `@clack/prompts` for all interactive prompts (spinner, select, multiselect, text, confirm)
- Prompt sequence (in order):
  1. Project name (text, default: directory name)
  2. Database provider (select): SQLite (local dev default), D1 (Cloudflare), Postgres (Node.js/Vercel), Turso (libSQL), Convex
  3. Storage provider (select): Local (Node.js only), R2 (Cloudflare), S3, Vercel Blob, None
  4. Auth plugins (multiselect): Organization, API Keys, Two-Factor, Magic Link, Passkeys, OAuth (GitHub, Google)
  5. Email provider (select): Console (dev default, no sending), Resend, Postmark, SMTP, None
  6. Confirm: show summary of choices and ask "Create project with these settings? (Y/n)"
- Validation:
  - D1 database + non-Cloudflare storage → warning: "D1 requires Cloudflare runtime — choose R2 for storage or switch to a Postgres adapter"
  - Local storage + Cloudflare D1 → incompatible combination, prevent selection
  - Convex database → show note: "Convex uses its own storage — storage adapter is not applicable"
- Create files:
  - `cms.config.ts` — generated from template based on selections
  - `.env.example` — populated with required env vars for selected providers
  - Update `package.json`: add `@hono-cms/core`, the selected adapter, and plugin packages to dependencies
- Run `bun install` (or `npm install` / `pnpm install` based on detected package manager) after file creation
- Cancellation at any prompt: print "Cancelled." and exit 0 cleanly

**Dependencies:** U1 (CLI scaffold), `@clack/prompts`

**Files:**
- `packages/cli/src/commands/init.ts`
- `packages/cli/src/__tests__/init.test.ts`

**Approach:**

The init command detects the package manager from the project's lockfile: `bun.lock` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm. This determines which install command to run at the end.

`cms.config.ts` generation uses a template string builder (not a template engine dependency) — the prompt answers are substituted into a hardcoded template that produces valid TypeScript. Each provider combination has a pre-tested template variant. The generated file includes comments explaining each config key.

`.env.example` is generated from a lookup table: each provider combination maps to a list of required env var names with example values (e.g., `DATABASE_URL=postgres://localhost:5432/mydb`).

Package manager detection + install command: after writing files, the command runs `bun install @hono-cms/core @hono-cms/adapter-d1 ...` (or the detected package manager's equivalent) as a child process. Output is streamed to the terminal via `consola` so the developer sees the install progress.

**Test scenarios:**
- Happy path — D1 + R2 + Organization auth + Resend email: mock all `@clack/prompts` responses; assert `cms.config.ts` is written with correct D1 adapter config, R2 storage config, organization auth plugin, Resend email config; assert `.env.example` contains `CLOUDFLARE_D1_DATABASE_ID`, `R2_BUCKET_NAME`, `RESEND_API_KEY`
- Happy path — Postgres + Local storage + no auth plugins: assert `cms.config.ts` uses `adapter-postgres`, storage: `local`, auth: `{ plugins: [] }`
- Incompatible combination D1 + Local storage: assert the local storage option is disabled in the select when D1 is chosen, or a validation error is shown before continuing
- Cancellation at database prompt: mock `@clack/prompts` cancel signal; assert no files are written, exit 0 with "Cancelled."
- Cancellation at final confirm: mock `n` response to final confirm; assert no files are written
- Detected bun (bun.lock exists): assert install command is `bun install ...`
- Detected npm (package-lock.json exists): assert install command is `npm install ...`
- Existing `cms.config.ts` in the directory: assert the wizard warns "cms.config.ts already exists — overwrite?" and prompts for confirmation

**Verification:**
- `cms init` in an empty directory creates a valid `cms.config.ts` that TypeScript can compile without errors
- `cms init` in a project that already has a `package.json` preserves existing fields and adds only the new dependencies
- The generated `.env.example` is non-empty and contains all required env vars for the selected providers

---

### U8. Deploy Command (v1: Template Output; v1.1+: Automated Provisioning)

**Goal:** Implement `cms deploy` as a template-printing command for v1. For each target (`cloudflare`, `vercel`, `node`), the command reads `cms.config.ts` to understand the project's provider requirements, then prints a ready-to-commit configuration template to stdout or writes it to a file. This gives developers a correct starting point without any automated provisioning risk.

> **v1.1+ milestone:** Full automated provisioning — calling the Wrangler CLI API, Vercel project API, or generating and running Terraform/Pulumi configs — is explicitly deferred. The rationale is documented in Key Technical Decision #4. A `[v1.1]` comment in the source code marks where the provisioning code will be inserted.

**Requirements (v1):**
- `--target=cloudflare`: generates a `wrangler.toml` template with:
  - `[[d1_databases]]` binding for the CMS database
  - `[[r2_buckets]]` binding (if storage: r2 is configured)
  - `[[kv_namespaces]]` binding (if cache: kv or cache: upstash)
  - `[triggers] crons` section (if crons: cloudflare is configured)
  - Name, main, compatibility_date filled from project name and current date
- `--target=vercel`: generates a `vercel.json` template with:
  - `crons` array (if crons: vercel is configured)
  - Environment variable list (all required env vars for the selected providers)
  - `buildCommand` and `outputDirectory` fields
- `--target=node`: generates a `Dockerfile` and `docker-compose.yml` template with:
  - `Dockerfile`: multi-stage Node.js build (node:22-alpine base, copies `cms.config.ts`, installs dependencies, runs `node dist/index.js`)
  - `docker-compose.yml`: CMS service + Postgres service, volume for SQLite if applicable, environment vars from `.env.example`
- `--out <path>`: write the output to a file instead of stdout (e.g., `--out wrangler.toml`). Prompts for confirmation if the file already exists, unless `--yes` is passed
- `--dry-run`: alias for the default v1 behavior (print to stdout, write nothing). Labeled as `--dry-run` to set expectations that v1 is always a dry run; in v1.1 the default will switch to "execute provisioning"

**Risk Documentation (in source comments and help text):**

The `deploy` command's help text includes:
```
NOTE: cms deploy in v1 generates configuration templates for manual review and commit.
Automated infrastructure provisioning (v1.1) will require cloud provider credentials
and will make real changes to your cloud account. Always review generated config
before applying.
```

**Dependencies:** U1 (CLI scaffold), U2 (config-loader — reads provider config to tailor templates)

**Files:**
- `packages/cli/src/commands/deploy/index.ts`
- `packages/cli/src/commands/deploy/cloudflare.ts`
- `packages/cli/src/commands/deploy/vercel.ts`
- `packages/cli/src/commands/deploy/node.ts`
- `packages/cli/src/__tests__/deploy.test.ts`

**Approach:**

Each target file exports a `generateTemplate(config: CMSConfig, projectName: string): string` function. The function inspects the `config.db.provider`, `config.storage.provider`, `config.cache.provider`, and `config.crons.provider` to conditionally include the relevant sections in the template.

Template generation uses tagged template literals with conditional blocks — no external template engine. The templates are hardcoded strings that are correct starting points, not generated by querying cloud APIs.

**v1 vs v1.1 delineation in the cloudflare target:**

```typescript
// packages/cli/src/commands/deploy/cloudflare.ts

export async function cloudflareDeployHandler(opts: DeployOptions) {
  const config = await loadCMSConfig(opts.config)
  const template = generateWranglerToml(config, opts.projectName)

  // v1: print template to stdout or write to file
  await writeOrPrint(template, opts.out, opts.yes)

  consola.info('Review wrangler.toml and run `npx wrangler deploy` to deploy.')

  // [v1.1] Automated provisioning:
  // const client = new CloudflareApiClient({ apiToken: process.env.CF_API_TOKEN })
  // await client.d1.createDatabase({ name: `${projectName}-cms` })
  // await client.r2.createBucket({ name: `${projectName}-cms-media` })
  // await client.workers.deploy({ script: bundledWorker, config: wranglerConfig })
}
```

**What each target generates:**

*Cloudflare (`wrangler.toml`):*
- `name`, `main = "dist/index.js"`, `compatibility_date`
- `[[d1_databases]]` with `binding = "DB"`, `database_name`, `database_id = "<replace-me>"`
- `[[r2_buckets]]` (conditional on R2 storage)
- `[[kv_namespaces]]` (conditional on KV cache)
- `[triggers]` crons (conditional on Cloudflare crons provider)
- `[vars]` section with placeholder env vars

*Vercel (`vercel.json`):*
- `{ "crons": [...] }` (conditional on Vercel crons)
- Comment block listing required env vars to set in Vercel project settings

*Node (`Dockerfile` + `docker-compose.yml`):*
- `Dockerfile`: multi-stage build, node:22-alpine, `COPY`, `RUN bun install --production`, `CMD`
- `docker-compose.yml`: `cms` service using the Dockerfile, `postgres` service with volume, `depends_on`

**Test scenarios:**
- Cloudflare target with D1 + R2 + no crons: assert `wrangler.toml` output contains `[[d1_databases]]`, `[[r2_buckets]]`, no `[triggers]` section
- Cloudflare target with D1 + crons: assert `[triggers]` section is present with cron schedules
- Vercel target with Vercel crons: assert `vercel.json` output is valid JSON containing a `crons` array
- Node target: assert `Dockerfile` output starts with `FROM node:22-alpine`, contains `COPY`, `RUN`, `CMD` instructions
- Node target: assert `docker-compose.yml` output is valid YAML with `cms` and `postgres` services
- `--out wrangler.toml` flag: assert template is written to the file, not to stdout
- `--out` with existing file, no `--yes`: assert prompt "Overwrite wrangler.toml? (y/N)" appears
- Config with Postgres provider generates Node dockerfile (not Cloudflare D1 binding)

**Verification:**
- `cms deploy --target=cloudflare` prints a valid `wrangler.toml` to stdout
- `cms deploy --target=cloudflare --out wrangler.toml` writes the file to disk
- The generated `wrangler.toml` passes `npx wrangler deploy --dry-run` after filling in the `database_id` placeholder
- The generated `Dockerfile` builds successfully with `docker build .` in a project with a built `dist/index.js`

---

## Dependencies and Sequencing

```
U1 (scaffold)
  └─ U2 (schema plan)
       ├─ U3 (schema apply)  ─ depends on U2's config-loader + lock.ts
       ├─ U4 (schema check)  ─ depends on U2's plan logic (thin wrapper)
       └─ U5 (schema generate) ─ depends on U2's config-loader
  └─ U6 (dev server)         ─ depends on U2's config-loader + db-client
  └─ U7 (init wizard)        ─ depends on U1 only (no schema service needed)
  └─ U8 (deploy)             ─ depends on U2's config-loader (reads provider config)
```

U2 through U8 can each be started after U1 is complete. U3 and U4 depend on U2 being functional first (they reuse the config-loader and formatter). U5 additionally requires the SDK generator from Plan 017 to be implemented before the full integration test can pass, but the CLI command shell can be written and partially tested before Plan 017 is complete.

---

## Risk Analysis and Mitigation

### Risk 1: TypeScript config loading is fragile across project setups

**Risk:** Developers have diverse project setups — some use path aliases, some use `tsconfig.json` project references, some have unusual module resolution. The `tsx`-based dynamic import may fail in edge cases.

**Mitigation:** Ship a `--config <path>` override flag on every schema command and dev. Document the supported config file names and export shapes. Provide a clear error message with a link to docs when loading fails, including the resolved file path and the import error message.

**Fallback:** If `tsx` ESM loader fails, fall back to spawning `tsx cms.config.ts --inspect` as a child process and reading the config from stdout as serialized JSON. This is less elegant but more robust.

### Risk 2: Lock file cleanup failure leaves projects stuck

**Risk:** If the CLI crashes after acquiring the lock but before releasing it, the `.cms-schema.lock` file persists. Future `cms schema apply` calls will detect the lock and wait or fail.

**Mitigation:** The lock file contains a PID. On lock acquisition failure, the CLI reads the PID, checks if the process is alive, and clears stale locks automatically. Additionally, document `rm .cms-schema.lock` as the manual recovery step in the error message.

### Risk 3: Auto-migration in `cms dev` applies non-obvious migrations

**Risk:** A developer pulls from git, starts `cms dev`, and auto-migration applies a migration they did not review. On a local dev database this is low-risk, but it creates a habit of not reviewing migrations.

**Mitigation:** Auto-migration in dev prints a clear banner: "Auto-migration applied: N changes (see db/migrations/NNNN.sql)". The migration file is always committed to git (even for dev-mode auto-applies) so the change is visible in `git diff`. Auto-migration is never active in production — the `NODE_ENV === 'production'` check prevents it. Consider adding a `--no-auto-migrate` flag for developers who want to control migration timing even in dev.

### Risk 4: `cms deploy` templates drift from provider config format changes

**Risk:** Wrangler config format, `vercel.json` schema, and Dockerfile base images change over time. Hardcoded templates in the CLI become stale.

**Mitigation:** Templates are versioned and dated in comments. The CLI logs the Wrangler, Vercel CLI, and Docker versions they were tested with. Add integration tests that validate generated templates against the provider's schema validation tools (e.g., `wrangler --dry-run`, `vercel --dry-run`) in the CLI's CI suite.

### Risk 5: `@clack/prompts` init wizard terminal compatibility

**Risk:** Non-interactive terminals (CI, piped input, minimal Docker shells) do not support TTY prompts. The wizard will hang or crash if run in these environments.

**Mitigation:** Detect `process.stdin.isTTY` before running the wizard. If not a TTY, print a message: "cms init requires an interactive terminal. Use --preset=<name> for non-interactive setup." Provide `--preset=cloudflare`, `--preset=vercel`, `--preset=node` flags that skip the wizard and use preset defaults for non-interactive contexts.

---

## System-Wide Impact

### Packages This Plan Creates

- `packages/cli/` — new package, `@hono-cms/cli`, with `bin: { "cms": "./dist/index.js" }`

### Packages This Plan Imports From

- `@hono-cms/core` — for loading and validating the `cms` instance from `cms.config.ts`
- `@hono-cms/schema` — for `cmsSchemaService.plan()`, `cmsSchemaService.apply()`, `cmsSchemaService.generateSQL()`
- `@hono/node-server` — for the `cms dev` server runtime

### Impact on Other Plans

- **Plan 017 (SDK Generator):** `cms schema generate` depends on the generator function from this plan. U5 can be scaffolded before Plan 017 is complete but cannot be fully integration-tested until the generator is implemented. Coordinate: the generator should be exported as a named function `generateSDKTypes(collections): string` from `@hono-cms/schema` or a dedicated generator package.
- **Plan 001 (Monorepo Foundation):** The CLI's tsdown config diverges from the shared base (`dts: false`, `format: ['esm']`, `platform: 'node'`, `banner: shebang`). This is an intentional and documented divergence — the scaffold script should not be used for the CLI package as it defaults to `dts: true`.
- **All other plans:** The CLI's `cms dev` command is how developers will run and interact with the CMS during development of Plans 002–018. Any package that adds routes, middleware, or configuration keys to `createCMS` should be testable via `cms dev` once the core is wired.

---

## Deferred Implementation Notes

These questions are knowable but depend on execution-time code interaction:

- **Exact `SchemaPlan` type shape:** The plan formatter (`formatter.ts`) maps `SchemaPlan` fields to human-readable strings. The exact field names (`additions`, `modifications`, `deletions`) and their sub-properties (e.g., `{ type: 'rename', from: string, to: string, isDestructive: boolean }`) are defined by `@hono-cms/schema`. Implementers of U2 should consult that package's type exports and align the formatter accordingly.
- **SDK generator export shape:** U5 calls `generateSDKTypes(collections)` — the exact function name and return type depend on Plan 017's implementation. The CLI should import it with a clear interface boundary so a mock can be substituted in tests.
- **tsx API for ESM loader registration:** The `tsx/esm/api` import path for registering a loader hook is subject to change across tsx versions. Implementers should pin the tsx version and test the registration approach against the pinned version. The `register()` call from `tsx/esm/api` is the current (2026) stable API.
- **chokidar vs Node.js `--watch`:** For file watching in `cms dev`, chokidar is the more featureful option (recursive watching, debounce, glob patterns). Node.js `--watch` is simpler but less configurable. The implementer should benchmark both for the collections-directory watching use case and choose based on latency (target: < 500ms from file save to migration applied).

---

## Completion Checklist

Before marking this plan complete:

- [ ] U1: `bun run build` in `packages/cli/` produces `dist/index.js` with shebang, no `dist/index.d.ts`
- [ ] U1: `node dist/index.js --help` lists all commands without errors
- [ ] U1: `bun install -g .` from `packages/cli/` makes `cms` available in `$PATH`
- [ ] U2: `cms schema plan` in a clean project exits 0 with "Schema is clean." message
- [ ] U2: `cms schema plan` with pending changes prints color-coded output with correct labels
- [ ] U2: `cms schema plan --json` prints valid JSON parseable by `jq`
- [ ] U3: `cms schema apply --yes` on additive changes applies migration and writes `db/migrations/NNNN_*.sql`
- [ ] U3: `cms schema apply` on destructive changes without `--allow-destructive` exits 1 before prompting
- [ ] U3: `cms schema apply --dry-run` prints SQL without writing any files or modifying the DB
- [ ] U3: Concurrent `cms schema apply` calls result in one succeeding and the other waiting or failing gracefully
- [ ] U4: `cms schema check --assert-clean` exits 0 in a clean project
- [ ] U4: `cms schema check --assert-clean` exits 1 with drift detected and non-zero output
- [ ] U4: `cms schema check --assert-clean --format=json | jq .clean` returns `true` or `false`
- [ ] U5: `cms schema generate` writes a valid TypeScript file to `cms/sdk/index.ts`
- [ ] U5: `cms schema generate --check` exits 0 when types are current
- [ ] U6: `cms dev` starts the Hono server, prints the startup banner, and accepts requests
- [ ] U6: Editing a collection file while `cms dev` is running triggers auto-migration within 2 seconds
- [ ] U6: `cms dev --open` opens the admin URL in the default browser
- [ ] U7: `cms init` in an empty directory creates `cms.config.ts`, `.env.example`, and runs `bun install`
- [ ] U7: Cancellation at any prompt writes no files and exits 0
- [ ] U7: D1 + Local storage combination is blocked with a clear error
- [ ] U8: `cms deploy --target=cloudflare` prints a valid `wrangler.toml` to stdout
- [ ] U8: `cms deploy --target=vercel` prints a valid `vercel.json` to stdout
- [ ] U8: `cms deploy --target=node` prints a valid `Dockerfile` and `docker-compose.yml`
- [ ] U8: `--out <file>` writes the template to disk instead of stdout
- [ ] All units: Vitest test suite passes with no skipped tests in `packages/cli/src/__tests__/`
- [ ] All units: `turbo run test --filter=@hono-cms/cli` passes in CI

---

## What This Plan Does Not Cover

The following are explicitly deferred to subsequent plans or later milestones:

- **Plan 017 (SDK Generator):** The actual TypeScript type generation logic called by `cms schema generate` — this plan only covers the CLI command that invokes it
- **v1.1 — Automated deploy provisioning:** Calling Wrangler API, Vercel API, or Pulumi/Terraform to provision cloud resources from schema definitions (see Key Technical Decision #4 and U8)
- **`cms migrate rollback`:** Schema migration rollback capability — deferred to v1.1 after the forward migration path is proven
- **`cms export` / `cms import`:** Content data portability commands
- **Plugin CLI (`cms add <plugin>`):** Plugin installation command
- **Multi-environment config:** `cms dev --env staging` pointing to a different database for each environment
