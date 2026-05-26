---
title: "feat: Monorepo Foundation — Turborepo + Bun + OXC + tsdown + Vitest"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
---

# Plan 001: Monorepo Foundation

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, architecture review, performance review

### Key Improvements

1. Add explicit worker-safe package-boundary enforcement.
2. Treat generated artifacts and lockfile behavior as deterministic CI contracts.
3. Keep Bun isolated installs explicit instead of relying on defaults.

**Sequence:** 001 of 018  
**Estimated effort:** 1–2 days  
**Blocking:** All other plans (002–018) cannot begin until this plan is complete and green on CI.

---

## Purpose

This plan establishes the complete monorepo skeleton for `@hono-cms` — a universally-deployable, Hono-based CMS built as a library, not a service. Every architectural decision in the ideation (typed DB adapters, storage adapters, schema-driven RBAC, the decoupled admin SPA) requires a clean, reproducible build environment before a single line of CMS feature code is written.

Plan 001 covers infrastructure only. It produces no CMS runtime behavior. When it is complete, every developer on the project can:

1. Clone the repo and run `bun install` to get a reproducible lockfile.
2. Run `turbo run build` to build all packages with correct dependency ordering.
3. Run `turbo run typecheck lint test` to get a passing CI signal from an empty (stub) codebase.
4. Run `bun run scripts/scaffold-package.ts <name>` to add a new package with zero manual boilerplate.
5. Open a PR and see GitHub Actions pass on the first commit.

---

## Repository Layout

```
~/dev/monorepo/cms/
├── turbo.json                          # Turborepo v2 task graph
├── package.json                        # root, private, bun workspaces
├── bun.lock                            # lockfile, committed to git
├── bunfig.toml                         # bun linker config
├── tsconfig.base.json                  # shared TypeScript base (strict, bundler resolution)
├── tsdown.config.base.ts               # shared tsdown base config
├── .oxlintrc.json                      # root lint rules
├── .gitignore
├── .github/
│   └── workflows/
│       └── ci.yml
├── scripts/
│   └── scaffold-package.ts
├── apps/
│   └── admin/                          # @hono-cms/admin-spa
│       ├── package.json
│       ├── vite.config.ts
│       ├── vitest.config.ts
│       ├── tsconfig.json
│       └── src/
│           └── main.tsx
├── packages/
│   ├── config/                         # @hono-cms/config
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsconfig.lib.json
│   │   ├── tsconfig.app.json
│   │   └── vitest.shared.ts
│   ├── core/                           # @hono-cms/core
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsdown.config.ts
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       └── index.ts
│   ├── schema/                         # @hono-cms/schema
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsdown.config.ts
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       └── index.ts
│   ├── cli/                            # @hono-cms/cli
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsdown.config.ts
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       └── index.ts
│   ├── adapter-d1/                     # @hono-cms/adapter-d1
│   │   └── ... (same skeleton)
│   ├── adapter-postgres/               # @hono-cms/adapter-postgres
│   │   └── ...
│   ├── adapter-turso/                  # @hono-cms/adapter-turso
│   │   └── ...
│   ├── adapter-convex/                 # @hono-cms/adapter-convex
│   │   └── ...
│   ├── storage-r2/                     # @hono-cms/storage-r2
│   │   └── ...
│   ├── storage-s3/                     # @hono-cms/storage-s3
│   │   └── ...
│   ├── storage-vercel-blob/            # @hono-cms/storage-vercel-blob
│   │   └── ...
│   ├── storage-local/                  # @hono-cms/storage-local
│   │   └── ...
│   ├── cache/                          # @hono-cms/cache
│   │   └── ...
│   └── jobs/                           # @hono-cms/jobs
│       └── ...
└── docs/
    ├── plans/
    ├── ideation/
    └── references/
```

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Set `linker = "isolated"` explicitly in `bunfig.toml` even if newer Bun defaults would choose it for some workspace layouts.
- Use `workspace:*` for internal dependencies and per-package `exports` so packages never rely on relative cross-package imports.
- Add a CI rule that fails if Worker-targeted packages import Node-only modules or undeclared dependencies.

**Performance Considerations:**
- Split CI into install, typecheck, lint, test, and build steps to localize cache misses and regressions quickly.
- Keep generated artifacts write-if-changed where possible so downstream package caches are not invalidated by no-op rewrites.

**Edge Cases:**
- Prevent package self-references from resolving to built output in one context and source in another.
- Make frozen-lockfile behavior part of CI from the first green baseline.

### Why Bun over pnpm / npm

Bun is chosen as the package manager — not the runtime. This distinction matters: Bun the package manager installs faster than pnpm and produces deterministic `bun.lock` files without the peer-dependency resolution complexity that has burned pnpm users on monorepos with heterogeneous targets (Node.js packages next to CF Workers packages). Bun workspaces are a first-class feature, not an afterthought.

The `isolated` linker mode (set in `bunfig.toml`) gives each package a clean `node_modules` with no hoisting surprises — the same isolation guarantee pnpm's `--strict-peer-dependencies` provides, but without pnpm's `peerDependencyRules` escape hatches. For this monorepo in particular, packages like `adapter-d1` have zero Node.js built-ins and must not accidentally resolve to a Node.js `node_modules` entry through hoisting.

pnpm would be a reasonable alternative. npm is disqualified by install speed and lockfile merge conflicts at scale. Yarn is disqualified by `yarn.lock` merge conflicts and the active deprecation of Classic. Bun is the only option that passes all three gates: speed, isolation, and active development in 2026.

### Why tsdown over tsup

tsup is Rollup-based. tsdown is esbuild + oxc-based and is the direct successor designed for the modern TypeScript ecosystem. The critical feature difference for this project: `isolatedDeclarations: true` support. `isolatedDeclarations` requires that every type exported from a package can be inferred from the declaration alone without cross-file type resolution — this is a hard requirement for fast distributed builds (it is what TypeScript's `--noEmitOnError` with `--isolatedModules` was building toward, completed in TypeScript 5.5).

tsdown's `mergeConfig` helper is a first-class API — there is no equivalent in tsup. tsup's `Options` type is not designed for inheritance, making shared base configs a copy-paste pattern prone to drift. With `mergeConfig`, the root `tsdown.config.base.ts` defines the invariants (output formats, declaration generation, source maps) and every package overrides only what differs (entry point, external packages).

tsup would have worked in 2024. tsdown is the correct choice for a greenfield project in 2026.

### Why OXC / oxlint over ESLint

ESLint is slow. On a monorepo with 15+ packages, `eslint src/` in each package sequentially blocks the `lint` Turborepo task from completing under 60 seconds on cold CI. oxlint runs the same checks in milliseconds because it is written in Rust. The Turborepo `lint` task caches its results against inputs — a cache hit is instant — but the cold cache run time matters for the first PR and for any developer touching many files.

The plugin surface is narrower: oxlint covers `correctness`, `typescript`, and `import` — the rules that catch real bugs. It does not cover style rules, which belong to formatters (Prettier, Biome). The intentional separation of concerns (linter = bugs, formatter = style) is cleaner than ESLint configs that mix both.

ESLint is the reasonable fallback if a rule is needed that oxlint does not yet implement. That is tracked in the backlog, not in the foundation plan.

### Why Vitest over Bun test

Bun test is fast. Vitest is an ecosystem. The specific gaps that Bun test cannot close in 2026: workspace mode with `defineProject` (Vitest supports per-package configs discovered by the root workspace runner), coverage reporting via `@vitest/coverage-v8` with LCOV output for CI coverage gates, and the `@vitest/browser` mode needed for admin SPA component tests. Vitest also has mature mocking (`vi.mock`, `vi.spyOn`, `vi.useFakeTimers`) tested against the patterns this codebase needs — Hono handler testing with fake environments, Drizzle mock adapters, and timer-based cache TTL tests.

Bun test would be fine for pure unit tests of pure functions. The moment the test suite needs coverage, browser mode, or complex module mocking, Vitest is the correct tool.

Vitest still runs under Bun as the package manager and can be run with `bun vitest` in the package scripts — Bun's speed advantage is retained for dependency resolution and test runner spawning even though Vitest provides the test API.

### Why Turborepo over Nx

Nx has more features: project graph visualization, affected computation, generators, executors, module boundaries. It also has more surface area, more configuration files, and more opinion about how a monorepo should be organized. For this project's 15-package scope with a simple dependency graph (config ← everything, core ← adapters ← nothing), Turborepo's `turbo.json` is 30 lines. An equivalent Nx setup is several hundred lines across multiple files.

Turborepo v2's `tasks` key (replacing `pipeline`) is the current API. Remote cache is available via `turbo login` + `turbo link` with no additional infrastructure. The `tui` UI mode provides per-package build output in a terminal dashboard.

Nx would be the correct choice at 50+ packages with complex affected-computation needs. At 15 packages with a clear dependency direction, Turborepo is correct.

---

## Implementation Units

---

### U1: Root Workspace Scaffold

**Goal:** Create the five root-level files that define the monorepo's package manager, task runner, linter config, and TypeScript resolver contract. Every other unit depends on these files existing.

**Requirements:**
- `package.json` must be `private: true` with `workspaces: ["apps/*", "packages/*"]` and `packageManager: "bun@1.2.x"`.
- `turbo.json` must use the v2 `tasks` key (not `pipeline`) with `"ui": "tui"`.
- `bunfig.toml` must set `linker = "isolated"` and `linkWorkspacePackages = true`.
- `.gitignore` must exclude: `node_modules`, `dist`, `coverage`, `.turbo`, `.env*`, `*.local`.

**Dependencies:** None. This is the first unit.

**Files:**

```
package.json
turbo.json
bunfig.toml
.gitignore
```

**Approach:**

#### `package.json`

```json
{
  "name": "hono-cms-monorepo",
  "private": true,
  "packageManager": "bun@1.2.15",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build":     "turbo run build",
    "dev":       "turbo run dev",
    "test":      "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint":      "turbo run lint",
    "clean":     "turbo run clean && rm -rf node_modules"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.8.0",
    "tsdown": "^0.12.0",
    "vitest": "^3.2.0",
    "oxlint": "^0.16.0"
  }
}
```

Key decisions:

- `"private": true` — prevents accidental root package publish. Bun enforces this when running `bun publish` from the root.
- `"packageManager": "bun@1.2.15"` — pins the exact Bun version for Corepack compatibility. CI will call `corepack enable && corepack prepare` to ensure the pinned version is used. The minor version should be updated when the monorepo is upgraded to a new Bun release.
- `workspaces` uses glob patterns: `"apps/*"` and `"packages/*"`. Do not use `"**"` — it would pick up nested `node_modules` packages on hoisted linkers. The `isolated` linker (set in `bunfig.toml`) prevents this but the glob scope is still narrowed intentionally.
- `devDependencies` at the root contains only the tools that run across all packages: `turbo`, `typescript`, `tsdown`, `vitest`, `oxlint`. Package-specific dependencies (`hono`, `drizzle-orm`, etc.) live in the individual package `package.json` files.
- The `clean` script removes all `dist` directories via Turborepo and then removes the root `node_modules`. This is the escape hatch for dependency resolution issues. It is not part of CI.

#### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "globalDependencies": [
    "tsconfig.base.json",
    ".oxlintrc.json"
  ],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": [
        "src/**/*.ts",
        "tsdown.config.ts",
        "package.json",
        "tsconfig.json"
      ],
      "outputs": ["dist/**"]
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"],
      "inputs": [
        "src/**/*.ts",
        "vitest.config.ts"
      ],
      "outputs": ["coverage/**"]
    },
    "test:watch": {
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^typecheck"],
      "inputs": [
        "src/**/*.ts",
        "tsconfig.json"
      ],
      "cache": true
    },
    "lint": {
      "dependsOn": [],
      "inputs": [
        "src/**/*.ts",
        ".oxlintrc.json"
      ],
      "cache": true
    },
    "clean": {
      "cache": false
    }
  }
}
```

Key decisions:

- `"ui": "tui"` — enables the terminal UI dashboard that shows per-package build output in real time. Disable with `--no-ui` when running in CI environments that do not support TTY (GitHub Actions does not; see U7 for the CI flag).
- `"globalDependencies"` — changes to `tsconfig.base.json` or `.oxlintrc.json` invalidate the entire graph cache. Without this, a TS config change would not retrigger builds.
- `"build": { "dependsOn": ["^build"] }` — the `^` prefix means "build all my dependencies first." If `core` depends on `schema`, Turborepo builds `schema` before `core`. This is the fundamental dependency graph resolution mechanism.
- `"build"` `inputs` lists the files whose content changes trigger a cache miss. `tsdown.config.ts` is included because changing the build config should retrigger the build even if `src/` did not change.
- `"dev": { "cache": false, "persistent": true }` — dev watchers should never be cached and must be kept alive. `dependsOn: ["^build"]` ensures all upstream packages are built before the dev watcher starts.
- `"test": { "dependsOn": ["^build"] }` — tests run against built packages, not source. This ensures that integration tests that import from `@hono-cms/schema` (for example) use the compiled output, not the TypeScript source, which would bypass the build step.
- `"test:watch"` has no `dependsOn` — watch mode should start immediately without waiting for a full build of dependencies. The developer is expected to have already run `turbo build` before entering watch mode.
- `"typecheck": { "dependsOn": ["^typecheck"] }` — type checking is ordered the same way as build: downstream packages must wait for upstream packages to be typechecked first, because downstream type errors often originate in upstream types.
- `"lint": { "dependsOn": [] }` — linting has no cross-package dependencies. oxlint only analyzes the current package's `src/` directory.
- `"outputs": ["dist/**"]` — tells Turborepo what to cache and restore. The `dist/` directory is restored from cache on a cache hit, skipping the entire build step.

#### `bunfig.toml`

```toml
# Bun package manager configuration
# https://bun.sh/docs/runtime/bunfig

[install]
# "isolated" creates a node_modules in each package, preventing hoisting.
# This matches pnpm's strict mode: packages can only import what they explicitly declare.
# Required for edge-runtime packages (adapter-d1, adapter-turso) that must not
# accidentally resolve Node.js-only transitive dependencies.
linker = "isolated"

# When a workspace package is required, link to the workspace source rather than
# resolving via the registry. Enables type-safe cross-package imports without
# publishing, and makes `import { createCMS } from '@hono-cms/core'` work in
# other packages during development.
linkWorkspacePackages = true

[install.cache]
# Enable the global Bun install cache for faster CI installs.
# CI will use --frozen-lockfile to prevent bun.lock modifications.
dir = "~/.bun/install/cache"
```

Key decisions:

- `linker = "isolated"` is the non-negotiable setting. The `adapter-d1` package must not accidentally import `pg` or any other Node.js TCP driver from a hoisted location. Without isolation, a developer running `bun add pg` in `adapter-postgres` could silently make `pg` resolvable from `adapter-d1` because of hoisting. Isolation makes that a hard import error.
- `linkWorkspacePackages = true` enables the pattern where `packages/core` has `"@hono-cms/schema": "workspace:*"` in its `dependencies`, and Bun creates a symlink to `packages/schema` rather than trying to install from the registry. This is equivalent to pnpm's `workspace:*` protocol.

#### `.gitignore`

```gitignore
# Dependencies
node_modules/

# Build outputs
dist/
.turbo/

# Test artifacts
coverage/

# Environment files (never commit secrets)
.env
.env.*
!.env.example

# Local overrides
*.local

# Editor / OS artifacts
.DS_Store
.vscode/settings.json
*.swp
*.swo

# Bun
bun.lockb

# TypeScript build info (per package)
*.tsbuildinfo
```

Note: `bun.lock` (the text lockfile introduced in Bun 1.1) is committed. `bun.lockb` (the binary lockfile from older Bun versions) is ignored. If the project was initialized with an older Bun version, run `bun install` with the pinned version to regenerate the text lockfile.

**Test scenarios:** Not applicable. These files are configuration, not code.

**Verification:**
- `bun install` completes without errors, producing a `bun.lock` file.
- `turbo run build` from an empty workspace (no packages yet) exits 0 with "No tasks found."
- `cat package.json | bun -e "const p = await Bun.file('/dev/stdin').json(); console.log(p.packageManager)"` prints the pinned Bun version.

---

### U2: Shared TypeScript Config

**Goal:** Establish a TypeScript configuration hierarchy that enforces strict mode, bundler module resolution, and isolated declarations across all packages — without requiring each package to repeat these settings.

**Requirements:**
- `tsconfig.base.json` at the repo root is the common ancestor of every package `tsconfig.json`.
- `packages/config/` is a workspace package (`@hono-cms/config`) that vends `tsconfig.lib.json` and `tsconfig.app.json` for packages and apps respectively.
- Every library package extends `@hono-cms/config/tsconfig.lib.json` (via the package's `exports` field).
- The admin SPA extends `@hono-cms/config/tsconfig.app.json`.
- `isolatedDeclarations: true` is set globally to enforce fast declaration emit compatibility.

**Dependencies:** U1 (root `package.json` must exist for workspace resolution to work).

**Files:**

```
tsconfig.base.json
packages/config/package.json
packages/config/tsconfig.json
packages/config/tsconfig.lib.json
packages/config/tsconfig.app.json
```

**Approach:**

#### `tsconfig.base.json` (repo root)

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "allowImportingTsExtensions": false,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "isolatedDeclarations": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "paths": {
      "@hono-cms/config":              ["./packages/config/src/index.ts"],
      "@hono-cms/core":                ["./packages/core/src/index.ts"],
      "@hono-cms/schema":              ["./packages/schema/src/index.ts"],
      "@hono-cms/cli":                 ["./packages/cli/src/index.ts"],
      "@hono-cms/adapter-d1":          ["./packages/adapter-d1/src/index.ts"],
      "@hono-cms/adapter-postgres":    ["./packages/adapter-postgres/src/index.ts"],
      "@hono-cms/adapter-turso":       ["./packages/adapter-turso/src/index.ts"],
      "@hono-cms/adapter-convex":      ["./packages/adapter-convex/src/index.ts"],
      "@hono-cms/storage-r2":          ["./packages/storage-r2/src/index.ts"],
      "@hono-cms/storage-s3":          ["./packages/storage-s3/src/index.ts"],
      "@hono-cms/storage-vercel-blob": ["./packages/storage-vercel-blob/src/index.ts"],
      "@hono-cms/storage-local":       ["./packages/storage-local/src/index.ts"],
      "@hono-cms/cache":               ["./packages/cache/src/index.ts"],
      "@hono-cms/jobs":                ["./packages/jobs/src/index.ts"]
    }
  }
}
```

Key decisions per field:

- `"target": "ES2022"` — All supported runtimes (CF Workers, Vercel Edge, Node 20+, Bun) support ES2022 natively. Using ES2022 avoids unnecessary downleveling by tsdown/esbuild and keeps output readable.
- `"module": "Preserve"` — Introduced in TypeScript 5.4. Tells the TypeScript type checker to preserve the module syntax as-is (ESM `import`/`export`) without transforming to CommonJS. The actual transformation to CJS is handled by tsdown's `format: ['esm', 'cjs']` option. This prevents a category of subtle bugs where TypeScript's CJS emit and a bundler's CJS emit disagree on interop semantics.
- `"moduleResolution": "Bundler"` — Resolves modules the way modern bundlers (esbuild, Vite, Rollup) do: extension-optional imports, `exports` field in `package.json`, `import` condition. This is the correct setting when the output is consumed by a bundler. Do not use `"Node16"` or `"NodeNext"` — those require explicit `.js` extensions on imports, which conflicts with the TypeScript-first DX we want.
- `"verbatimModuleSyntax": true` — Enforces that `import type` is used for type-only imports. This is required for compatibility with `isolatedModules` and prevents the class of bug where a type import with a side effect is accidentally included in the runtime output.
- `"isolatedModules": true` — Each file must be independently transpilable. This is a prerequisite for `isolatedDeclarations` and for tools like esbuild that transpile files in parallel without the full TypeScript compilation graph.
- `"isolatedDeclarations": true` — Each exported symbol's type must be explicitly annotatable from the declaration alone. Enforces that package authors write explicit return types on exported functions and do not rely on cross-file inference to produce declaration files. This is a hard requirement for tsdown's fast declaration emit path.
- `"noUncheckedIndexedAccess": true` — Array index access returns `T | undefined`, not `T`. This catches the majority of "Cannot read properties of undefined" runtime errors at compile time.
- `"exactOptionalPropertyTypes": true` — `{ foo?: string }` means `foo` can be absent, not that `foo` can be `undefined`. This closes a subtle hole in optional property typing.
- `"paths"` — Workspace package aliases pointing to `src/index.ts`. These allow tests and other packages to import `@hono-cms/core` during development and get the TypeScript source (not the compiled `dist/`) for better error messages and jump-to-definition. The paths map is in the base config so it applies everywhere without repetition. Each individual package `tsconfig.json` extends this base and inherits the paths automatically.

#### `packages/config/package.json`

```json
{
  "name": "@hono-cms/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./tsconfig.lib.json": "./tsconfig.lib.json",
    "./tsconfig.app.json": "./tsconfig.app.json",
    "./vitest.shared":     "./vitest.shared.ts"
  },
  "devDependencies": {
    "@hono-cms/config": "workspace:*"
  }
}
```

This package is `private: true` and has no build step — it is a pure config-vending package. The `exports` field exposes the three shared config files so other packages can extend them with `"extends": "@hono-cms/config/tsconfig.lib.json"`.

#### `packages/config/tsconfig.lib.json`

For library packages (all packages under `packages/` except `config` itself):

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declarationDir": "./dist"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- `"composite": true` — Required for TypeScript project references. Enables incremental builds where the TypeScript compiler skips re-checking unchanged packages.
- `"outDir": "./dist"` and `"declarationDir": "./dist"` — In practice, tsdown emits to `dist/` but `tsc --noEmit` (used for typechecking) also needs `outDir` set to avoid emitting into `src/`.
- `"rootDir": "./src"` — Enforces that all source files are under `src/`. Prevents accidental inclusion of test fixtures or config files in the declaration output.

#### `packages/config/tsconfig.app.json`

For app packages (`apps/admin`):

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "moduleDetection": "force",
    "noEmit": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- `"lib": ["ES2022", "DOM", "DOM.Iterable"]` — App configs add the DOM lib for browser APIs. Library packages must not include DOM — a library with DOM types would fail to compile in a CF Workers environment.
- `"jsx": "react-jsx"` and `"jsxImportSource": "react"` — Enables the React 18 automatic JSX transform. No `import React from 'react'` required in every file.
- `"noEmit": true` — App packages are built by Vite, not `tsc`. The TypeScript compiler is only used for type checking.

#### How packages extend these configs

Each library package `tsconfig.json` is minimal:

```json
{
  "extends": "@hono-cms/config/tsconfig.lib.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@hono-cms/schema": ["../schema/src/index.ts"]
    }
  }
}
```

Packages that have no intra-package path aliases omit `compilerOptions` entirely:

```json
{
  "extends": "@hono-cms/config/tsconfig.lib.json"
}
```

The `admin` app:

```json
{
  "extends": "@hono-cms/config/tsconfig.app.json"
}
```

**Test scenarios:** Not applicable. TypeScript config is validated by the `typecheck` Turborepo task, not a unit test suite.

**Verification:**
- `cd packages/core && tsc --noEmit` exits 0 on the stub `src/index.ts`.
- `cd apps/admin && tsc --noEmit` exits 0 on the stub `src/main.tsx`.
- `tsc -p tsconfig.base.json --showConfig` prints the resolved config with all expected compiler options.

---

### U3: Shared tsdown Base

**Goal:** Define a root `tsdown.config.base.ts` that all library packages inherit via `mergeConfig`. Ensure that every library package's `package.json` `exports` field follows the import/require convention that supports both ESM and CJS consumers.

**Requirements:**
- Root `tsdown.config.base.ts` exports a `baseConfig` object usable with `mergeConfig`.
- Every library package has a `tsdown.config.ts` that calls `mergeConfig(baseConfig, { ... })`.
- `package.json` `exports` field uses import/require conditions.
- All packages output to `dist/` with both ESM and CJS formats.
- Declaration files (`*.d.ts`) are emitted via `dts: true`.

**Dependencies:** U1 (root `package.json`), U2 (`tsconfig.base.json`).

**Files:**

```
tsdown.config.base.ts
packages/core/tsdown.config.ts
packages/core/package.json         (exports field example)
```

**Approach:**

#### `tsdown.config.base.ts` (repo root)

```typescript
import { defineConfig, type Options } from 'tsdown'

/**
 * Base tsdown configuration shared by all library packages.
 * Per-package configs extend this via mergeConfig.
 *
 * Usage in packages/*/tsdown.config.ts:
 *   import { mergeConfig } from 'tsdown'
 *   import { baseConfig } from '../../tsdown.config.base.ts'
 *   export default mergeConfig(baseConfig, { entry: ['src/index.ts'] })
 */
export const baseConfig: Options = {
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  outDir: 'dist',
  target: 'es2022',
  platform: 'neutral',

  // isolatedDeclarations requires TypeScript 5.5+.
  // When true, tsdown emits declaration files using a fast isolated path
  // that does not require the full type checker — same guarantee as tsc but faster.
  isolatedDeclarations: true,

  // Do not bundle: each package is individually installable.
  // Consumers bundle via their own build tool (Vite, esbuild, wrangler).
  // External packages are declared per-package via the `external` override.
  external: [/^@hono-cms\//],
}
```

Key decisions:

- `format: ['esm', 'cjs']` — Library packages ship both. ESM is consumed by Vite, Bun, CF Workers, and modern Node.js. CJS is required by older Node.js test runners, some Jest-based tooling, and any consumer that has not yet adopted `"type": "module"` in their project.
- `platform: 'neutral'` — Do not assume Node.js globals. `platform: 'neutral'` prevents esbuild from injecting `process`, `__dirname`, or `Buffer` polyfills that would break CF Workers. Packages that require Node.js globals (e.g., `storage-local`) override this with `platform: 'node'` in their per-package config.
- `external: [/^@hono-cms\//]` — Workspace packages are never bundled into each other. `@hono-cms/core` importing `@hono-cms/schema` keeps that import as an external reference. The consumer's bundler resolves it at application build time.
- `treeshake: true` — Enables dead code elimination per-format. This matters most for adapters: `adapter-d1` imports only the D1-specific Drizzle dialect; after tree-shaking, there are no references to `pg` or `libsql` in the output.
- `isolatedDeclarations: true` — The tsdown-level flag that enables the fast declaration path. This must match the `tsconfig.base.json` compiler option of the same name.

#### Per-package `tsdown.config.ts` — library package

```typescript
// packages/core/tsdown.config.ts
import { mergeConfig } from 'tsdown'
import { baseConfig } from '../../tsdown.config.base.ts'

export default mergeConfig(baseConfig, {
  entry: ['src/index.ts'],
  // Override platform if this package uses Node.js built-ins:
  // platform: 'node',
  //
  // Add package-specific externals beyond workspace packages:
  // external: ['hono', 'drizzle-orm'],
})
```

The `mergeConfig` function performs a deep merge, not an override. Arrays (like `external`) are concatenated. Scalar values from the override replace the base. This is the key advantage over tsup's lack of a merge API.

#### `package.json` exports field convention

Every library package follows this exports convention:

```json
{
  "name": "@hono-cms/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build":     "tsdown",
    "dev":       "tsdown --watch",
    "typecheck": "tsc --noEmit",
    "lint":      "oxlint src/",
    "test":      "vitest run",
    "test:watch": "vitest"
  }
}
```

Field-by-field justification:

- `"type": "module"` — The package source is ESM. tsdown emits `dist/index.js` (ESM) and `dist/index.cjs` (CJS). The `.cjs` extension avoids the Node.js `"type": "module"` + `.js` extension ambiguity for CJS output.
- `"main": "./dist/index.cjs"` — Legacy field for CJS consumers that do not read `exports`. Keep for maximum compatibility.
- `"module": "./dist/index.js"` — Legacy field read by some older bundlers (Rollup 2.x, some Webpack configs) to prefer the ESM output. Not part of the Node.js resolution spec but broadly supported.
- `"types": "./dist/index.d.ts"` — Legacy field for TypeScript consumers that do not read `exports` conditions.
- `"exports"` — The authoritative field for modern consumers. Two conditions: `import` (ESM) and `require` (CJS). Each condition has a `types` entry (the `.d.ts` or `.d.cts` file) and a `default` entry (the runtime file). TypeScript 5.0+ reads the `types` condition when `moduleResolution: "Bundler"` or `"Node16"` is set.
- `"files": ["dist"]` — Only the `dist/` directory is included when the package is published. `src/`, `tsconfig.json`, `vitest.config.ts`, etc. are excluded from the npm tarball.

**Test scenarios:** Not applicable for the config itself. Verified by building a stub package and inspecting the output.

**Verification:**
- `cd packages/core && bun run build` produces `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`, `dist/index.d.cts`.
- `node -e "const { } = require('@hono-cms/core')"` resolves via CJS path.
- `node --input-type=module -e "import '@hono-cms/core'"` resolves via ESM path.
- `turbo run build` builds all packages in dependency order with correct task output caching.

---

### U4: OXC Lint Config

**Goal:** Configure oxlint with a root ruleset that catches real bugs (not style issues), with per-package overrides for React and Node.js contexts.

**Requirements:**
- Root `.oxlintrc.json` enables `correctness: error` and `typescript` + `import` plugins.
- React packages (`apps/admin`) override with the `react` plugin.
- Node.js packages (`storage-local`, `cli`) override with Node.js-specific rules.
- `lint` script in every package is `oxlint src/`.

**Dependencies:** U1 (root `package.json` for `oxlint` devDependency).

**Files:**

```
.oxlintrc.json
apps/admin/.oxlintrc.json
packages/cli/.oxlintrc.json
packages/storage-local/.oxlintrc.json
```

**Approach:**

#### Root `.oxlintrc.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "plugins": ["typescript", "import"],
  "rules": {
    "correctness": "error",
    "typescript/no-explicit-any": "error",
    "typescript/consistent-type-imports": [
      "error",
      { "prefer": "type-imports", "fixStyle": "inline-type-imports" }
    ],
    "import/no-duplicates": "error",
    "import/no-cycle": "error",
    "no-console": "warn",
    "no-debugger": "error",
    "eqeqeq": ["error", "always"]
  },
  "ignorePatterns": [
    "dist/",
    "node_modules/",
    "coverage/",
    "**/*.d.ts"
  ]
}
```

Key decisions:

- `"plugins": ["typescript", "import"]` — These two plugins cover: type-incorrect code (`typescript`), import cycles and duplicates (`import`). The `correctness` rule category covers the full oxlint correctness ruleset (undefined variables, unreachable code, incorrect hook usage if react plugin is added, etc.).
- `"typescript/consistent-type-imports"` — Enforces `import type { Foo }` for type-only imports. This is required by `verbatimModuleSyntax: true` in the TypeScript config — the two configs are aligned.
- `"import/no-cycle"` — Circular imports between workspace packages would create a dependency cycle that Turborepo cannot resolve (it would detect it as a cycle in the task graph). Enforcing no cycles at the lint level catches this before it reaches the build step.
- `"no-console": "warn"` — Not an error because `packages/cli` and debug utilities legitimately use `console`. Production packages will have this escalated to `"error"` in their per-package override.

#### React package override — `apps/admin/.oxlintrc.json`

```json
{
  "extends": ["../../.oxlintrc.json"],
  "plugins": ["typescript", "import", "react", "react-hooks"],
  "env": { "browser": true },
  "rules": {
    "react/jsx-key": "error",
    "react/no-danger": "error",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "no-console": "error"
  }
}
```

The React rules catch: missing `key` props in lists, dangerous `dangerouslySetInnerHTML` usage, hooks called outside components, and missing `useEffect` dependencies. These are the rules that catch real React bugs — oxlint's React plugin covers them without ESLint.

#### Node.js package override — `packages/cli/.oxlintrc.json`

```json
{
  "extends": ["../../.oxlintrc.json"],
  "env": { "node": true },
  "rules": {
    "no-console": "off",
    "no-process-env": "off"
  }
}
```

CLI packages are Node.js-only and legitimately use `console` and `process.env`. The override explicitly turns these warnings off so the lint output is not polluted with expected patterns.

#### Lint script pattern

Every package's `package.json` includes:

```json
{
  "scripts": {
    "lint": "oxlint src/"
  }
}
```

The scope `src/` ensures only source files are linted, not `dist/`, `node_modules/`, or config files. Config files (`.ts` build configs) are excluded from linting — they use patterns (like `export default`) that are not present in the project's source convention.

**Test scenarios:** Not applicable. Lint is verified by running oxlint and checking the exit code.

**Verification:**
- `oxlint src/` in an empty `packages/core/src/` exits 0.
- Introducing `import { Foo } from './foo'` (non-type import of a type) in a stub file produces an `typescript/consistent-type-imports` error.
- `turbo run lint` runs across all packages in parallel (no `dependsOn`) and exits 0.

---

### U5: Shared Vitest Config

**Goal:** Configure Vitest in workspace mode with a shared base config, per-package `vitest.config.ts` files using `defineProject`, and a root workspace runner that discovers all project configs.

**Requirements:**
- `packages/config/vitest.shared.ts` defines the shared base (environment, coverage provider, globals).
- Every package has a `vitest.config.ts` using `defineProject` that extends the shared base.
- Root `vitest.config.ts` uses `defineWorkspace` to discover all per-package configs.
- Coverage is collected via `@vitest/coverage-v8` and output as LCOV for CI.

**Dependencies:** U1, U2 (for `@hono-cms/config` package resolution).

**Files:**

```
vitest.config.ts                       (root workspace runner)
packages/config/vitest.shared.ts
packages/core/vitest.config.ts
packages/schema/vitest.config.ts
apps/admin/vitest.config.ts
```

**Approach:**

#### `packages/config/vitest.shared.ts`

```typescript
import { type UserConfig } from 'vitest/config'

/**
 * Shared Vitest base configuration for all packages in the monorepo.
 * Per-package vitest.config.ts files import this and extend via mergeConfig.
 *
 * This is NOT a complete config — it must be used with defineProject.
 * Shared options only. Do not add `test.include` or `test.environment` here
 * without considering whether every package wants the same value.
 */
export const vitestSharedConfig: UserConfig['test'] = {
  globals: true,
  clearMocks: true,
  restoreMocks: true,
  coverage: {
    provider: 'v8',
    reporter: ['text', 'lcov'],
    reportsDirectory: './coverage',
    exclude: [
      'node_modules/',
      'dist/',
      '*.config.ts',
      '**/*.d.ts',
    ],
  },
  // Test file discovery pattern. Applied per-package in defineProject.
  include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
  exclude: ['node_modules', 'dist'],
}
```

Key decisions:

- `globals: true` — Makes `describe`, `it`, `expect`, `vi` available without importing. This is a DX choice for a team project. For library packages that might be published and tested by external contributors, explicit imports are safer — but this project is an internal monorepo where the convention is consistent.
- `clearMocks: true` and `restoreMocks: true` — Automatically clear mock state and restore original implementations between tests. Prevents the class of flaky test where a `vi.mock` from test A leaks into test B because teardown was forgotten.
- `coverage.provider: 'v8'` — Uses Node.js's built-in V8 coverage instead of Istanbul (Babel instrumentation). V8 coverage is more accurate for ESM code and does not require a Babel transform step.
- `coverage.reporter: ['text', 'lcov']` — `text` for terminal output, `lcov` for CI coverage upload to Codecov or similar.

#### Per-package `vitest.config.ts` — library package

```typescript
// packages/core/vitest.config.ts
import { defineProject, mergeConfig } from 'vitest/config'
import { vitestSharedConfig } from '@hono-cms/config/vitest.shared'

export default defineProject(
  mergeConfig(
    { test: vitestSharedConfig },
    {
      test: {
        name: 'core',
        environment: 'node',
      },
    }
  )
)
```

- `defineProject` — Marks this config as a workspace project rather than a standalone Vitest root. Required for workspace mode discovery.
- `test.name: 'core'` — The project name appears in the TUI output, making it clear which package a failing test belongs to.
- `test.environment: 'node'` — Library packages run in a Node.js-like environment. The admin SPA tests use `'jsdom'` instead.

#### Per-package `vitest.config.ts` — React app

```typescript
// apps/admin/vitest.config.ts
import { defineProject, mergeConfig } from 'vitest/config'
import { vitestSharedConfig } from '@hono-cms/config/vitest.shared'
import react from '@vitejs/plugin-react'

export default defineProject(
  mergeConfig(
    { test: vitestSharedConfig },
    {
      plugins: [react()],
      test: {
        name: 'admin',
        environment: 'jsdom',
        setupFiles: ['./src/test-setup.ts'],
      },
    }
  )
)
```

The `setupFiles` entry points to `apps/admin/src/test-setup.ts`, which imports `@testing-library/jest-dom` to extend Vitest's `expect` with DOM matchers (`toBeInTheDocument`, `toHaveClass`, etc.).

#### Root `vitest.config.ts`

```typescript
// vitest.config.ts (repo root)
import { defineWorkspace } from 'vitest/config'

/**
 * Root Vitest workspace config.
 * Discovers all per-package vitest.config.ts files.
 * Run from the repo root: vitest run  (or: turbo run test)
 */
export default defineWorkspace([
  // Library packages
  'packages/*/vitest.config.ts',
  // Applications
  'apps/*/vitest.config.ts',
])
```

The glob patterns discover every package's `vitest.config.ts` without needing to enumerate them. New packages created by the scaffold script (U6) are automatically discovered.

Running `vitest run` from the root executes all project configs in parallel. Running `vitest run --project core` executes only the `@hono-cms/core` project. Running `vitest --watch` in the root watches all packages; running `vitest --watch` inside a single package watches only that package.

#### Integration with Turborepo

The `test` task in `turbo.json` runs `vitest run` (not `vitest`) — the `run` subcommand exits after all tests pass rather than entering watch mode. The `test:watch` task runs `vitest` (with watch mode) and is marked `"cache": false, "persistent": true`.

Coverage output (`coverage/`) is in the `turbo.json` `outputs` for the `test` task so that Turborepo can restore it from cache on a cache hit. The LCOV file at `coverage/lcov.info` is what CI uploads to coverage services.

**Test scenarios:** Validated by running the shared config's own test — a trivial test that `1 + 1 === 2` in each package stub, ensuring the config resolution works end-to-end.

**Verification:**
- `vitest run` from repo root exits 0 (stub tests pass across all packages).
- `vitest run --project core` runs only `packages/core` tests.
- `vitest run --coverage` produces `coverage/lcov.info` in each package.
- `turbo run test` exits 0 and shows cache restoration on a second run.

---

### U6: Package Scaffold Script

**Goal:** Provide a Bun script that creates a new `packages/<name>/` with all required boilerplate in a single command.

**Requirements:**
- Run with `bun run scripts/scaffold-package.ts <name>`.
- Creates: `package.json`, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts`, `src/index.ts`.
- Fails with a descriptive error if the package already exists.
- Accepts an optional `--platform` flag (`neutral` | `node`) to set the tsdown platform.
- Accepts an optional `--no-build` flag to omit tsdown config (for config-only packages like `packages/config`).
- Prints the list of created files and the next step (`bun install` to link the new package).

**Dependencies:** U1–U5 (all config files must exist to generate correct references in the scaffolded package).

**Files:**

```
scripts/scaffold-package.ts
```

**Approach:**

```typescript
// scripts/scaffold-package.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: bun run scripts/scaffold-package.ts <name> [--platform node|neutral] [--no-build]')
  process.exit(1)
}

const name = args[0]
if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`Error: package name "${name}" must be lowercase alphanumeric with hyphens, starting with a letter.`)
  process.exit(1)
}

const platform = args.includes('--platform')
  ? args[args.indexOf('--platform') + 1] ?? 'neutral'
  : 'neutral'

if (platform !== 'neutral' && platform !== 'node') {
  console.error(`Error: --platform must be "neutral" or "node", got "${platform}"`)
  process.exit(1)
}

const noBuild = args.includes('--no-build')

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const repoRoot = new URL('..', import.meta.url).pathname
const pkgDir = join(repoRoot, 'packages', name)
const srcDir = join(pkgDir, 'src')
const scopedName = `@hono-cms/${name}`

if (existsSync(pkgDir)) {
  console.error(`Error: package directory already exists: ${pkgDir}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

const packageJson = JSON.stringify(
  {
    name: scopedName,
    version: '0.0.0',
    private: false,
    type: 'module',
    main: './dist/index.cjs',
    module: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        import: { types: './dist/index.d.ts', default: './dist/index.js' },
        require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
      },
    },
    files: ['dist'],
    scripts: {
      build:        noBuild ? 'echo "no-build package"' : 'tsdown',
      dev:          noBuild ? 'echo "no-build package"' : 'tsdown --watch',
      typecheck:    'tsc --noEmit',
      lint:         'oxlint src/',
      test:         'vitest run',
      'test:watch': 'vitest',
    },
    dependencies: {},
    devDependencies: {
      '@hono-cms/config': 'workspace:*',
    },
  },
  null,
  2
)

const tsconfigJson = JSON.stringify(
  { extends: '@hono-cms/config/tsconfig.lib.json' },
  null,
  2
)

const tsdownConfig = noBuild
  ? null
  : `import { mergeConfig } from 'tsdown'
import { baseConfig } from '../../tsdown.config.base.ts'

export default mergeConfig(baseConfig, {
  entry: ['src/index.ts'],
  platform: '${platform}',
})
`

const vitestConfig = `import { defineProject, mergeConfig } from 'vitest/config'
import { vitestSharedConfig } from '@hono-cms/config/vitest.shared'

export default defineProject(
  mergeConfig(
    { test: vitestSharedConfig },
    {
      test: {
        name: '${name}',
        environment: 'node',
      },
    }
  )
)
`

const srcIndex = `// @hono-cms/${name}
// TODO: implement this package

export const placeholder = '${name}'
`

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

const files: Array<[string, string]> = [
  [join(pkgDir, 'package.json'), packageJson],
  [join(pkgDir, 'tsconfig.json'), tsconfigJson],
  [join(pkgDir, 'vitest.config.ts'), vitestConfig],
  [join(srcDir, 'index.ts'), srcIndex],
]

if (tsdownConfig) {
  files.push([join(pkgDir, 'tsdown.config.ts'), tsdownConfig])
}

mkdirSync(srcDir, { recursive: true })

for (const [filePath, content] of files) {
  writeFileSync(filePath, content, 'utf8')
  console.log(`  created: ${filePath.replace(repoRoot, '.')}`)
}

console.log(`
Package @hono-cms/${name} scaffolded at packages/${name}/

Next steps:
  1. bun install          — link the new workspace package
  2. Add dependencies to packages/${name}/package.json
  3. Implement src/index.ts
  4. Run: turbo run build --filter=${scopedName}
`)
```

Key decisions:

- Uses `node:fs` and `node:path` directly — no external dependencies on a script that must run before `bun install` has been run for the first time.
- `import.meta.url` is used to resolve the repo root relative to the script file — robust regardless of the working directory from which the script is invoked.
- Name validation (`/^[a-z][a-z0-9-]*$/`) prevents package names that would be invalid npm scope names.
- The script writes `'@hono-cms/config': 'workspace:*'` as a devDependency automatically — every new package gets access to the shared tsconfig, tsdown base, and vitest shared config without a manual step.
- The `--no-build` flag handles the `packages/config` case where no tsdown config is needed. When scaffolding `packages/config` itself, pass `--no-build` and manually fill in the `exports` field afterward.

**Test scenarios:**

- Run `bun run scripts/scaffold-package.ts test-pkg` and verify all five files are created with correct content.
- Run the command again with the same name and verify it exits non-zero with a "directory already exists" error.
- Run with `--platform node` and verify `tsdown.config.ts` contains `platform: 'node'`.
- Run with `--no-build` and verify no `tsdown.config.ts` is created.

**Verification:**
- Script exits 0 for a new package name.
- `bun install` after scaffolding links the new package.
- `turbo run build --filter=@hono-cms/test-pkg` succeeds.
- Manually delete `packages/test-pkg/` after verification.

---

### U7: CI Pipeline Skeleton

**Goal:** Configure a GitHub Actions workflow that runs on every PR: installs dependencies, builds all packages in dependency order, typechecks, lints, and tests. Caches both Bun install and Turborepo remote cache for fast subsequent runs.

**Requirements:**
- Triggered on `pull_request` to `main` and `develop`, and on `push` to `main` and `develop`.
- Uses the Bun version pinned in `package.json`.
- Runs `bun install --frozen-lockfile` — never modifies `bun.lock` in CI.
- Runs `turbo run build typecheck lint test` in a single Turborepo invocation.
- Caches Bun install dependencies via `actions/cache`.
- Uses Turborepo remote cache via `TURBO_TOKEN` and `TURBO_TEAM` secrets.
- Disables the Turborepo TUI (`--no-ui`) for CI environments.

**Dependencies:** U1–U6 (all workspace packages must exist for Turborepo to resolve the task graph).

**Files:**

```
.github/workflows/ci.yml
```

**Approach:**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main, develop]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  # Turborepo remote cache credentials.
  # Set these in GitHub repo Settings → Secrets and variables → Actions.
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM:  ${{ secrets.TURBO_TEAM }}
  # Disable Turborepo's TUI — GitHub Actions runners do not have a TTY.
  TURBO_UI: false

jobs:
  ci:
    name: Build, typecheck, lint, test
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      # -----------------------------------------------------------------------
      # 1. Checkout
      # -----------------------------------------------------------------------
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 2  # Turborepo needs at least 2 commits for affected computation

      # -----------------------------------------------------------------------
      # 2. Setup Bun — use the version pinned in package.json
      # -----------------------------------------------------------------------
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: package.json

      # -----------------------------------------------------------------------
      # 3. Cache Bun install
      # The Bun global cache stores downloaded tarballs. Keyed on bun.lock.
      # Cache miss restores from a lockfile-prefix fallback.
      # -----------------------------------------------------------------------
      - name: Cache Bun dependencies
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}
          restore-keys: |
            ${{ runner.os }}-bun-

      # -----------------------------------------------------------------------
      # 4. Install dependencies
      # --frozen-lockfile: fail if bun.lock would be modified (protects against
      # packages added locally but not committed).
      # -----------------------------------------------------------------------
      - name: Install dependencies
        run: bun install --frozen-lockfile

      # -----------------------------------------------------------------------
      # 5. Run Turborepo tasks
      # build, typecheck, lint, and test are run in a single turbo invocation.
      # Turborepo resolves the task graph (e.g., build before test) internally.
      # Remote cache: Turborepo checks TURBO_TOKEN + TURBO_TEAM and reads/writes
      # the remote cache for unchanged packages — packages with no changed inputs
      # are skipped entirely, restoring their outputs from the remote cache.
      # -----------------------------------------------------------------------
      - name: Run CI tasks
        run: |
          bun run turbo run build typecheck lint test \
            --no-ui \
            --log-order=grouped \
            --output-logs=new-only

      # -----------------------------------------------------------------------
      # 6. Upload coverage report (optional — enable when Codecov token is set)
      # -----------------------------------------------------------------------
      - name: Upload coverage
        if: always()
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          files: '**/coverage/lcov.info'
          fail_ci_if_error: false
```

Key decisions:

- `concurrency.cancel-in-progress: true` — When a new push arrives on the same branch, cancel the in-progress CI run. This prevents queue buildup and wasted runner minutes on superseded commits.
- `fetch-depth: 2` — Turborepo's `--affected` flag (for future use) requires at least 2 commits to compute which packages changed since the base ref. Without this, `actions/checkout` checks out a shallow clone with depth 1, breaking affected computation.
- `oven-sh/setup-bun@v2` with `bun-version-file: package.json` — Reads the `packageManager` field in `package.json` to determine the Bun version to install. This is the single source of truth for the Bun version — not duplicated in the CI file.
- `~/.bun/install/cache` is the correct cache path for the Bun global tarball cache. Keyed on `bun.lock` content hash — a lockfile change invalidates the cache and forces a full re-download, which is correct behavior.
- `--frozen-lockfile` — Fails the CI run if `bun.lock` would have been modified by `bun install`. This catches the case where a developer added a package locally but forgot to commit the updated lockfile.
- Single `turbo run build typecheck lint test` invocation — Turborepo resolves the task graph across all four tasks in one run. It knows that `test` depends on `^build`, so it builds packages in the correct order before testing. This is more efficient than running four separate `turbo run` commands, which would require four separate graph traversals.
- `--no-ui` — Disables the TUI (terminal UI) dashboard. GitHub Actions log output is line-buffered, not TTY — the TUI renders garbage in non-TTY contexts. `--log-order=grouped` groups all log lines per package, making the Actions log readable.
- `--output-logs=new-only` — Only prints log output for tasks that ran (cache miss). Cached tasks are shown as `[cache hit]` without repeating their log output, keeping CI logs concise.
- `TURBO_TOKEN` and `TURBO_TEAM` in the environment — Turborepo reads these to authenticate with the Vercel remote cache (or a self-hosted Turborepo Remote Cache). They are set as GitHub repository secrets. When absent, Turborepo falls back to local disk cache only — CI will still work, just slower.
- `timeout-minutes: 15` — Hard stop for runaway CI. A full cold build of all 14 packages should complete in 3–5 minutes with the Bun cache warm. 15 minutes is generous headroom for the first cold run.

#### Remote cache setup (performed once, not automated)

```bash
# From the repo root, after bun install:
bunx turbo login    # Authenticates with Vercel Turborepo remote cache
bunx turbo link     # Links this repo to the remote cache team/project

# Adds TURBO_TOKEN and TURBO_TEAM to .turbo/config.json (not committed — in .gitignore)
# These same values must be added to GitHub repo secrets for CI to use the remote cache.
```

The `.turbo/` directory is added to `.gitignore`. The remote cache token is never committed.

**Test scenarios:**

- Open a PR with a one-line change to `packages/core/src/index.ts` and verify: only `core` and its dependents are rebuilt; `schema`, `cli`, and all adapters are restored from the remote cache.
- Break a type in `packages/schema/src/index.ts` and verify the `typecheck` task fails and the CI job exits non-zero.
- Add a `console.log()` in `packages/core/src/index.ts` and verify oxlint reports a warning (which does not fail CI unless escalated to error by per-package override).

**Verification:**
- First CI run on an empty remote cache completes in under 10 minutes.
- Second CI run on the same branch with no code changes completes in under 60 seconds (all tasks hit remote cache).
- `bun install --frozen-lockfile` fails in CI if `bun.lock` is out of date.

---

## Cross-cutting Concerns

### Dependency graph rule

The monorepo has a strict dependency direction:

```
config (no deps)
  ↑
schema (depends on: config)
  ↑
core (depends on: config, schema)
  ↑
adapters (depends on: config, schema, core)
  ↑
storage packages (depends on: config, schema, core)
  ↑
cache, jobs (depends on: config, schema, core)
  ↑
cli (depends on: config, schema, core, adapters, storage, cache, jobs)
  ↑
admin (depends on: config; talks to core via HTTP, not import)
```

The `import/no-cycle` oxlint rule enforces this at the file level within each package. Cross-package cycles would appear as Turborepo task graph cycles, which Turborepo detects and reports as an error. There must be no circular imports between workspace packages.

### `workspace:*` protocol

All cross-workspace dependencies use `workspace:*` in `package.json`. Bun resolves this to the workspace package's current `version` field in the lockfile. During development, Bun creates a symlink. When publishing, Bun replaces `workspace:*` with the actual resolved version. This means packages can be published independently without any pre-publish version pinning step.

### `bun.lock` committed, `bun.lockb` excluded

The text-based `bun.lock` (introduced in Bun 1.1) is committed to git. It is human-readable and produces clean diffs when dependencies change. The binary `bun.lockb` is excluded by `.gitignore`. If a developer has an older Bun version that produces `bun.lockb`, the fix is to upgrade Bun to the pinned version via `corepack`.

### Version pinning policy

- `turbo`, `typescript`, `tsdown`, `vitest`, `oxlint` in the root `devDependencies` use `^` semver ranges — patch and minor updates are accepted automatically.
- The `packageManager` field pins Bun to an exact version — intentional, because Bun minor versions can change installer behavior.
- Per-package runtime dependencies (`hono`, `drizzle-orm`, `better-auth`) use `^` ranges. Lock file pins the exact installed version.
- The lock file is the source of truth for reproducibility. Version ranges define the upgrade policy; the lock file enforces the current state.

---

## Completion Checklist

Before marking this plan complete and beginning Plan 002:

- [ ] U1: `bun install` produces a `bun.lock` without errors.
- [ ] U1: `turbo run build` with stub packages exits 0.
- [ ] U2: `tsc --noEmit` exits 0 in every package (stub source files).
- [ ] U2: `packages/config/tsconfig.lib.json` and `tsconfig.app.json` extend `tsconfig.base.json` correctly.
- [ ] U3: `turbo run build` produces `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`, `dist/index.d.cts` in every library package.
- [ ] U3: CJS and ESM entry points resolve correctly via `node -e` and `node --input-type=module`.
- [ ] U4: `turbo run lint` exits 0 across all packages.
- [ ] U4: Introducing a cycle or non-type import of a type triggers the expected oxlint error.
- [ ] U5: `vitest run` from the repo root exits 0 (stub tests pass).
- [ ] U5: `vitest run --project core` executes only the `core` package tests.
- [ ] U5: Coverage LCOV files are produced at `packages/*/coverage/lcov.info`.
- [ ] U6: `bun run scripts/scaffold-package.ts test-new` creates all expected files.
- [ ] U6: Running the scaffold script twice with the same name exits non-zero.
- [ ] U6: `turbo run build --filter=@hono-cms/test-new` succeeds for the scaffolded package.
- [ ] U7: First CI run on a new PR branch completes under 10 minutes.
- [ ] U7: Second CI run on the same branch (no code changes) completes under 60 seconds.
- [ ] U7: Breaking a type in any package causes the CI `typecheck` task to fail.
- [ ] U7: `bun install --frozen-lockfile` fails if `bun.lock` is not committed.

---

## What This Plan Does Not Cover

The following are explicitly deferred to subsequent plans:

- **Plan 002** — `@hono-cms/schema`: `defineCollection`, field types, Zod integration, relation declarations.
- **Plan 003** — `@hono-cms/core`: `createCMS` factory, Hono app composition, `cms.fetch`, `Object.assign` return type.
- **Plan 004** — `@hono-cms/adapter-d1`: Drizzle D1 adapter implementation.
- **Plan 005** — `@hono-cms/adapter-postgres`, `adapter-turso`, `adapter-convex`: remaining DB adapters.
- **Plan 006** — `@hono-cms/storage-*`: storage adapter interface and implementations.
- **Plan 007** — `@hono-cms/cache`: Upstash, KV, memory cache adapter.
- **Plan 008** — `@hono-cms/jobs`: QStash, Vercel, Cloudflare cron providers.
- **Plan 009** — better-auth integration inside `createCMS`.
- **Plan 010** — Schema-level RBAC and permission middleware.
- **Plan 011** — Content query API (filter syntax, cursor pagination, populate).
- **Plan 012** — Draft/publish lifecycle.
- **Plan 013** — Webhook system (UI-managed + static config).
- **Plan 014** — Auto-generated typed SDK on schema change.
- **Plan 015** — Admin SPA (`@hono-cms/admin-spa`): TanStack + Jotai stack.
- **Plan 016** — OpenAPI spec generation + Scalar docs UI.
- **Plan 017** — `@hono-cms/cli`: `cms dev`, `cms schema plan/apply/check`, `cms deploy`.
- **Plan 018** — AI-powered i18n (Vercel AI SDK integration).
