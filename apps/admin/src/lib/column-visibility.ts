/**
 * Tiny persistence helper for the content manager column-visibility menu.
 *
 * Strapi's content-manager remembers the operator's table layout choices
 * across reloads via local persistence. We do the same — keyed per
 * collection so different content types can hide independent columns.
 *
 * Storage key shape: `hono-cms:content-cols:<collection>` → JSON array
 * of column ids that should be HIDDEN. Visible-by-default columns stay
 * unrecorded so adding new collection fields surfaces them
 * automatically.
 */

const STORAGE_PREFIX = "hono-cms:content-cols:";

export function columnVisibilityStorageKey(collection: string): string {
  return `${STORAGE_PREFIX}${collection}`;
}

export function readHiddenColumns(
  collection: string,
  storage: Pick<Storage, "getItem"> | undefined = typeof globalThis.localStorage === "undefined"
    ? undefined
    : globalThis.localStorage
): string[] {
  if (!collection || !storage) return [];
  try {
    const raw = storage.getItem(columnVisibilityStorageKey(collection));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export function writeHiddenColumns(
  collection: string,
  hidden: ReadonlyArray<string>,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = typeof globalThis.localStorage === "undefined"
    ? undefined
    : globalThis.localStorage
): void {
  if (!collection || !storage) return;
  const key = columnVisibilityStorageKey(collection);
  if (hidden.length === 0) {
    try {
      storage.removeItem(key);
    } catch {
      /* swallow */
    }
    return;
  }
  try {
    storage.setItem(key, JSON.stringify(Array.from(hidden)));
  } catch {
    /* swallow */
  }
}

export function toggleHiddenColumn(hidden: ReadonlyArray<string>, columnId: string): string[] {
  return hidden.includes(columnId) ? hidden.filter((entry) => entry !== columnId) : [...hidden, columnId];
}

export function visibleColumnIds(allColumns: ReadonlyArray<string>, hidden: ReadonlyArray<string>): string[] {
  const hiddenSet = new Set(hidden);
  return allColumns.filter((id) => !hiddenSet.has(id));
}
