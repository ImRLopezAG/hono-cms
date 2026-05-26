#!/usr/bin/env bun
/**
 * Asserts that the parity captures actually differ from one another.
 *
 * Why this exists: during U3 diagnostics we discovered that auth/seed bugs
 * had quietly produced a capture set where 9/12 Strapi PNGs hashed
 * identically (all redirected to /admin/auth/login or /admin/register). The
 * pixel diff still scored happily because both sides showed near-identical
 * login screens. This script is a falsifier that runs BEFORE `diff.ts` and
 * exits non-zero if too many duplicate hashes show up — meaning a real
 * capture problem the operator must fix (relogin, reseed, restart Strapi).
 *
 * Default threshold: at least 10 of 12 unique hashes per side (≥83%). One
 * intentional collision is allowed (e.g. screens 05 and 06 may legitimately
 * look identical if a side has no separate info-panel state). Two or more
 * collisions = abort.
 *
 * Usage:
 *   bun tools/parity/validate-captures.ts                    # both sides
 *   bun tools/parity/validate-captures.ts --side=strapi      # one side
 *   bun tools/parity/validate-captures.ts --min-unique=11    # stricter
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SCREEN_MAP } from "./screen-map.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PARITY_DIR = join(REPO_ROOT, "docs", "screenshots", "parity");

type Side = "strapi" | "honocms";

type CliArgs = {
  readonly side: "both" | Side;
  readonly minUnique: number;
};

function parseArgs(argv: readonly string[]): CliArgs {
  let side: CliArgs["side"] = "both";
  let minUnique = 10;
  for (const arg of argv) {
    if (arg === "--side=strapi") side = "strapi";
    else if (arg === "--side=honocms") side = "honocms";
    else if (arg === "--side=both") side = "both";
    else if (arg.startsWith("--min-unique=")) {
      const n = Number(arg.slice("--min-unique=".length));
      if (Number.isFinite(n) && n > 0) minUnique = n;
    }
  }
  return { side, minUnique };
}

async function hashFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const buf = await readFile(path);
  return createHash("md5").update(buf).digest("hex");
}

type SideReport = {
  readonly side: Side;
  readonly hashes: ReadonlyArray<{
    readonly screenId: string;
    readonly hash: string | null;
  }>;
  readonly uniqueCount: number;
  readonly missingCount: number;
  readonly duplicateGroups: ReadonlyArray<{
    readonly hash: string;
    readonly screenIds: ReadonlyArray<string>;
  }>;
};

async function validateSide(side: Side): Promise<SideReport> {
  const dir = join(PARITY_DIR, side);
  const rows = await Promise.all(
    SCREEN_MAP.map(async (screen) => ({
      screenId: screen.id,
      hash: await hashFile(join(dir, `${screen.id}.png`))
    }))
  );

  const present = rows.filter((r) => r.hash !== null);
  const missingCount = rows.length - present.length;

  const byHash = new Map<string, string[]>();
  for (const row of present) {
    const list = byHash.get(row.hash!) ?? [];
    list.push(row.screenId);
    byHash.set(row.hash!, list);
  }
  const uniqueCount = byHash.size;
  const duplicateGroups = Array.from(byHash.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([hash, ids]) => ({ hash, screenIds: ids }));

  return {
    side,
    hashes: rows,
    uniqueCount,
    missingCount,
    duplicateGroups
  };
}

function printReport(report: SideReport, minUnique: number): boolean {
  console.log(`\n=== ${report.side} ===`);
  console.log(
    `  unique hashes: ${report.uniqueCount} / ${SCREEN_MAP.length} ` +
      `(min required: ${minUnique})`
  );
  if (report.missingCount > 0) {
    console.log(`  missing PNGs:  ${report.missingCount}`);
  }
  if (report.duplicateGroups.length > 0) {
    console.log("  duplicate groups:");
    for (const group of report.duplicateGroups) {
      console.log(
        `    - ${group.hash.slice(0, 8)}: ${group.screenIds.join(", ")}`
      );
    }
  }
  const ok = report.uniqueCount >= minUnique && report.missingCount === 0;
  console.log(`  status: ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sides: Side[] =
    args.side === "both" ? ["strapi", "honocms"] : [args.side];

  let allOk = true;
  for (const side of sides) {
    const report = await validateSide(side);
    if (!printReport(report, args.minUnique)) allOk = false;
  }
  console.log("");
  if (!allOk) {
    console.error(
      `[parity:validate] FAILED — re-run capture.ts after fixing auth/seed/prep issues.`
    );
    process.exit(1);
  }
  console.log("[parity:validate] OK — captures have sufficient variance.");
}

main().catch((error: unknown) => {
  console.error(
    "[parity:validate] failed:",
    error instanceof Error ? error.stack ?? error.message : error
  );
  process.exit(1);
});
