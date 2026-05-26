---
title: Implementation Audit Gap Matrix for Hono CMS Architecture Plans
date: 2026-05-22
category: docs/solutions/documentation-gaps/
module: hono-cms
problem_type: documentation_gap
component: documentation
severity: medium
applies_when:
  - A project has architecture plan files that may have diverged from actual implementation
  - You need to systematically cross-reference spec documents against source code
  - Multiple packages or sub-projects require a unified implementation status overview
tags:
  - audit
  - gap-analysis
  - architecture
  - hono-cms
  - implementation-status
  - headless-cms
---

# Implementation Audit Gap Matrix for Hono CMS Architecture Plans

## Context

The Hono CMS project accumulated 18 detailed plan files in `docs/plans/`, each broken into numbered Implementation Units (IUs) — specific, verifiable deliverables. The existing `docs/implementation-status-check.md` tracked completion at the plan level ("Plan 013: done") but never verified individual IUs against source. This meant gaps could hide behind a "complete" label: a plan could be 80% implemented with one critical IU missing, yet appear green in status tracking. No requirement-by-requirement audit existed until one was run systematically.

The trigger was a code review request that explicitly asked to "check the plans on what's implemented and what isn't implemented — don't cut corners cause this is critical implementation." The answer required reading all 18 plan files and cross-referencing every IU against actual source files.

## Guidance

**Step 1 — Inventory the plan corpus.**
Read every file in `docs/plans/`. Extract each IU verbatim with its number and parent plan. Note the IU's expected artifact: a class, a factory function, a CLI flag, a registered route, a config field, etc.

**Step 2 — Locate the source artifact.**
For each IU, search the actual codebase for the expected artifact. Prefer line-number references when confirming presence (e.g., `packages/core/src/content/populate.ts:6` for `MAX_POPULATE_DEPTH=3`). For this monorepo, check:

- `packages/core/src/` — domain logic, stores, route handlers, and providers
- `packages/schema/src/` — Zod schemas, type exports, Drizzle generator
- `packages/jobs/src/` — background job adapters and handlers
- `packages/cli/src/` — CLI commands, watcher logic, and deploy templates
- `apps/admin/src/` — UI routes, form components, and admin views

**Step 3 — Classify each IU into one of four states.**

| State | Meaning |
|-------|---------|
| `[x]` Implemented as specified | Artifact exists, matches the IU description, uses the specified library or pattern |
| `[~]` Functionally implemented, diverges from spec | Feature works but uses a different approach than the plan called for (e.g., `fs.watch` instead of `chokidar`, custom arg parsing instead of `citty`). Note both expectation and actuality. |
| `[~]` Partially implemented | Core exists but one or more sub-requirements are missing (e.g., interface declared but no concrete DB-backed implementation) |
| `[ ]` Not implemented | No source artifact exists for this IU |

**Step 4 — Prioritize gaps by production impact.**

- **P1 — Functional gaps affecting production:** Missing concrete implementations that force users to supply their own (e.g., no `createAIProvider` factory, no DB-backed stores). These break the library's out-of-the-box story.
- **P2 — Implementation divergences:** Library or pattern substitutions. The feature works but deviates from specification; matters most when the spec's choice was load-bearing (e.g., `chokidar` has cross-platform benefits `fs.watch` lacks).
- **P3 — Missing coverage or UX:** Browser E2E tests absent, guided wizard flows not built. Functionality exists but is untested or unpolished.

**Step 5 — Document in a gap matrix.**
Produce a per-plan table with columns: IU | description | status | evidence. Summarize P1/P2/P3 counts at the top. Reference specific file paths and line numbers in the evidence column so findings are immediately actionable without re-investigation.

## Why This Matters

For a library project, the gap between "a plan is marked done" and "every IU in that plan is implemented as specified" is where silent API contract breaks live. Callers of `@hono-cms` who read the plan docs to understand expected behavior will find:

- **Interfaces with no concrete implementations**, requiring them to write infrastructure code the library promised to provide. Example: `TranslationProvider` is an interface only; `createAIProvider` factory was never built.
- **Stores that lose data on restart** because the in-memory implementation was shipped but the DB-backed one was not. Example: `MemoryAuditStore` and `MemoryTranslationStore` only — no Drizzle-backed equivalent in any adapter package.
- **OpenAPI routes that exist as Hono handlers but are not declared with `createRoute`**, meaning the generated spec and the actual routes are independent and can drift.

A per-IU audit surfaces these silently-incomplete contracts before they become user-facing surprises or breaking changes. It also creates a precise, prioritized backlog: instead of "improve translation support," the backlog item is "implement `DrizzleTranslationStore` satisfying Plan 013 U1 KTD-1."

## When to Apply

Run a per-IU implementation audit when any of these conditions hold:

- A library project has accumulated plan files but has never had a requirement-by-requirement verification pass.
- The high-level status doc shows all plans "complete" but user-reported bugs suggest missing functionality.
- A significant refactor has occurred and there is uncertainty about which plan IUs survived intact.
- Before a major version release or public API stabilization — the audit catches contract gaps before they become semver commitments.
- When onboarding a new contributor who needs to understand what is actually built versus what was planned.
- After a period of rapid feature development where implementation shortcuts ("ship the interface, add the DB store later") may have accumulated.

## Examples

**Confirmed IU via line reference (Plan 017, populate depth):**
The plan specifies `MAX_POPULATE_DEPTH = 3` enforced in both parsing and query building. Confirmed at `packages/core/src/content/populate.ts:6`:
```ts
export const MAX_POPULATE_DEPTH = 3;
export const MAX_POPULATE_NODES = 100;
```
Status: `[x]` Implemented as specified.

**P1 gap — interface only, no factory (Plan 013 U4):**
Plan 013 specifies a `createAIProvider(config)` factory wiring together the AI translation provider from configuration (Anthropic/OpenAI/AI Gateway). Search of `packages/core/src/` finds `TranslationProvider` as a TypeScript interface only in `packages/core/src/types/providers.ts`. No factory function exists. Users must implement the interface themselves. Status: `[ ]` Not implemented. Gap ID: G-1.

**P1 gap — in-memory store only, no persistence (Plans 013, 014):**
Plan 013 specifies a `TranslationStore` backed by a Drizzle-generated `{collection}_locale_variants` table. Only `MemoryTranslationStore` exists in `packages/core/src/content/translation.ts`. Locale variant data is lost on process restart. Same pattern applies to `AuditStore` (Plan 014) — only `MemoryAuditStore` in `packages/core/src/audit.ts`. Neither `packages/adapter-postgres` nor `packages/adapter-d1` nor any other DB adapter implements these stores. Status: `[~]` Partially implemented. Gap IDs: G-2, G-3.

**P2 divergence — library substitution (Plan 011):**
Plan 011 specifies the CLI uses `citty` for command parsing and `chokidar` for file watching. The 2485-line `packages/cli/src/index.ts` uses plain Node.js argument parsing and native `fs.watch`. All commands are functionally present and work on macOS. `chokidar` has known reliability advantages on Linux/Windows. Status: `[~]` Functionally implemented, diverges from spec. Gap IDs: G-4, G-5.

**P2 divergence — route declaration pattern (Plan 012):**
Plan 012 specifies OpenAPI routes declared with `@hono/zod-openapi`'s `createRoute` so that the route definition and OpenAPI spec are co-located. Actual routes in `packages/core/src/create-cms.ts` are standard Hono handlers; the spec is generated separately by `createOpenAPISpec` in `packages/core/src/openapi.ts`. Scalar UI is loaded via CDN `<script>` tag rather than the `@scalar/hono-api-reference` npm package. Routes work; spec drift is possible. Status: `[~]` Functionally implemented, diverges from spec. Gap IDs: G-6, G-7.

**Plan-level summary (from the audit matrix):**
Plans 001–006, 009–010, 015–017 are fully implemented across all IUs (13 of 18 plans complete). Plans 011–014 are functional but contain P1 or P2 gaps. Plans 007–008 are functional but lack browser E2E coverage and guided wizard UX (P3).

## Related

- [`docs/plans-audit.md`](../plans-audit.md) — the full per-plan, per-IU gap matrix produced by this audit, including status classifications, gap IDs (G-1 through G-15), and file-path references for every finding. This is the primary artifact.
- [`docs/implementation-status-check.md`](../implementation-status-check.md) — the prior high-level status document; useful for plan-level orientation but does not verify individual IUs. The "Completion audit `[ ]`" entry on line 35 is now addressed by `docs/plans-audit.md`.
- [`docs/implemented-capabilities.md`](../implemented-capabilities.md) — evidence-driven capabilities inventory; a complementary view to the gap matrix.
- `docs/plans/` — the 18 source plan files that served as the specification for the audit.
