import { describe, expect, it } from "vitest";
import {
  columnVisibilityStorageKey,
  readHiddenColumns,
  toggleHiddenColumn,
  visibleColumnIds,
  writeHiddenColumns
} from "./column-visibility";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe("content-manager column visibility", () => {
  it("keys storage entries by collection", () => {
    expect(columnVisibilityStorageKey("articles")).toBe("hono-cms:content-cols:articles");
  });

  it("treats missing entries as 'nothing hidden'", () => {
    const storage = new MemoryStorage();
    expect(readHiddenColumns("articles", storage)).toEqual([]);
  });

  it("persists then restores hidden ids per collection", () => {
    const storage = new MemoryStorage();
    writeHiddenColumns("articles", ["id", "createdAt"], storage);
    expect(readHiddenColumns("articles", storage)).toEqual(["id", "createdAt"]);
  });

  it("removes the storage entry when nothing is hidden", () => {
    const storage = new MemoryStorage();
    writeHiddenColumns("articles", ["id"], storage);
    writeHiddenColumns("articles", [], storage);
    expect(readHiddenColumns("articles", storage)).toEqual([]);
    expect(storage.getItem(columnVisibilityStorageKey("articles"))).toBeNull();
  });

  it("ignores entries that aren't JSON arrays of strings", () => {
    const storage = new MemoryStorage();
    storage.setItem(columnVisibilityStorageKey("articles"), JSON.stringify({ id: true }));
    expect(readHiddenColumns("articles", storage)).toEqual([]);
    storage.setItem(columnVisibilityStorageKey("articles"), "not json");
    expect(readHiddenColumns("articles", storage)).toEqual([]);
  });

  it("toggles ids without mutating the source array", () => {
    expect(toggleHiddenColumn([], "id")).toEqual(["id"]);
    expect(toggleHiddenColumn(["id", "createdAt"], "id")).toEqual(["createdAt"]);
    expect(toggleHiddenColumn(["id"], "createdAt")).toEqual(["id", "createdAt"]);
  });

  it("derives the visible-column projection by removing hidden ids while preserving order", () => {
    expect(visibleColumnIds(["title", "status", "createdAt"], ["status"])).toEqual(["title", "createdAt"]);
    expect(visibleColumnIds(["title", "status"], [])).toEqual(["title", "status"]);
  });
});
