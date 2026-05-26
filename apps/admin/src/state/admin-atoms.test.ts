import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { appendToastAtom, authTokenAtom, commandPaletteOpenAtom, dirtyFieldsAtom, hasUnsavedChangesAtom, mediaPickerStateAtom, selectedItemsAtom, toastAtom } from "./admin-atoms";

describe("admin atoms", () => {
  it("keeps selected item sets isolated per store", () => {
    const first = createStore();
    const second = createStore();

    first.set(selectedItemsAtom, new Set(["article_1"]));

    expect([...first.get(selectedItemsAtom)]).toEqual(["article_1"]);
    expect([...second.get(selectedItemsAtom)]).toEqual([]);
  });

  it("derives unsaved changes from dirty field entries", () => {
    const store = createStore();

    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    store.set(dirtyFieldsAtom, { "articles:article_1": true });
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
    store.set(dirtyFieldsAtom, { "articles:article_1": false });
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
  });

  it("tracks command palette and media picker state", () => {
    const store = createStore();
    const resolve = vi.fn();

    expect(store.get(commandPaletteOpenAtom)).toBe(false);
    store.set(commandPaletteOpenAtom, true);
    store.set(mediaPickerStateAtom, { open: true, fieldId: "hero", resolve });

    expect(store.get(commandPaletteOpenAtom)).toBe(true);
    expect(store.get(mediaPickerStateAtom)).toEqual({ open: true, fieldId: "hero", resolve });
  });

  it("appends toast notifications with stable generated IDs", () => {
    const store = createStore();
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    store.set(appendToastAtom, { title: "Saved", tone: "success" });
    store.set(appendToastAtom, { id: "custom", title: "Failed", tone: "error" });

    expect(store.get(toastAtom)).toEqual([
      { id: "toast_1000_0", title: "Saved", tone: "success" },
      { id: "custom", title: "Failed", tone: "error" }
    ]);
  });

  it("starts without an implicit admin token", () => {
    const store = createStore();

    expect(store.get(authTokenAtom)).toBeNull();
    store.set(authTokenAtom, "admin");
    expect(store.get(authTokenAtom)).toBe("admin");
  });
});
