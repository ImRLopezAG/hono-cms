import type { AdminContentRecord } from "./api-client";

/**
 * Strapi-style filter chips for the content manager. Each filter is
 * `(field, operator, value)`. The popover supports adding several
 * filters, each combined with logical AND.
 *
 * Operators are intentionally a small, transferable subset that match
 * Strapi's `$eq / $ne / $contains / $startsWith / $endsWith /
 * $gt / $lt` semantics — enough to express the common editorial
 * queries without dragging the entire query language into the UI.
 */

export type ContentFilterOperator =
  | "eq"
  | "ne"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "lt";

export type ContentFilter = {
  /** Internal id, used as React key. */
  id: string;
  field: string;
  operator: ContentFilterOperator;
  value: string;
};

export const FILTER_OPERATORS: ReadonlyArray<{ value: ContentFilterOperator; label: string }> = [
  { value: "eq", label: "equals" },
  { value: "ne", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "startsWith", label: "starts with" },
  { value: "endsWith", label: "ends with" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" }
];

export function emptyFilter(field: string): ContentFilter {
  return { id: `filter_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, field, operator: "contains", value: "" };
}

export function filterIsActive(filter: ContentFilter): boolean {
  return filter.value.trim().length > 0;
}

/**
 * Client-side application of the filters against the already-fetched
 * record page. This keeps the contract narrow — the network request
 * still only carries `search / status / sort`, but the popover can
 * refine the displayed slice without a round-trip.
 *
 * If/when the API exposes structured filter params we can swap this for
 * a server-side encoder; the popover schema (`ContentFilter`) is
 * deliberately framed so that move is just one function away.
 */
export function applyContentFilters(records: ReadonlyArray<AdminContentRecord>, filters: ReadonlyArray<ContentFilter>): AdminContentRecord[] {
  const active = filters.filter(filterIsActive);
  if (active.length === 0) return [...records];
  return records.filter((record) => active.every((filter) => recordMatchesFilter(record, filter)));
}

function recordMatchesFilter(record: AdminContentRecord, filter: ContentFilter): boolean {
  const raw = (record as Record<string, unknown>)[filter.field];
  const stringValue = raw === null || raw === undefined ? "" : String(raw);
  const lhs = stringValue.toLowerCase();
  const rhs = filter.value.trim().toLowerCase();
  switch (filter.operator) {
    case "eq":
      return lhs === rhs;
    case "ne":
      return lhs !== rhs;
    case "contains":
      return lhs.includes(rhs);
    case "startsWith":
      return lhs.startsWith(rhs);
    case "endsWith":
      return lhs.endsWith(rhs);
    case "gt":
      return compareNumeric(lhs, rhs) > 0;
    case "lt":
      return compareNumeric(lhs, rhs) < 0;
    default:
      return true;
  }
}

function compareNumeric(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}
