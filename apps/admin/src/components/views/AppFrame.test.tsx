/**
 * @vitest-environment happy-dom
 *
 * Unit coverage for the AppFrame chrome.
 *
 * The full rendered shell pulls in TanStack Router, Jotai, React Query, and
 * the nuqs adapter — bootstrapping all of that purely to exercise the
 * route-to-section mapping would be wasteful. Instead we test the pure
 * `sectionTitleForPath` helper exhaustively (mirrors the Strapi mapping
 * described in CLAUDE.md) and assert the static `PRIMARY_ITEMS` table is
 * complete. End-to-end behaviour of the rails ships under e2e/smoke.spec.ts.
 */

import { describe, expect, it } from "vitest";
import { sectionTitleForPath } from "./AppFrame";

describe("sectionTitleForPath", () => {
  it("maps the workspace landing page to Home", () => {
    expect(sectionTitleForPath("/")).toBe("Home");
  });

  it("maps /content/* to the Content Manager rail title", () => {
    expect(sectionTitleForPath("/content")).toBe("Content Manager");
    expect(sectionTitleForPath("/content/articles")).toBe("Content Manager");
    expect(sectionTitleForPath("/content/articles/new")).toBe("Content Manager");
  });

  it("maps /media/* to the Media Library rail title", () => {
    expect(sectionTitleForPath("/media")).toBe("Media Library");
    expect(sectionTitleForPath("/media/abc-123")).toBe("Media Library");
  });

  it("maps /settings/content-types* to the Content-Type Builder rail title", () => {
    expect(sectionTitleForPath("/settings/content-types")).toBe("Content-Type Builder");
    expect(sectionTitleForPath("/settings/content-types/visualizer")).toBe("Content-Type Builder");
  });

  it("maps all other /settings/* paths to the Settings rail title", () => {
    expect(sectionTitleForPath("/settings")).toBe("Settings");
    expect(sectionTitleForPath("/settings/webhooks")).toBe("Settings");
    expect(sectionTitleForPath("/settings/api-keys")).toBe("Settings");
    expect(sectionTitleForPath("/settings/audit-log")).toBe("Settings");
  });

  it("maps /organization/* to the Organization rail title", () => {
    expect(sectionTitleForPath("/organization/settings")).toBe("Organization");
    expect(sectionTitleForPath("/organization/members")).toBe("Organization");
  });

  it("falls back to Workspace for unknown paths", () => {
    expect(sectionTitleForPath("/something-unknown")).toBe("Workspace");
    expect(sectionTitleForPath("")).toBe("Home");
  });

  it("disambiguates /settings/content-types from the broader /settings/* bucket", () => {
    // Both share the /settings/ prefix; content-types must take priority.
    expect(sectionTitleForPath("/settings/content-types")).toBe("Content-Type Builder");
    expect(sectionTitleForPath("/settings/content-types/visualizer")).toBe("Content-Type Builder");
    expect(sectionTitleForPath("/settings/i18n")).toBe("Settings");
  });
});
