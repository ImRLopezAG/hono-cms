import type { AuditDiff, ContentRecord } from "@hono-cms/core";

/**
 * Options that control which fields are emitted into a diff and how oversized
 * values are folded.
 */
export type ComputeDiffOptions = {
  /** Field names that should never appear in the recorded diff. */
  excludeFields?: readonly string[];
  /** Maximum bytes per serialized field before it is replaced with a stub. */
  maxFieldBytes?: number;
};

const DEFAULT_EXCLUDES = ["password", "token", "secret", "cookie", "authorization"] as const;
const DEFAULT_MAX_FIELD_BYTES = 10 * 1024;

/**
 * Compute a structural diff between two content records.
 *
 * Both inputs are optional. A `null` `before` represents creation; a `null`
 * `after` represents deletion.
 *
 * Fields whose names appear in `excludeFields` (or in the always-on
 * {@link DEFAULT_EXCLUDES} list) are stripped from the diff entirely.
 *
 * Field values that serialize to more than `maxFieldBytes` bytes are replaced
 * with a `{ truncated: true, length }` stub so a single oversized blob can
 * never blow up the audit table.
 */
export function computeDiff(
  before: ContentRecord | null,
  after: ContentRecord | null,
  config: ComputeDiffOptions = {}
): AuditDiff {
  const exclude = new Set<string>([...DEFAULT_EXCLUDES, ...(config.excludeFields ?? [])]);
  const maxFieldBytes = config.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const beforeDiff: Record<string, unknown> = {};
  const afterDiff: Record<string, unknown> = {};

  for (const key of keys) {
    if (exclude.has(key)) continue;
    const previous = before?.[key];
    const next = after?.[key];
    if (deepEqual(previous, next)) continue;
    beforeDiff[key] = truncate(previous, maxFieldBytes);
    afterDiff[key] = truncate(next, maxFieldBytes);
  }

  return {
    before: before ? beforeDiff : null,
    after: after ? afterDiff : null
  };
}

function truncate(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized == null || serialized.length <= maxBytes) return value;
  return { truncated: true, length: serialized.length };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
