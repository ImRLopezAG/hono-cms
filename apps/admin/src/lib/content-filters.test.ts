import { describe, expect, it } from "vitest";
import type { AdminContentRecord } from "./api-client";
import {
  FILTER_OPERATORS,
  applyContentFilters,
  emptyFilter,
  filterIsActive,
  type ContentFilter
} from "./content-filters";

const records: AdminContentRecord[] = [
  { id: "art_1", title: "Hello World", status: "published", views: "120", createdAt: "", updatedAt: "" } as AdminContentRecord,
  { id: "art_2", title: "Hi there", status: "draft", views: "5", createdAt: "", updatedAt: "" } as AdminContentRecord,
  { id: "art_3", title: "Goodbye Sky", status: "published", views: "42", createdAt: "", updatedAt: "" } as AdminContentRecord
];

function f(field: string, operator: ContentFilter["operator"], value: string): ContentFilter {
  return { id: `${field}:${operator}:${value}`, field, operator, value };
}

describe("content filters — popover model", () => {
  it("exposes the seven Strapi-aligned operators", () => {
    expect(FILTER_OPERATORS.map((entry) => entry.value)).toEqual([
      "eq",
      "ne",
      "contains",
      "startsWith",
      "endsWith",
      "gt",
      "lt"
    ]);
  });

  it("creates blank filters that aren't 'active' until a value is typed", () => {
    const filter = emptyFilter("title");
    expect(filter.field).toBe("title");
    expect(filter.value).toBe("");
    expect(filterIsActive(filter)).toBe(false);
    expect(filterIsActive({ ...filter, value: "hi" })).toBe(true);
  });
});

describe("content filters — client-side application", () => {
  it("returns every record when nothing is filtered", () => {
    expect(applyContentFilters(records, [])).toHaveLength(records.length);
    expect(applyContentFilters(records, [f("title", "contains", "  ")])).toHaveLength(records.length);
  });

  it("matches contains case-insensitively", () => {
    // "hi" appears in "Hi there" but NOT in "Hello World" (h-e, not h-i).
    expect(applyContentFilters(records, [f("title", "contains", "hi")])).toHaveLength(1);
    // "o" appears in "Hello World" and "Goodbye Sky".
    expect(applyContentFilters(records, [f("title", "contains", "O")])).toHaveLength(2);
  });

  it("filters by equality, inequality, and prefix/suffix", () => {
    expect(applyContentFilters(records, [f("status", "eq", "draft")])).toHaveLength(1);
    expect(applyContentFilters(records, [f("status", "ne", "published")])).toHaveLength(1);
    expect(applyContentFilters(records, [f("title", "startsWith", "Hi")])).toHaveLength(1);
    expect(applyContentFilters(records, [f("title", "endsWith", "Sky")])).toHaveLength(1);
  });

  it("compares numerically when both sides parse as numbers", () => {
    expect(applyContentFilters(records, [f("views", "gt", "10")]).map((record) => record.id)).toEqual(["art_1", "art_3"]);
    expect(applyContentFilters(records, [f("views", "lt", "50")]).map((record) => record.id)).toEqual(["art_2", "art_3"]);
  });

  it("combines multiple filters with AND", () => {
    expect(applyContentFilters(records, [
      f("status", "eq", "published"),
      f("title", "contains", "hello")
    ])).toHaveLength(1);
  });
});
