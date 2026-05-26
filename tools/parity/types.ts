/**
 * Shared types for the Strapi pixel-parity harness.
 *
 * Per docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md U3 (R4).
 *
 * The {@link Manifest} schema is the contract emitted by `diff.ts` and consumed
 * by `report.ts`. It is regenerated on every run — never hand-edited.
 */

/**
 * One side of the parity comparison: a URL on either Strapi or hono-cms admin
 * plus an optional preparation step (e.g. open a filter dropdown).
 */
export type SideSpec = {
  /** Path under the side's base URL, e.g. `/admin/content-manager/...`. */
  readonly path: string;
  /**
   * Optional imperative description of an interaction to perform before
   * capture (e.g. `"click filter chip to open dropdown"`). Free-form English
   * — the harness logs it; agent-browser/Playwright operators consume it.
   */
  readonly prep?: string;
};

/** A single canonical screen pair. */
export type ScreenSpec = {
  /** Stable identifier like `"03-content-list"`. Filenames use this id. */
  readonly id: string;
  /** Human label for the report (e.g. `"Collection list (with rows)"`). */
  readonly label: string;
  /** Strapi side of the pair. */
  readonly strapi: SideSpec;
  /** hono-cms side of the pair. */
  readonly honocms: SideSpec;
  /** Viewport used for both sides — kept in the spec so capture is deterministic. */
  readonly viewport: { readonly width: number; readonly height: number };
};

/** Outcome status for a manifest entry. */
export type ManifestStatus = "pass" | "fail" | "incomplete";

/**
 * One row of the diff manifest. Captures both the input pair and the scoring
 * output so downstream report tooling has everything it needs.
 */
export type ManifestEntry = {
  readonly screenId: string;
  readonly strapiPath: string;
  readonly honocmsPath: string;
  /** Ratio of matching pixels: `1 - pixelDelta / totalPixels`, clamped to `[0, 1]`. */
  readonly similarityScore: number;
  /** Absolute pixel-delta count returned by pixelmatch. */
  readonly pixelDelta: number;
  readonly status: ManifestStatus;
  /** Free-form annotation (e.g. `"intentional divergence — branding"`). */
  readonly notes?: string;
  /** ISO timestamp when the diff was scored. */
  readonly capturedAt: string;
};

/** Top-level manifest written to `docs/screenshots/parity/manifest.json`. */
export type Manifest = {
  /** ISO timestamp the manifest was generated. */
  readonly generatedAt: string;
  /** Threshold (0..1) used for the pass/fail cutoff. */
  readonly threshold: number;
  /** One entry per screen in `SCREEN_MAP`. */
  readonly entries: readonly ManifestEntry[];
};
