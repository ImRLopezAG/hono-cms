import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { AdminCollectionName } from "../lib/api-client";

export type MediaPickerState = {
  open: boolean;
  fieldId: string | null;
  resolve: ((assetId: string | null) => void) | null;
};

export type AdminToast = {
  id: string;
  title: string;
  description?: string;
  tone?: "info" | "success" | "error";
};

export const activeCollectionAtom = atom<AdminCollectionName>("articles");
export const selectedRecordIdAtom = atom<string | null>(null);
export const selectedItemsAtom = atom<Set<string>>(new Set<string>());
export const sidebarCollapsedAtom = atomWithStorage("hono-cms:sidebar-collapsed", false);
/**
 * When the operator enters `/settings/*` we auto-collapse the primary
 * sidebar so the nested settings sub-nav can claim the second column.
 * The atom persists so the preference survives reloads, exactly like
 * Strapi's `<Layouts.Root sideNav={<SettingsNav />}>` behaviour.
 */
export const sidebarAutoCollapsedBySettingsAtom = atom(false);
export const authTokenAtom = atomWithStorage<string | null>("hono-cms:auth-token", null);
/**
 * Locale currently being viewed/edited in admin views. `null` means the
 * collection's default locale. Persisted so locale stays sticky across
 * navigation and tab reloads.
 */
export const currentLocaleAtom = atomWithStorage<string | null>("hono-cms:current-locale", null);
export const dirtyFieldsAtom = atom<Record<string, boolean>>({});
export const hasUnsavedChangesAtom = atom((get) => Object.values(get(dirtyFieldsAtom)).some(Boolean));
export const commandPaletteOpenAtom = atom(false);
export const mediaPickerStateAtom = atom<MediaPickerState>({ open: false, fieldId: null, resolve: null });
export const builderDraftAtom = atom<Record<string, unknown> | null>(null);
export const toastAtom = atom<AdminToast[]>([]);
export const appendToastAtom = atom(null, (get, set, toast: Omit<AdminToast, "id"> & { id?: string }) => {
  const id = toast.id ?? `toast_${Date.now()}_${get(toastAtom).length}`;
  set(toastAtom, [...get(toastAtom), { ...toast, id }]);
});
