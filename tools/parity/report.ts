#!/usr/bin/env bun
/**
 * Generate a human-readable parity report from the diff manifest.
 *
 * Reads `docs/screenshots/parity/manifest.json` and writes
 * `docs/screenshots/parity/REPORT.md` with a markdown table sorted so that
 * `fail` and `incomplete` rows surface before `pass`, making problems
 * visible at a glance for reviewers.
 *
 * Per docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md U11.
 *
 * Usage:
 *   bun tools/parity/report.ts            # write REPORT.md
 *   bun tools/parity/report.ts --help
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SCREEN_MAP } from "./screen-map.ts";
import type { Manifest, ManifestEntry, ManifestStatus } from "./types.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PARITY_DIR = join(REPO_ROOT, "docs", "screenshots", "parity");
const MANIFEST_PATH = join(PARITY_DIR, "manifest.json");
const REPORT_PATH = join(PARITY_DIR, "REPORT.md");

const STATUS_RANK: Record<ManifestStatus, number> = {
  fail: 0,
  incomplete: 1,
  pass: 2
};

function labelFor(screenId: string): string {
  return SCREEN_MAP.find((s) => s.id === screenId)?.label ?? screenId;
}

function formatSimilarity(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function statusBadge(status: ManifestStatus): string {
  switch (status) {
    case "pass":
      return "pass";
    case "fail":
      return "FAIL";
    case "incomplete":
      return "incomplete";
  }
}

export function renderReport(manifest: Manifest): string {
  const sorted = [...manifest.entries].sort((a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (byStatus !== 0) return byStatus;
    return a.screenId.localeCompare(b.screenId);
  });

  const rows = sorted.map((entry: ManifestEntry) => {
    const cells = [
      entry.screenId,
      labelFor(entry.screenId),
      formatSimilarity(entry.similarityScore),
      statusBadge(entry.status),
      entry.notes ?? ""
    ];
    return `| ${cells.join(" | ")} |`;
  });

  const tally = manifest.entries.reduce<Record<ManifestStatus, number>>(
    (acc, entry) => {
      acc[entry.status] = (acc[entry.status] ?? 0) + 1;
      return acc;
    },
    { pass: 0, fail: 0, incomplete: 0 }
  );

  const lines = [
    "# Strapi parity report",
    "",
    `Generated: ${manifest.generatedAt}`,
    `Threshold: ${(manifest.threshold * 100).toFixed(0)}% pixel-delta budget`,
    `Total screens: ${manifest.entries.length} — pass: ${tally.pass}, fail: ${tally.fail}, incomplete: ${tally.incomplete}`,
    "",
    "Rows are sorted with `fail` and `incomplete` first so reviewers see problems immediately.",
    "",
    "| Screen ID | Label | Similarity | Status | Notes |",
    "|---|---|---|---|---|",
    ...rows,
    ""
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      [
        "bun tools/parity/report.ts — render REPORT.md from manifest.json",
        "",
        `Reads:  ${MANIFEST_PATH}`,
        `Writes: ${REPORT_PATH}`,
        ""
      ].join("\n")
    );
    return;
  }

  let manifestText: string;
  try {
    manifestText = await readFile(MANIFEST_PATH, "utf8");
  } catch {
    console.error(
      `[parity:report] manifest not found at ${MANIFEST_PATH}. Run \`bun tools/parity/diff.ts\` first.`
    );
    process.exit(1);
  }

  const manifest = JSON.parse(manifestText) as Manifest;
  const report = renderReport(manifest);
  await writeFile(REPORT_PATH, report);
  console.log(`[parity:report] wrote ${REPORT_PATH}`);
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
      "[parity:report] failed:",
      error instanceof Error ? error.stack ?? error.message : error
    );
    process.exit(1);
  });
}
