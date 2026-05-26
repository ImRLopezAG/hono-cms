#!/usr/bin/env bun
/**
 * Scoring CLI for the Strapi pixel-parity harness.
 *
 * Reads every PNG pair from `docs/screenshots/parity/{strapi,honocms}/`,
 * scores them via pixelmatch (perceptual threshold defaults to `0.10`),
 * writes a side-by-side composite to `docs/screenshots/parity/diff-overlays/`,
 * and (re)generates `docs/screenshots/parity/manifest.json`.
 *
 * Per docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md U3 (R4).
 *
 * Usage:
 *   bun tools/parity/diff.ts --help
 *   bun tools/parity/diff.ts
 *   bun tools/parity/diff.ts --threshold=0.15
 *   bun tools/parity/diff.ts --screen=03-content-list
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Notes file: an operator-curated `{ screenId: note }` map applied to every
 * manifest entry. Lives at `docs/screenshots/parity/notes.json` so the
 * auto-regenerated manifest carries documented divergences across runs.
 */
type NotesMap = Readonly<Record<string, string>>;

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import { SCREEN_MAP, findScreen } from "./screen-map.ts";
import type {
  Manifest,
  ManifestEntry,
  ManifestStatus,
  ScreenSpec
} from "./types.ts";

const DEFAULT_THRESHOLD = 0.1;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PARITY_DIR = join(REPO_ROOT, "docs", "screenshots", "parity");

/** Options for {@link scoreImages}. */
export type ScoreOptions = {
  /** Pixel-delta budget as a ratio of total pixels (0..1). Default `0.10`. */
  readonly threshold?: number;
  /** Pixelmatch perceptual threshold (0..1). Default `0.1`. */
  readonly pixelmatchThreshold?: number;
};

/** Output of {@link scoreImages}. */
export type ScoreResult = {
  readonly status: ManifestStatus;
  /** Ratio of matching pixels in `[0, 1]`, or `0` if incomplete. */
  readonly similarityScore: number;
  /** Absolute differing pixels reported by pixelmatch, or `0` if incomplete. */
  readonly pixelDelta: number;
  /** Side-by-side composite PNG, or `null` if one input was missing. */
  readonly overlay: Buffer | null;
  /** Set when status is `incomplete` so the caller can surface a reason. */
  readonly notes?: string;
};

/**
 * Pure scoring function — extracted so unit tests can hit it without disk I/O.
 *
 * - When either buffer is `null`, returns `incomplete` (don't crash).
 * - When both are present, decodes via pngjs and runs pixelmatch.
 * - `status` is `pass` when `pixelDelta / totalPixels <= threshold`, else `fail`.
 */
export function scoreImages(
  strapiBuf: Buffer | null,
  honoBuf: Buffer | null,
  opts: ScoreOptions = {}
): ScoreResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const pixelmatchThreshold = opts.pixelmatchThreshold ?? 0.1;

  if (!strapiBuf || !honoBuf) {
    const missingSides: string[] = [];
    if (!strapiBuf) missingSides.push("strapi");
    if (!honoBuf) missingSides.push("honocms");
    return {
      status: "incomplete",
      similarityScore: 0,
      pixelDelta: 0,
      overlay: null,
      notes: `missing capture for: ${missingSides.join(", ")}`
    };
  }

  const strapiPng = PNG.sync.read(strapiBuf);
  const honoPng = PNG.sync.read(honoBuf);

  // Normalize to a shared canvas: max(width) and max(height), white fill.
  const canvasWidth = Math.max(strapiPng.width, honoPng.width);
  const canvasHeight = Math.max(strapiPng.height, honoPng.height);
  const strapiCanvas = padToCanvas(strapiPng, canvasWidth, canvasHeight);
  const honoCanvas = padToCanvas(honoPng, canvasWidth, canvasHeight);

  const diffPng = new PNG({ width: canvasWidth, height: canvasHeight });
  const pixelDelta = pixelmatch(
    strapiCanvas.data,
    honoCanvas.data,
    diffPng.data,
    canvasWidth,
    canvasHeight,
    { threshold: pixelmatchThreshold, includeAA: false }
  );

  const totalPixels = canvasWidth * canvasHeight;
  const similarityScore = totalPixels === 0
    ? 0
    : Math.max(0, Math.min(1, 1 - pixelDelta / totalPixels));
  const status: ManifestStatus =
    totalPixels > 0 && pixelDelta / totalPixels <= threshold ? "pass" : "fail";

  const overlay = buildComposite(strapiPng, honoPng);
  return { status, similarityScore, pixelDelta, overlay };
}

/** Pad a PNG to a larger canvas with opaque white fill (top-left aligned). */
function padToCanvas(src: PNG, width: number, height: number): PNG {
  if (src.width === width && src.height === height) {
    return src;
  }
  const out = new PNG({ width, height });
  // Fill white.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 255;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const srcIdx = (y * src.width + x) * 4;
      const dstIdx = (y * width + x) * 4;
      out.data[dstIdx] = src.data[srcIdx]!;
      out.data[dstIdx + 1] = src.data[srcIdx + 1]!;
      out.data[dstIdx + 2] = src.data[srcIdx + 2]!;
      out.data[dstIdx + 3] = src.data[srcIdx + 3]!;
    }
  }
  return out;
}

/**
 * Build a side-by-side composite: Strapi on the left, hono-cms on the right.
 * Both sides are crop-padded to the same height with white fill.
 */
function buildComposite(strapi: PNG, hono: PNG): Buffer {
  const height = Math.max(strapi.height, hono.height);
  const width = strapi.width + hono.width;
  const out = new PNG({ width, height });
  // White fill.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 255;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  copyInto(strapi, out, 0, 0);
  copyInto(hono, out, strapi.width, 0);
  return PNG.sync.write(out);
}

function copyInto(src: PNG, dst: PNG, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const srcIdx = (y * src.width + x) * 4;
      const dstIdx = ((y + dy) * dst.width + (x + dx)) * 4;
      dst.data[dstIdx] = src.data[srcIdx]!;
      dst.data[dstIdx + 1] = src.data[srcIdx + 1]!;
      dst.data[dstIdx + 2] = src.data[srcIdx + 2]!;
      dst.data[dstIdx + 3] = src.data[srcIdx + 3]!;
    }
  }
}

type CliArgs = {
  readonly threshold: number;
  readonly screen: string;
  readonly help: boolean;
};

function parseArgs(argv: readonly string[]): CliArgs {
  let threshold = DEFAULT_THRESHOLD;
  let screen = "all";
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--threshold=")) {
      threshold = Number(arg.slice("--threshold=".length));
    } else if (arg.startsWith("--screen=")) {
      screen = arg.slice("--screen=".length);
    }
  }
  return { threshold, screen, help };
}

function printHelp(): void {
  process.stdout.write(
    [
      "bun tools/parity/diff.ts — score Strapi vs hono-cms parity captures",
      "",
      "Usage:",
      "  bun tools/parity/diff.ts                     # score every screen",
      "  bun tools/parity/diff.ts --screen=01-login   # score one screen",
      "  bun tools/parity/diff.ts --threshold=0.15    # override pass cutoff",
      "",
      "Inputs:",
      "  docs/screenshots/parity/strapi/<id>.png",
      "  docs/screenshots/parity/honocms/<id>.png",
      "",
      "Outputs:",
      "  docs/screenshots/parity/diff-overlays/<id>.png  (side-by-side composite)",
      "  docs/screenshots/parity/manifest.json           (regenerated from scratch)",
      ""
    ].join("\n")
  );
}

async function readPngIfExists(path: string): Promise<Buffer | null> {
  if (!existsSync(path)) return null;
  return await readFile(path);
}

async function loadNotes(): Promise<NotesMap> {
  const notesPath = join(PARITY_DIR, "notes.json");
  if (!existsSync(notesPath)) return {};
  try {
    const raw = JSON.parse(await readFile(notesPath, "utf8")) as Record<
      string,
      string
    >;
    // Strip metadata keys (anything starting with `_`).
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith("_") && typeof v === "string") filtered[k] = v;
    }
    return filtered;
  } catch (error: unknown) {
    console.warn(
      `[parity:diff] could not read notes.json: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {};
  }
}

async function scoreScreen(
  screen: ScreenSpec,
  threshold: number,
  notes: NotesMap
): Promise<ManifestEntry> {
  const strapiPath = join(PARITY_DIR, "strapi", `${screen.id}.png`);
  const honoPath = join(PARITY_DIR, "honocms", `${screen.id}.png`);
  const [strapiBuf, honoBuf] = await Promise.all([
    readPngIfExists(strapiPath),
    readPngIfExists(honoPath)
  ]);

  const result = scoreImages(strapiBuf, honoBuf, { threshold });

  if (result.overlay) {
    const overlayPath = join(
      PARITY_DIR,
      "diff-overlays",
      `${screen.id}.png`
    );
    await mkdir(dirname(overlayPath), { recursive: true });
    await writeFile(overlayPath, result.overlay);
  }

  // Merge precedence (last wins): scoring notes (incomplete reason) <
  // operator-curated note from `notes.json`. The latter is authoritative
  // for documented divergences (e.g. screen 06 is a no-op on hono-cms).
  const mergedNote = notes[screen.id] ?? result.notes;
  const entry: ManifestEntry = {
    screenId: screen.id,
    strapiPath,
    honocmsPath: honoPath,
    similarityScore: result.similarityScore,
    pixelDelta: result.pixelDelta,
    status: result.status,
    capturedAt: new Date().toISOString(),
    ...(mergedNote ? { notes: mergedNote } : {})
  };
  return entry;
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
            console.error(`[parity:diff] unknown screen id: ${args.screen}`);
            process.exit(1);
          }
          return [s];
        })();

  await mkdir(join(PARITY_DIR, "diff-overlays"), { recursive: true });
  const notes = await loadNotes();

  const entries: ManifestEntry[] = [];
  for (const screen of screens) {
    const entry = await scoreScreen(screen, args.threshold, notes);
    entries.push(entry);
    const pct = (entry.similarityScore * 100).toFixed(2);
    console.log(
      `[parity:diff] ${entry.screenId}: ${entry.status} (similarity ${pct}%, delta ${entry.pixelDelta})`
    );
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    threshold: args.threshold,
    entries
  };
  // Atomic write: stage to a sibling tmp file then rename so SIGINT during
  // write never leaves a half-written canonical manifest on disk.
  const manifestPath = join(PARITY_DIR, "manifest.json");
  const manifestTmpPath = `${manifestPath}.tmp`;
  await writeFile(manifestTmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(manifestTmpPath, manifestPath);
  console.log(`[parity:diff] manifest written: ${manifestPath}`);

  const anyFail = entries.some((e) => e.status === "fail");
  process.exit(anyFail ? 1 : 0);
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
      "[parity:diff] failed:",
      error instanceof Error ? error.stack ?? error.message : error
    );
    process.exit(1);
  });
}
