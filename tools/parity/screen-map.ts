/**
 * Canonical screen map for the Strapi pixel-parity harness.
 *
 * Per docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md
 * Screen Map (12 entries, ids `01-login` through `12-ct-add-field-modal`).
 *
 * Strapi paths are appended to `http://localhost:1337`; hono-cms paths are
 * appended to `http://localhost:5173`. Viewport is `1440x900` for every
 * screen so captures are directly comparable.
 */

import type { ScreenSpec } from "./types.ts";

const VIEWPORT = { width: 1440, height: 900 } as const;

/**
 * The 12 canonical screens. Order is significant — `capture.ts` and
 * `diff.ts` iterate this array and `report.ts` uses it for stable ordering.
 */
export const SCREEN_MAP: readonly ScreenSpec[] = [
  {
    id: "01-login",
    label: "Login",
    strapi: { path: "/admin/auth/login" },
    honocms: { path: "/login" },
    viewport: VIEWPORT
  },
  {
    id: "02-dashboard",
    label: "Dashboard / Home",
    strapi: { path: "/admin" },
    honocms: { path: "/content" },
    viewport: VIEWPORT
  },
  {
    id: "03-content-list",
    label: "Collection list (with rows)",
    strapi: {
      path: "/admin/content-manager/collection-types/api::article.article"
    },
    honocms: { path: "/content/articles" },
    viewport: VIEWPORT
  },
  {
    id: "04-content-list-filter-open",
    label: "Collection list — filter chip open",
    strapi: {
      path: "/admin/content-manager/collection-types/api::article.article",
      prep: "click filter chip to open dropdown"
    },
    honocms: {
      path: "/content/articles",
      prep: "click filter chip to open dropdown"
    },
    viewport: VIEWPORT
  },
  {
    id: "05-record-edit",
    label: "Record edit",
    strapi: {
      path: "/admin/content-manager/collection-types/api::article.article/1"
    },
    honocms: { path: "/content/articles/1" },
    viewport: VIEWPORT
  },
  {
    id: "06-record-edit-info-panel",
    label: "Record edit — right info panel",
    strapi: {
      path: "/admin/content-manager/collection-types/api::article.article/1",
      prep: "ensure right information panel is visible"
    },
    honocms: {
      path: "/content/articles/1",
      prep: "ensure right information panel is visible"
    },
    viewport: VIEWPORT
  },
  {
    id: "07-media-grid",
    label: "Media library — grid",
    strapi: { path: "/admin/plugins/upload" },
    honocms: { path: "/media" },
    viewport: VIEWPORT
  },
  {
    id: "08-media-upload-modal",
    label: "Media library — upload modal",
    strapi: {
      path: "/admin/plugins/upload",
      prep: "click upload button to open upload modal"
    },
    honocms: {
      path: "/media",
      prep: "click upload button to open upload modal"
    },
    viewport: VIEWPORT
  },
  {
    id: "09-settings-home",
    label: "Settings home",
    strapi: { path: "/admin/settings/application-infos" },
    honocms: { path: "/settings/health" },
    viewport: VIEWPORT
  },
  {
    id: "10-api-tokens",
    label: "API tokens list",
    strapi: { path: "/admin/settings/api-tokens" },
    honocms: { path: "/settings/api-keys" },
    viewport: VIEWPORT
  },
  {
    id: "11-ct-builder-form",
    label: "Content-Type Builder (form view)",
    strapi: {
      path: "/admin/plugins/content-type-builder/content-types/api::article.article"
    },
    honocms: { path: "/settings/content-types" },
    viewport: VIEWPORT
  },
  {
    id: "12-ct-add-field-modal",
    label: "Content-Type Builder — add field modal",
    strapi: {
      path: "/admin/plugins/content-type-builder/content-types/api::article.article",
      prep: "click add-another-field to open field type picker dialog"
    },
    honocms: {
      path: "/settings/content-types",
      prep: "click add-another-field to open field type picker dialog"
    },
    viewport: VIEWPORT
  }
] as const;

/** Lookup helper used by the CLI when `--screen=<id>` is provided. */
export function findScreen(id: string): ScreenSpec | undefined {
  return SCREEN_MAP.find((screen) => screen.id === id);
}
