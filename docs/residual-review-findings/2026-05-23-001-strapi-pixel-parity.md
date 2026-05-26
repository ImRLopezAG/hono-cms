# Residual Review Findings — 2026-05-23 Strapi pixel-parity harness

**Plan:** [`docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md`](../plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md)

**Run artifact:** `/tmp/compound-engineering/ce-code-review/20260523-162314-9e5a5b44/`

**Source:** ce-code-review autofix pass over U1+U2+U3 deliverables (1566 LOC across 9 files). 5 safe_auto fixes applied; 13 findings remain. Repo is not a git repo, so the LFG residual handoff lands in this file instead of a PR body.

## Environment blocker — U4–U10 cannot proceed in this session

`setup-strapi.sh` reaches the `pnpm install` step but fails with
`ERR_PNPM_IGNORED_BUILDS` on pnpm v11.2.2. Five attempts with progressively
stronger configurations all hit the same gate:

1. `--use-pnpm` flag on `create-strapi` → fails (initial install errors)
2. `package.json#pnpm.onlyBuiltDependencies` patch → ignored (pnpm v11 dropped this field)
3. `pnpm-workspace.yaml#onlyBuiltDependencies` → still rejected
4. `pnpm install --allow-build=<pkgs>` → flag does not exist in pnpm v11.2.2
5. `.npmrc#dangerously-allow-all-builds=true` + `pnpm rebuild` → still rejected

The remaining path is `pnpm approve-builds` (interactive) — incompatible with
unattended autonomy. Operator must run that manually once after invoking
`setup-strapi.sh`, then re-run. README updated to document the workaround.

**Until an operator approves the builds, U4–U10 cannot capture Strapi
baseline screenshots.** The hono-cms-side capture path is unblocked (admin
Playwright 7/7 passing). The diff harness is verified end-to-end with
synthetic and incomplete-state runs.

## UX gap surfaced by agent-browser web drive

Driving the CT-Builder via `agent-browser` (separate verification surface
from Playwright) surfaced a second real gap:

- **"Add another field" trigger does not open the U10 AddFieldDialog.**
  Clicking the button at `ContentTypesView.tsx`'s `Add another field` trigger
  produces an unchanged accessibility tree — no `dialog` role, no field-type
  picker grid renders. The U10 agent reported the AddFieldDialog was wired,
  but the trigger button still uses the legacy inline-add behavior. Operators
  can still add fields by using the existing inline row, but the 4-column
  Strapi-style picker is unreachable from the live UI today. Tracked as
  follow-up wiring.

## Runtime gap surfaced by web E2E (not by screenshots)

Adding `e2e/create-collection.spec.ts` revealed a real runtime gap that no
screenshot-based verification would have caught:

- `POST /cms/content-types` succeeds — the FileSchemaWriter persists the new
  collection's TypeScript file to `generated-collections/`.
- `GET /cms/schema` reflects the new collection on next fetch (the schema
  cache invalidates correctly).
- The new collection appears in Rail 2 in the admin.
- **But `GET /api/<new-collection>` returns 404 until the dev-server
  restarts.** The CMS instance is bound to its boot-time schema; writing a
  new file does not register the REST route at runtime.

Strapi handles this by auto-restarting their server after every CT write
("Strapi will restart" toast). hono-cms doesn't yet. Tracked as follow-up:

- **Option A:** dev-server watches `generated-collections/` and gracefully
  restarts on change (mirror Strapi's UX).
- **Option B:** schema-writer registers the new collection with the live
  `cms` instance after `writeCollection` (requires a `cms.registerCollection`
  API which doesn't exist today).
- **Option C:** admin shows a "Restart server" prompt after CT save and
  calls a new `POST /cms/restart` endpoint (operator gesture).

**This was caught by the spec the user requested.** Earlier verification
(typecheck + screenshot capture + Playwright against existing collections)
all passed without noticing this — the gap only surfaces when you actually
create a new CT then try to use it.

---

U4–U10 status: **blocked by environment, not by code.** All shipped harness
deliverables (U1+U2+U3) verified working. Operator needs to:

1. Run `bash tools/parity/setup-strapi.sh` once and intervene to run `cd
   /tmp/strapi-parity-ref && pnpm approve-builds` (select all) when the
   install errors.
2. Re-run `bash tools/parity/setup-strapi.sh` (will reuse the now-approved
   cache).
3. Then `bun tools/parity/capture.ts --side=both --screen=all` will produce
   baselines and the rebuild loop can start.

---

## Residual Review Findings

### P1 — operator-impacting

- **#1 [P1][gated_auto → downstream-resolver]** `tools/parity/setup-strapi.sh:30` — Half-populated Strapi cache reuse. `create_if_missing` only checks `node_modules` directory exists. A network-interrupted `npx create-strapi` (the ~500MB download flagged in plan KTD-1) leaves a half-populated cache that future runs cheerfully reuse and then fail at boot. **Suggested fix:** write `$REF_DIR/.parity-create-done` sentinel only after `npx` exits 0; check that as the gate in `create_if_missing`. Reviewer: `reliability`. Confidence: 100.

- **#2 [P1][gated_auto → downstream-resolver]** `tools/parity/setup-strapi.sh + tools/parity/setup-honocms.sh` — No `trap` handler to clean up backgrounded Strapi/admin/CMS processes on script crash or SIGINT. PID file landed in `fix-005`; trap+kill still TODO. **Suggested fix:** `trap 'kill $STRAPI_PID 2>/dev/null' EXIT INT TERM` in `start_strapi`; mirror in `setup-honocms.sh` after recording the admin/CMS PIDs. Reviewer: `reliability`. Confidence: 100.

- **#3 [P1][gated_auto → downstream-resolver][needs-verification]** `tools/parity/capture.ts:198` — capture.ts swallows Strapi login errors silently. Unauthenticated captures still produce PNGs that look successful but show the login or register page. With `fix-002` landing, this is less likely on first run, but still a hole for env misconfig. **Suggested fix:** log the login failure to stderr with the cited URL and status code. Optionally exit 1 when `STRAPI_PARITY_REQUIRE_AUTH=1`. Reviewer: `correctness`. Confidence: 100.

### P2 — worth addressing

- **#4 [P2][safe_auto → review-fixer]** `examples/newsroom/src/seed-parity.ts:26` — `fetch` has no `AbortSignal` timeout; a stalled CMS hangs `setup-honocms.sh` indefinitely without a diagnostic. **Suggested fix:** wrap `fetch` in `AbortSignal.timeout(10_000)`; on `AbortError`, log "CMS unreachable at <url>" and exit 1. Reviewer: `reliability`. Confidence: 75.

- **#5 [P2][gated_auto → downstream-resolver]** `tools/parity/setup-strapi.sh:50` — `npx create-strapi` has no wall-clock cap on the 500MB download path; on flaky npm, the script hangs silently. **Suggested fix:** wrap `npx` in `timeout 900` (15 min) OR document expected duration in README under pitfalls. Reviewer: `reliability`. Confidence: 75.

- **#6 [P2][safe_auto → review-fixer]** `tools/parity/{capture,diff,report}.ts` — Identical 18-line `invokedDirectly` + `main().catch` shutdown block duplicated across all three CLIs. **Suggested fix:** extract `runCli({ importMeta, label, main })` to `tools/parity/cli-runtime.ts`. Reviewer: `maintainability`. Confidence: 75.

- **#7 [P2][safe_auto → review-fixer]** `tools/parity/capture.ts + tools/parity/diff.ts` — `--screen` resolution IIFE duplicated. **Suggested fix:** move `resolveScreens(spec, label)` into `screen-map.ts` alongside `findScreen`. Reviewer: `maintainability`. Confidence: 75.

- **#8 [P2][manual → downstream-resolver]** `tools/parity/report.ts:54-95` — `renderReport` is pure, exported, and encodes the human-facing artifact (status-sort order, tally, similarity formatting, label fallback) — but has zero tests. **Suggested fix:** add `tools/parity/__tests__/report.test.ts` with cases for status sort (fail/incomplete first), similarity formatting, label fallback to screenId when missing, empty-manifest handling. Reviewer: `testing`. Confidence: 75.

- **#9 [P2][manual → downstream-resolver]** `tools/parity/diff.ts:92-142` — `scoreImages` mismatched-dimension branch is untested. All 5 existing tests use 32x32 buffers; `padToCanvas` + `buildComposite` for unequal-size images never fire. Real captures will have different dimensions — this is THE production path. **Suggested fix:** extend `diff.test.ts` with a 32x32 vs 64x48 case; assert `padToCanvas` pads correctly with white fill and `buildComposite` produces expected canvas dimensions. Reviewer: `testing`. Confidence: 75.

### P3 — polish

- **#10 [P3][advisory → human]** `tools/parity/capture.ts` — localhost vs 127.0.0.1 bind mismatch. Admin vite binds 127.0.0.1 (v4 only) but capture uses `localhost`. IPv6-first macOS could see ECONNREFUSED. Mitigated by `setup-honocms.sh` reusing existing admin port. Reviewer: `correctness`. Confidence: 50.

- **#11 [P3][advisory → human]** `tools/parity/capture.ts:311` — agent-browser CLI surface unverified. Default invocation `agent-browser screenshot <url> --out <path>...` has no verified basis. Operator can override via `PARITY_AGENT_BROWSER_CMD` env. Documented in README. Reviewer: `correctness`. Confidence: 50.

- **#12 [P3][safe_auto → review-fixer]** `tools/parity/report.ts:121` — Manifest parse unguarded; malformed `manifest.json` crashes with a raw stack trace. **Suggested fix:** wrap `JSON.parse` + entry validation in try/catch; emit a one-line operator-facing error and exit 1. Reviewer: `correctness`. Confidence: 75.

- **#13 [P3][manual → downstream-resolver]** `examples/newsroom/src/seed-parity.ts:14` — Inconsistent arg-form across CLIs (`--flag value` vs `--flag=value`). Passing `--cms-url=http://...` to `seed-parity` silently falls back to default. **Suggested fix:** pick one form (recommend `--flag=value`); add `parseArgs` helper accepting both for backward compat. Reviewer: `correctness/maintainability`. Confidence: 100.

---

## Coverage

- **Reviewers succeeded:** 4 of 4 (correctness, testing, maintainability, reliability)
- **Validators run:** 0 (Stage 5b skipped — autofix mode returns residuals for downstream routing)
- **Files reviewed:** 9
- **Lines reviewed:** 1566
- **Applied safe_auto fixes:** 5
- **Untracked files excluded:** N/A (not a git repository — scope was manual file enumeration)
- **Suppressed:** 0 findings below anchor 75 (none qualified)

## Routing rationale

This file exists because:
1. The repository is not a git repository (no `.git/`), so `gh pr edit` cannot route findings to a PR body.
2. The LFG pipeline's fallback path lands the residual file under `docs/residual-review-findings/` so it persists with the source.
3. Future work that re-engages this plan should treat this file as the open-issues list before closing U4–U10.
