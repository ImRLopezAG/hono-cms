# Strapi pixel-parity harness

Drives a real Strapi v5 admin and our `@hono-cms` admin side-by-side, captures
12 canonical screens from each via `agent-browser`, and emits a pixel-diff
manifest. The manifest is the falsifier for the
[2026-05-23-001 parity plan](../../docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md).

## Why this exists

Reading Strapi's source code (under `.references/strapi/`) reveals **what**
components Strapi uses but not **how** they compose on the page — spacing
rhythm, header heights, hover treatments, focus rings only surface in the
running app. The harness runs both admins and proves parity (or proves the
gap) with screenshots.

## Quickstart

```bash
# 1) Boot the reference Strapi app (cached at /tmp/strapi-parity-ref/)
bash tools/parity/setup-strapi.sh

# 2) Seed Strapi with Author + Article content types and example records.
#    REQUIRED: without this step Strapi has no api::article.article and
#    screens 03-12 redirect to the login page, producing identical PNGs.
#    Idempotent — re-running is a no-op if schemas + records already exist.
bun tools/parity/seed-strapi.ts

# 3) In a separate shell, boot our admin + newsroom CMS with the parity seed
bash tools/parity/setup-honocms.sh

# 4) Capture all 12 screen pairs (uses Playwright by default)
bun tools/parity/capture.ts --side=both --screen=all

# 5) Validate the captures actually differ from one another (catches the
#    "every screen redirected to login" failure mode before scoring).
bun tools/parity/validate-captures.ts

# 6) Score every pair and regenerate the manifest + overlays
bun tools/parity/diff.ts

# 7) Produce a human-readable report
bun tools/parity/report.ts
```

Outputs land in [`docs/screenshots/parity/`](../../docs/screenshots/parity/):

```
docs/screenshots/parity/
  strapi/<id>.png         # baseline shots
  honocms/<id>.png        # our shots
  diff-overlays/<id>.png  # side-by-side composites
  manifest.json           # { screenId, status, similarityScore, notes }
  REPORT.md               # human summary derived from manifest
```

## Screen map

The 12 canonical screens are defined in [`screen-map.ts`](./screen-map.ts).
Each entry pairs a Strapi URL with the hono-cms equivalent and an optional
`prep` action (open a filter, scroll to a modal, etc.). Update that file when
adding screens — the rest of the harness picks them up automatically.

## Auth handling

- Strapi prompts to create an admin user on first boot. The harness reuses the
  credentials in `STRAPI_PARITY_ADMIN_EMAIL` / `STRAPI_PARITY_ADMIN_PASSWORD`
  env vars (defaults: `parity@example.com` / `Parity-Demo-1`).
- hono-cms uses Bearer-token storage seeding via `localStorage` key
  `hono-cms:auth-token`. The harness sets the token to `"admin"` (newsroom's
  built-in dev token).

## Idempotency

- `setup-strapi.sh` checks for an existing `/tmp/strapi-parity-ref/` with healthy
  `node_modules/` and skips the `npx create-strapi@latest` step when it can.
- `setup-honocms.sh` reuses already-running ports and only seeds CTs/records
  when missing.
- `capture.ts` overwrites the target PNG on every run; `diff.ts` regenerates
  the manifest from scratch.

## Thresholds

`diff.ts` uses [pixelmatch](https://github.com/mapbox/pixelmatch) with a
perceptual threshold of `0.10` (10% pixel delta budget across the frame).
System fonts and antialiasing differ between OSes — the threshold is structural
parity, not pixel-exact. A failing score never blocks unilaterally; an
operator can annotate the manifest entry with `notes: "intentional divergence
— <reason>"` (see plan KTD-2).

## Operator env vars

| Var | Default | Notes |
|---|---|---|
| `STRAPI_PARITY_DIR` | `/tmp/strapi-parity-ref` | Cache location for the reference Strapi app |
| `STRAPI_PARITY_PORT` | `1337` | Where Strapi listens |
| `STRAPI_PARITY_ADMIN_EMAIL` | `parity@example.com` | Strapi admin user |
| `STRAPI_PARITY_ADMIN_PASSWORD` | `Parity-Demo-1` | Strapi admin pw |
| `HONOCMS_PARITY_ADMIN_PORT` | `5173` | Vite admin dev port |
| `HONOCMS_PARITY_CMS_PORT` | `8787` | Newsroom CMS port |
| `PARITY_VIEWPORT_WIDTH` | `1440` | Capture width |
| `PARITY_VIEWPORT_HEIGHT` | `900` | Capture height |
| `PARITY_THRESHOLD` | `0.10` | pixelmatch perceptual threshold |

## Workflow during a rebuild

1. Run `capture.ts` once for the screen you're rebuilding (`--screen=03-content-list`).
2. Inspect `diff-overlays/03-content-list.png` — Strapi on the left, our admin
   on the right.
3. Edit the relevant view in `apps/admin/src/components/views/`.
4. Re-run `capture.ts --side=honocms --screen=03-content-list && bun tools/parity/diff.ts`.
5. Iterate until `manifest.json` reports `status: pass` for that screen.

## What's NOT cached

- Strapi `npx create-strapi@latest` may need network on first run (~500 MB
  download). Subsequent runs reuse the cached project (verified via the
  `.parity-create-done` sentinel) unless you delete `/tmp/strapi-parity-ref/`
  manually.
- Strapi's first boot creates SQLite under `.tmp/data.db` inside the project.
  Deleting that wipes the seed; rerun `setup-strapi.sh` to reseed.

## Known limitation: pnpm v11 build-scripts gate

`setup-strapi.sh` uses `pnpm` per project convention. pnpm v11+ blocks
postinstall scripts on native packages (`better-sqlite3`, `sharp`, `esbuild`,
`@swc/core`, `core-js-pure`) until they're explicitly approved. The script
writes `pnpm-workspace.yaml#onlyBuiltDependencies` and `.npmrc` with
`dangerously-allow-all-builds=true` — but pnpm v11.2.2 still rejects the
install with `ERR_PNPM_IGNORED_BUILDS` in many environments. The recommended
operator workaround:

```bash
cd /tmp/strapi-parity-ref && pnpm approve-builds
# Then select all listed packages (`a`, `enter`)
pnpm install
pnpm run develop  # boot Strapi manually if setup-strapi.sh hung
```

This is a one-time per-project approval; subsequent runs reuse the approval
stored in pnpm's content-addressable store. If this proves a recurring
friction, the workaround is to set `STRAPI_PARITY_PACKAGE_MANAGER=npm` and
modify `setup-strapi.sh` (operator-local change) to pass `--use-npm` and call
`npm` — the parity contract does not require pnpm for the throwaway reference
app.

## Implementation status

The U3 harness skeleton is committed; the rebuild units that consume it are
deferred until an operator has booted Strapi and captured baselines.

Harness files present:

- `tools/parity/types.ts` — shared `ScreenSpec` / `ManifestEntry` / `Manifest` types.
- `tools/parity/screen-map.ts` — `SCREEN_MAP` with the 12 canonical screen pairs.
- `tools/parity/capture.ts` — capture CLI (Playwright default driver, optional
  `--driver=agent-browser`).
- `tools/parity/diff.ts` — scoring CLI; emits `manifest.json` + side-by-side overlays.
- `tools/parity/report.ts` — renders `REPORT.md` from the manifest.
- `tools/parity/__tests__/diff.test.ts` — unit tests for the pure scoring function.
- `tools/parity/setup-strapi.sh` and `tools/parity/setup-honocms.sh` — operator
  bootstrap scripts (already shipped).
- `tools/parity/seed-strapi.ts` — Author + Article CT seeder, run after
  `setup-strapi.sh` and before `capture.ts`. Writes schema files directly to
  `src/api/` (Strapi's `develop` watcher restarts itself), then POSTs one
  Author + two Articles via `/content-manager/`. Persists the first article's
  `documentId` to `.parity-document-ids.json` so the capture script can
  navigate to the real edit URL (`/api::article.article/<documentId>`)
  instead of the Strapi v4-style numeric `/1` placeholder.
- `tools/parity/validate-captures.ts` — md5-hash uniqueness check. Asserts
  at least 10/12 PNGs per side are unique. Catches the "every Strapi screen
  redirected to /admin/auth/login because auth was broken" failure mode
  before `diff.ts` produces a misleading high-similarity report.

Captured screens:

- Strapi side: **none yet** — requires the operator to run `setup-strapi.sh`
  and then `bun tools/parity/capture.ts --side=strapi`.
- hono-cms side: **none yet** — requires `setup-honocms.sh` plus
  `bun tools/parity/capture.ts --side=honocms`.

Deferred to follow-up sessions:

- **U4–U10** (per-screen rebuild work) cannot be closed until baseline
  captures exist, because every unit's exit criterion is a `pass` manifest
  entry for its screen(s). Those units are intentionally deferred — they
  require operator-driven Strapi boot + baseline screenshots before any
  rebuild can be scored.
- **U11** (full regression) runs `report.ts` and the Playwright suite once
  U4–U10 land.

## Drivers

`capture.ts` accepts `--driver=playwright` (default) or `--driver=agent-browser`.

- **Playwright** is the default because `@playwright/test`'s `chromium` is
  installed under `apps/admin/node_modules` and works without operator setup.
- **agent-browser**, when on PATH, can be selected via `--driver=agent-browser`.
  By default the harness invokes `agent-browser screenshot <url> --out <path>
  --width <w> --height <h>`. Override the command surface with
  `PARITY_AGENT_BROWSER_CMD="<template>"` where `{url}`, `{out}`, `{width}`,
  `{height}` are substituted before invocation. `bun tools/parity/capture.ts
  --help` reports whether `agent-browser` is currently on PATH.

## Scoring contract

`diff.ts` exports a pure `scoreImages(strapiBuf, honoBuf, opts)` function used
by both the CLI and the unit tests. Status semantics:

- `incomplete` — either side's PNG is missing; no overlay is produced.
- `pass` — `pixelDelta / totalPixels <= threshold` (default `0.10`).
- `fail` — otherwise.

The manifest JSON schema is defined in `tools/parity/types.ts` (`Manifest`)
and matches plan requirement R4.
