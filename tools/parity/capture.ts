#!/usr/bin/env bun
/**
 * Capture orchestrator for the Strapi pixel-parity harness.
 *
 * For each (side, screen) pair: navigate to the resolved URL, run any `prep`
 * action, and save the PNG to `docs/screenshots/parity/<side>/<id>.png`.
 *
 * Per docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md U3 (R2, R3).
 *
 * Driver selection:
 *   1. Playwright (DEFAULT) — uses `@playwright/test`'s `chromium`, already
 *      installed under `apps/admin/node_modules/@playwright/test`. Guaranteed
 *      to work without the agent-browser CLI on PATH.
 *   2. agent-browser (enhancement) — if `agent-browser` is on PATH and the
 *      operator passes `--driver=agent-browser`, the harness spawns it per
 *      capture. Default is Playwright because the CLI surface is not yet
 *      formalised across hosts.
 *
 * Auth handling:
 *   - Strapi:  POST `/admin/login` with credentials from
 *              `STRAPI_PARITY_ADMIN_EMAIL` / `STRAPI_PARITY_ADMIN_PASSWORD`.
 *              The JWT returned by Strapi v5 admin login is stored in
 *              `localStorage["jwtToken"]` before the first navigation.
 *   - hono-cms: `page.addInitScript` seeds
 *              `localStorage["hono-cms:auth-token"] = JSON.stringify("admin")`.
 *
 * Usage:
 *   bun tools/parity/capture.ts --help
 *   bun tools/parity/capture.ts                            # both sides, all screens
 *   bun tools/parity/capture.ts --side=strapi              # one side
 *   bun tools/parity/capture.ts --screen=03-content-list   # one screen
 *   bun tools/parity/capture.ts --driver=agent-browser     # opt into agent-browser
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SCREEN_MAP, findScreen } from "./screen-map.ts";
import type { ScreenSpec, SideSpec } from "./types.ts";

type Side = "strapi" | "honocms";
type Driver = "playwright" | "agent-browser";

type CliArgs = {
  readonly side: "strapi" | "honocms" | "both";
  readonly screen: string;
  readonly driver: Driver;
  readonly help: boolean;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PARITY_DIR = join(REPO_ROOT, "docs", "screenshots", "parity");

const STRAPI_BASE =
  process.env.STRAPI_PARITY_BASE_URL ??
  `http://localhost:${process.env.STRAPI_PARITY_PORT ?? "1337"}`;
const HONOCMS_BASE =
  process.env.HONOCMS_PARITY_BASE_URL ??
  // Vite is started with `--host 127.0.0.1` (see setup-honocms.sh), so the
  // server binds to 127.0.0.1 but rejects requests to `localhost` with HTTP
  // 426 ("Upgrade Required"). Use 127.0.0.1 directly to avoid that.
  `http://127.0.0.1:${process.env.HONOCMS_PARITY_ADMIN_PORT ?? "5173"}`;

const STRAPI_EMAIL =
  process.env.STRAPI_PARITY_ADMIN_EMAIL ?? "parity@example.com";
const STRAPI_PASSWORD =
  process.env.STRAPI_PARITY_ADMIN_PASSWORD ?? "Parity-Demo-1";

const HONOCMS_TOKEN = process.env.HONOCMS_PARITY_TOKEN ?? "admin";

const STRAPI_REF_DIR =
  process.env.STRAPI_PARITY_DIR ?? "/tmp/strapi-parity-ref";
const STRAPI_DOC_ID_SENTINEL = join(
  STRAPI_REF_DIR,
  ".parity-document-ids.json"
);

/**
 * Cached Strapi admin JWT — Strapi rate-limits /admin/login aggressively
 * (HTTP 429 after ~5 attempts/min), so we login once per `main()` invocation
 * and reuse the token for every capture. The token is set inside the
 * Playwright context via addInitScript so the SPA boot sees it as if the
 * user just logged in via the normal flow.
 */
let cachedStrapiToken: string | null = null;

/**
 * Resolved at startup from `.parity-document-ids.json` (written by
 * `seed-strapi.ts`). Strapi v5 routes the content-manager edit page by
 * documentId — the `/1` in screen-map is a placeholder that we substitute
 * for the real documentId before navigating. If the sentinel is absent
 * (operator skipped the seed step), we leave the URL untouched and the
 * capture will land on the list view (still useful as a fallback).
 */
let cachedArticleDocumentId: string | null = null;

/**
 * Resolved at startup from the hono-cms REST endpoint. The newsroom example
 * seeds articles with random UUIDs (not the literal `1` in `screen-map`), so
 * navigating to `/content/articles/1` falls back to the list view and
 * screen 05/06 collapse into duplicates of 03. We GET the first article and
 * substitute its UUID in `urlFor()` to give the edit view a real target.
 */
let cachedHonoArticleId: string | null = null;

function parseArgs(argv: readonly string[]): CliArgs {
  let side: CliArgs["side"] = "both";
  let screen = "all";
  let driver: Driver = "playwright";
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--side=strapi") side = "strapi";
    else if (arg === "--side=honocms") side = "honocms";
    else if (arg === "--side=both") side = "both";
    else if (arg.startsWith("--screen=")) screen = arg.slice("--screen=".length);
    else if (arg === "--driver=playwright") driver = "playwright";
    else if (arg === "--driver=agent-browser") driver = "agent-browser";
  }
  return { side, screen, driver, help };
}

function printHelp(): void {
  const agentBrowserStatus = detectAgentBrowser()
    ? "available on PATH"
    : "NOT on PATH (install before using --driver=agent-browser)";
  process.stdout.write(
    [
      "bun tools/parity/capture.ts — capture parity screenshots",
      "",
      "Usage:",
      "  bun tools/parity/capture.ts                        # both sides, all screens",
      "  bun tools/parity/capture.ts --side=strapi          # capture only Strapi",
      "  bun tools/parity/capture.ts --side=honocms         # capture only hono-cms",
      "  bun tools/parity/capture.ts --screen=<id>          # one screen",
      "  bun tools/parity/capture.ts --driver=playwright    # default driver",
      "  bun tools/parity/capture.ts --driver=agent-browser # opt into agent-browser",
      "",
      `agent-browser: ${agentBrowserStatus}`,
      "",
      "Required env vars (have sensible defaults):",
      "  STRAPI_PARITY_ADMIN_EMAIL / STRAPI_PARITY_ADMIN_PASSWORD",
      "  STRAPI_PARITY_BASE_URL / HONOCMS_PARITY_BASE_URL",
      "  HONOCMS_PARITY_TOKEN (newsroom dev token, default: \"admin\")",
      "",
      "Outputs:",
      "  docs/screenshots/parity/strapi/<id>.png",
      "  docs/screenshots/parity/honocms/<id>.png",
      "",
      "Exit codes: 0 on full success, 1 if any capture failed (does not bail on first failure).",
      ""
    ].join("\n")
  );
}

function detectAgentBrowser(): boolean {
  const result: SpawnSyncReturns<string> = spawnSync("which", ["agent-browser"], {
    encoding: "utf8"
  });
  return result.status === 0 && (result.stdout ?? "").trim() !== "";
}

function resolveSide(screen: ScreenSpec, side: Side): SideSpec {
  return side === "strapi" ? screen.strapi : screen.honocms;
}

function urlFor(side: Side, sideSpec: SideSpec): string {
  const base = side === "strapi" ? STRAPI_BASE : HONOCMS_BASE;
  let path = sideSpec.path;
  // Strapi v5 routes the content-manager edit page by documentId, not the
  // numeric `1` the screen-map uses as a stable placeholder. Substitute the
  // real documentId when we have one — otherwise leave the URL alone and
  // accept the resulting 404 -> redirect (still a different frame than the
  // login page, so the capture still diverges from the login screen).
  if (
    side === "strapi" &&
    cachedArticleDocumentId &&
    path.endsWith("/api::article.article/1")
  ) {
    path = path.replace(
      "/api::article.article/1",
      `/api::article.article/${cachedArticleDocumentId}`
    );
  }
  // Same trick for hono-cms: the newsroom seed assigns UUIDs to articles,
  // and `/content/articles/1` falls back to the list view.
  if (
    side === "honocms" &&
    cachedHonoArticleId &&
    path === "/content/articles/1"
  ) {
    path = `/content/articles/${cachedHonoArticleId}`;
  }
  return `${base}${path}`;
}

/**
 * Fetch the first article's UUID from the hono-cms REST endpoint. The
 * newsroom example exposes `/api/articles` which returns `{ items: [...] }`.
 * Best-effort: a failure leaves `cachedHonoArticleId` null and capture
 * falls back to the literal `/1` placeholder (= list view).
 */
async function loadHonoArticleId(): Promise<void> {
  try {
    const res = await fetch(`${HONOCMS_BASE.replace(":5173", ":8787")}/api/articles?limit=1`, {
      headers: { Authorization: `Bearer ${HONOCMS_TOKEN}` },
      signal: AbortSignal.timeout(5_000)
    });
    if (!res.ok) {
      // Try the CMS port from env var directly (more robust than string replace).
      const cmsPort = process.env.HONOCMS_PARITY_CMS_PORT ?? "8787";
      const altRes = await fetch(
        `http://127.0.0.1:${cmsPort}/api/articles?limit=1`,
        {
          headers: { Authorization: `Bearer ${HONOCMS_TOKEN}` },
          signal: AbortSignal.timeout(5_000)
        }
      );
      if (!altRes.ok) return;
      const body = (await altRes.json()) as { items?: { id: string }[] };
      if (body.items?.[0]?.id) {
        cachedHonoArticleId = body.items[0].id;
        console.log(
          `[parity:capture] resolved hono-cms article id: ${cachedHonoArticleId}`
        );
      }
      return;
    }
    const body = (await res.json()) as { items?: { id: string }[] };
    if (body.items?.[0]?.id) {
      cachedHonoArticleId = body.items[0].id;
      console.log(
        `[parity:capture] resolved hono-cms article id: ${cachedHonoArticleId}`
      );
    }
  } catch (error: unknown) {
    console.warn(
      `[parity:capture] could not resolve hono-cms article id: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Load the documentId sentinel written by `seed-strapi.ts`. Best-effort:
 * a missing sentinel just means the operator hasn't run the seed yet, and
 * we'll fall back to the literal path from screen-map.
 */
async function loadArticleDocumentId(): Promise<void> {
  if (!existsSync(STRAPI_DOC_ID_SENTINEL)) return;
  try {
    const payload = JSON.parse(
      await readFile(STRAPI_DOC_ID_SENTINEL, "utf8")
    ) as { articleDocumentId?: string };
    if (payload.articleDocumentId) {
      cachedArticleDocumentId = payload.articleDocumentId;
      console.log(
        `[parity:capture] resolved article documentId: ${cachedArticleDocumentId}`
      );
    }
  } catch (error: unknown) {
    console.warn(
      `[parity:capture] could not read documentId sentinel: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Authenticate against Strapi once per `main()` invocation. Returns null
 * if Strapi is unreachable or the credentials are wrong — the caller
 * proceeds without a token, which means the capture will land on
 * `/admin/auth/login` (still a valid frame for screen 01).
 */
async function loginStrapi(): Promise<string | null> {
  if (cachedStrapiToken) return cachedStrapiToken;
  try {
    const res = await fetch(`${STRAPI_BASE}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: STRAPI_EMAIL, password: STRAPI_PASSWORD }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
      console.warn(
        `[parity:capture] Strapi login failed: HTTP ${res.status}` +
          (res.status === 429
            ? " (rate-limited; wait 60s before re-running)"
            : "")
      );
      return null;
    }
    const body = (await res.json()) as { data?: { token?: string } };
    const token = body?.data?.token ?? null;
    if (token) {
      cachedStrapiToken = token;
      console.log("[parity:capture] Strapi auth: ok");
    }
    return token;
  } catch (error: unknown) {
    console.warn(
      `[parity:capture] Strapi login error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

type CaptureFailure = {
  readonly side: Side;
  readonly screenId: string;
  readonly error: string;
};

/**
 * Minimal structural type of the parts of `@playwright/test` we need.
 * We avoid a direct `import type` because the package is installed under
 * `apps/admin/node_modules` (not the workspace root), and we want the tools
 * tsconfig to typecheck without resolving the install. The runtime resolver
 * walks node_modules upward and finds the dependency via workspace hoisting.
 */
type PlaywrightModule = {
  chromium: {
    launch: () => Promise<{
      newContext: (opts: {
        viewport: { width: number; height: number };
        deviceScaleFactor: number;
      }) => Promise<PwContext>;
      close: () => Promise<void>;
    }>;
  };
};

type PwContext = {
  addInitScript: <T>(
    fn: (arg: T) => void,
    arg: T
  ) => Promise<void>;
  newPage: () => Promise<PwPage>;
  close: () => Promise<void>;
};

type PwPage = {
  goto: (
    url: string,
    opts?: { waitUntil?: string; timeout?: number }
  ) => Promise<unknown>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<unknown>;
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  request: {
    post: (
      url: string,
      opts: {
        data: Record<string, unknown>;
        headers?: Record<string, string>;
      }
    ) => Promise<{
      ok: () => boolean;
      json: () => Promise<unknown>;
    }>;
  };
};

/**
 * Screen-specific prep heuristics.
 *
 * `screen-map.ts` records the desired prep action as a human-readable hint.
 * For screens where the prep is critical to the captured frame (e.g. an open
 * modal), we additionally drive the click here. Strapi-side prep is best-effort
 * — if the structure differs, the capture still saves the bare page.
 */
async function applyPrepHeuristic({
  page,
  side,
  screenId
}: {
  page: PwPage;
  side: Side;
  screenId: string;
}): Promise<void> {
  /**
   * `clickByText(predicates)` is the workhorse: it scans every button on the
   * page and clicks the first one whose visible text matches one of the
   * supplied substring matchers. We use it on both sides because the DOM
   * trees differ but the user-facing button labels are remarkably similar
   * (Strapi: "Add new assets", hono-cms: "Add new assets"; Strapi: "Filters",
   * hono-cms: "Filters"; etc.). Strapi's tooltips and aria-labels are
   * occasionally non-English, so we match the visible label.
   */
  /**
   * `clickByText(matchers)` is the workhorse for prep heuristics. It scans
   * every button on the page and clicks the first one whose visible text
   * (or aria-label) matches one of the supplied substring matchers. We use
   * it on both sides because the DOM trees differ but the user-facing
   * button labels are remarkably similar (Strapi: "Add new assets",
   * hono-cms: "Add new assets"; Strapi: "Filters", hono-cms: "Filters").
   *
   * Two implementation notes:
   *   1. Playwright's `page.evaluate` accepts `(fn, arg)` at runtime even
   *      though our minimal `PwPage` type only declares the no-arg form.
   *      We do not pass `matchers` through the closure scope because the
   *      function is serialised across the CDP bridge and the outer scope
   *      is unavailable in the page context. Instead we pre-bake the
   *      matchers into a stringified JS source via `evaluate(() => { ... }
   *      , matchers)`.
   *   2. We MUST NOT rebind `page.evaluate` via a cast — Playwright's
   *      evaluate is a method that uses `this` internally to reach
   *      `_mainFrame`. Calling `(page.evaluate as unknown as F)(fn, arg)`
   *      strips the `this` context and throws
   *      `undefined is not an object (evaluating 'this._mainFrame')`. We
   *      keep the call as `page.evaluate(...)` and lean on the runtime
   *      arity tolerance, using `@ts-expect-error` to silence the
   *      minimal-type mismatch.
   */
  const clickByText = async (
    matchers: ReadonlyArray<string>
  ): Promise<boolean> => {
    const fn = (args: ReadonlyArray<string>): boolean => {
      const normalisedMatchers = args.map((m) => m.toLowerCase());
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, [role='button'], a[role='button']"
        )
      );
      for (const button of buttons) {
        const text = (button.textContent ?? "").trim().toLowerCase();
        if (text && normalisedMatchers.some((m) => text.includes(m))) {
          (button as HTMLButtonElement).click();
          return true;
        }
        const aria = (
          button.getAttribute("aria-label") ?? ""
        ).toLowerCase();
        if (aria && normalisedMatchers.some((m) => aria.includes(m))) {
          (button as HTMLButtonElement).click();
          return true;
        }
      }
      return false;
    };
    // @ts-expect-error — Playwright's evaluate accepts (fn, arg) at runtime.
    return (await page.evaluate(fn, matchers)) as boolean;
  };
  const clickByTextV2 = clickByText;

  /**
   * 04 — Filter chip open.
   *
   * Strapi v5 list view: top-right "Filters" button opens a popover.
   *   Selector: `button` with text "Filters".
   * hono-cms list view (ContentWorkspace.FilterChipRow): same label.
   *   Selector: same.
   */
  if (screenId === "04-content-list-filter-open") {
    const clicked = await clickByTextV2(["filters"]);
    console.log(
      `[parity:capture] (${side} ${screenId}) clickByText("filters") -> ${clicked}`
    );
    await page.waitForTimeout(600);
    return;
  }

  /**
   * 06 — Record edit info panel.
   *
   * Strapi v5 EditView already shows the right info panel — no click
   * required. hono-cms EditView likewise. The capture differs from screen
   * 05 only when the panel is open by default; if a side hides the panel
   * behind a toggle, click it via the well-known buttons.
   */
  if (screenId === "06-record-edit-info-panel") {
    // Strapi v5 EditView shows the right info panel ("Entry" / "Preview")
    // by default, and hono-cms EditView does the same. The panel is part
    // of the page layout — no click required to reveal it. We only scroll
    // the right rail into view so any layout-shift settles before capture.
    // Wrap in a timeout race — evaluate can hang on slow record-edit loads.
    try {
      await Promise.race([
        page.evaluate(() => {
          const aside =
            document.querySelector("aside") ||
            document.querySelector("[role='complementary']");
          if (aside) (aside as HTMLElement).scrollIntoView({ block: "start" });
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("scroll-into-view timed out")),
            5_000
          )
        )
      ]);
    } catch (error: unknown) {
      console.warn(
        `[parity:capture] (${side} ${screenId}) scroll skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    await page.waitForTimeout(400);
    return;
  }

  /**
   * 08 — Media upload modal.
   *
   * Strapi: header button "Add new assets" opens the upload modal.
   * hono-cms (MediaView.tsx:368): identical label "Add new assets".
   */
  if (screenId === "08-media-upload-modal") {
    const clicked = await clickByTextV2([
      "add new assets",
      "upload"
    ]);
    console.log(
      `[parity:capture] (${side} ${screenId}) clickByText("Add new assets") -> ${clicked}`
    );
    await page.waitForTimeout(600);
    return;
  }

  /**
   * 12 — CT Builder add field modal.
   *
   * Strapi: "Add another field" button in the CT edit view opens the type picker.
   * hono-cms (ContentTypesView.tsx:512): aria-label="Add another field".
   */
  if (screenId === "12-ct-add-field-modal") {
    const clicked = await clickByTextV2([
      "add another field",
      "add new field"
    ]);
    console.log(
      `[parity:capture] (${side} ${screenId}) clickByText("Add another field") -> ${clicked}`
    );
    await page.waitForTimeout(600);
    return;
  }
}

async function captureWithPlaywright(
  side: Side,
  screen: ScreenSpec
): Promise<void> {
  // Dynamic import keeps Playwright optional at module-load time.
  // The package is installed under `apps/admin/node_modules` — Bun's
  // resolver finds it via the workspace because we hoist on install.
  const mod = (await import("@playwright/test" as string)) as PlaywrightModule;
  const { chromium } = mod;

  const sideSpec = resolveSide(screen, side);
  const url = urlFor(side, sideSpec);
  const outPath = join(PARITY_DIR, side, `${screen.id}.png`);
  await mkdir(dirname(outPath), { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: screen.viewport.width, height: screen.viewport.height },
      deviceScaleFactor: 1
    });

    if (side === "honocms" && screen.id !== "01-login") {
      // Seed our admin's localStorage auth before any page script runs.
      // Skip for screen 01 so the actual /login form renders (otherwise
      // the AuthProvider redirects authenticated users to /content and
      // screen 01 becomes a duplicate of screen 02).
      await context.addInitScript<{ token: string }>(
        ({ token }) => {
          window.localStorage.setItem(
            "hono-cms:auth-token",
            JSON.stringify(token)
          );
        },
        { token: HONOCMS_TOKEN }
      );
    }

    const page = await context.newPage();

    if (side === "strapi") {
      // Strapi v5 stores `localStorage.jwtToken` (JSON-stringified) AND
      // `localStorage.isLoggedIn = "true"` after a successful login. The
      // SPA's AuthProvider boots from the Redux reducer which reads both
      // keys — without `isLoggedIn` the cross-tab storage listener marks
      // the user as logged out and redirects to /admin/auth/login.
      //
      // We use the module-level cached token to avoid hammering Strapi's
      // /admin/login rate-limiter (HTTP 429 after ~5 attempts/min). The
      // token is fetched once in `main()` before any captures run.
      //
      // EXCEPTION: screen `01-login` must capture the actual login form.
      // If we inject the token here, Strapi auto-redirects authenticated
      // users to `/admin` and screen 01 becomes a duplicate of screen 02.
      const isLoginScreen = screen.id === "01-login";
      if (cachedStrapiToken && !isLoginScreen) {
        await context.addInitScript<{ jwt: string }>(
          ({ jwt }) => {
            window.localStorage.setItem("jwtToken", JSON.stringify(jwt));
            window.localStorage.setItem("isLoggedIn", "true");
          },
          { jwt: cachedStrapiToken }
        );
      }
    }

    // Strapi v5 admin's SPA fires a lot of background polling (notifications,
    // permissions, projectType) which keeps `networkidle` from firing within
    // 30s on slower laptops. We use `domcontentloaded` plus a generous fixed
    // settle wait — empirically enough for the route to mount its panels.
    //
    // We launch a fresh browser per capture so the URL is always a first
    // navigation (avoids `goto` to the same URL hanging when two adjacent
    // screens — e.g. 05 + 06 — point at the same edit page).
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_500);

    if (side === "strapi" && screen.id !== "01-login") {
      // Strapi v5 shows a multi-step "Guided tour" popover on first login
      // for the dashboard, content-manager and CT-builder. The popover
      // obscures the very surface we want to capture (screen 04 in
      // particular — the Filters button is hidden behind it). Click the
      // "Skip" or "Skip the tour" button to dismiss it before any
      // screen-specific prep runs. Best-effort: a missing tour just no-ops.
      //
      // Wrap in a race against a timeout: some screens (e.g. record edit)
      // load slowly and the evaluate can hang if the page is mid-navigation.
      try {
        await Promise.race([
          page.evaluate(() => {
            const buttons = Array.from(
              document.querySelectorAll<HTMLElement>("button")
            );
            for (const button of buttons) {
              const label = (button.textContent ?? "").trim().toLowerCase();
              if (label === "skip" || label.startsWith("skip the tour")) {
                (button as HTMLButtonElement).click();
                return;
              }
            }
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("tour-skip eval timed out")), 5_000)
          )
        ]);
      } catch (error: unknown) {
        console.warn(
          `[parity:capture] (${side} ${screen.id}) tour-skip skipped: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      await page.waitForTimeout(400);
    }

    if (sideSpec.prep) {
      // We log the prep intent so operators know what manual step would be
      // needed; Playwright drives generic prep heuristics in follow-up units.
      // The current harness fires a 750ms settle wait to let menus/modals
      // populate when triggered by a prior navigation hash, then captures.
      console.log(
        `[parity:capture] (${side} ${screen.id}) prep hint: "${sideSpec.prep}"`
      );
      await applyPrepHeuristic({ page, side, screenId: screen.id });
      await page.waitForTimeout(750);
    }

    await page.screenshot({ path: outPath, fullPage: false });

    await context.close();
  } finally {
    await browser.close();
  }
}

async function captureWithAgentBrowser(
  side: Side,
  screen: ScreenSpec
): Promise<void> {
  if (!detectAgentBrowser()) {
    throw new Error(
      "agent-browser is not on PATH. Re-run with --driver=playwright or install agent-browser."
    );
  }
  const sideSpec = resolveSide(screen, side);
  const url = urlFor(side, sideSpec);
  const outPath = join(PARITY_DIR, side, `${screen.id}.png`);
  await mkdir(dirname(outPath), { recursive: true });

  // agent-browser CLI surface is host-specific; we use a minimal subcommand
  // contract: `agent-browser screenshot <url> --out <path> --width <w> --height <h>`.
  // If the operator's binary uses a different surface, override by setting
  // `PARITY_AGENT_BROWSER_CMD` to a template containing `{url}` and `{out}`.
  const tmpl = process.env.PARITY_AGENT_BROWSER_CMD;
  const result = tmpl
    ? spawnSync(
        "sh",
        [
          "-c",
          tmpl
            .replace("{url}", url)
            .replace("{out}", outPath)
            .replace("{width}", String(screen.viewport.width))
            .replace("{height}", String(screen.viewport.height))
        ],
        { stdio: "inherit", encoding: "utf8" }
      )
    : spawnSync(
        "agent-browser",
        [
          "screenshot",
          url,
          "--out",
          outPath,
          "--width",
          String(screen.viewport.width),
          "--height",
          String(screen.viewport.height)
        ],
        { stdio: "inherit", encoding: "utf8" }
      );
  if (result.status !== 0) {
    throw new Error(
      `agent-browser exited with status ${result.status ?? "(killed)"}.`
    );
  }
}

async function captureOne(
  driver: Driver,
  side: Side,
  screen: ScreenSpec
): Promise<void> {
  // Hard cap per capture so a single stuck screen never blocks the run.
  // Empirically captures complete in 5-15s; 60s gives plenty of headroom.
  const inner =
    driver === "agent-browser"
      ? captureWithAgentBrowser(side, screen)
      : captureWithPlaywright(side, screen);
  await Promise.race([
    inner,
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`captureOne timed out after 60s`)),
        60_000
      )
    )
  ]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const screens =
    args.screen === "all"
      ? SCREEN_MAP
      : (() => {
          const s = findScreen(args.screen);
          if (!s) {
            console.error(`[parity:capture] unknown screen id: ${args.screen}`);
            process.exit(1);
          }
          return [s];
        })();

  const sides: Side[] =
    args.side === "both" ? ["strapi", "honocms"] : [args.side];

  // One-time setup per main() invocation:
  //   1. Load the article documentId sentinel so screens 05/06 navigate to a
  //      real edit page (not a 404 redirect to the list).
  //   2. Login to Strapi ONCE — Strapi's /admin/login rate-limiter trips at
  //      ~5 attempts/min, so per-screen login (the old behaviour) made the
  //      capture run flaky after the 5th screen.
  if (sides.includes("strapi")) {
    await loadArticleDocumentId();
    await loginStrapi();
  }
  if (sides.includes("honocms")) {
    await loadHonoArticleId();
  }

  const failures: CaptureFailure[] = [];
  for (const side of sides) {
    for (const screen of screens) {
      const url = urlFor(side, resolveSide(screen, side));
      console.log(`[parity:capture] (${side}) ${screen.id} ← ${url}`);
      try {
        await captureOne(args.driver, side, screen);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        failures.push({ side, screenId: screen.id, error: message });
        console.error(
          `[parity:capture] FAILED (${side}) ${screen.id}: ${message}`
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(`[parity:capture] ${failures.length} failure(s):`);
    for (const f of failures) {
      console.error(`  - (${f.side}) ${f.screenId}: ${f.error}`);
    }
    process.exit(1);
  }
  console.log("[parity:capture] done");
}

const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return resolve(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(
      "[parity:capture] failed:",
      error instanceof Error ? error.stack ?? error.message : error
    );
    process.exit(1);
  });
}
