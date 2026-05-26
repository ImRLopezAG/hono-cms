import { describe, expect, it } from "vitest";
import { isSettingsRoute, pageTitleForPath } from "./auth-helpers";

describe("shell routing helpers", () => {
  it("recognises every nested settings path", () => {
    expect(isSettingsRoute("/settings")).toBe(true);
    expect(isSettingsRoute("/settings/webhooks")).toBe(true);
    expect(isSettingsRoute("/settings/content-types/visualizer")).toBe(true);
  });

  it("treats /content, /media, and auth routes as non-settings", () => {
    expect(isSettingsRoute("/content")).toBe(false);
    expect(isSettingsRoute("/media")).toBe(false);
    expect(isSettingsRoute("/login")).toBe(false);
    expect(isSettingsRoute("/")).toBe(false);
  });

  it("derives editorial titles for the workspace top-bar", () => {
    expect(pageTitleForPath("/content/articles")).toEqual({ eyebrow: "Workspace", title: "Content manager" });
    expect(pageTitleForPath("/media")).toEqual({ eyebrow: "Workspace", title: "Media library" });
    expect(pageTitleForPath("/settings/webhooks")).toEqual({ eyebrow: "Settings", title: "Webhooks" });
    expect(pageTitleForPath("/settings/audit-log")).toEqual({ eyebrow: "Settings", title: "Audit log" });
    expect(pageTitleForPath("/organization/members")).toEqual({ eyebrow: "Organisation", title: "Members" });
  });

  it("prefers the most specific prefix when multiple match", () => {
    expect(pageTitleForPath("/settings/content-types/visualizer")).toEqual({
      eyebrow: "Settings",
      title: "Content-type visualizer"
    });
    expect(pageTitleForPath("/settings/content-types")).toEqual({
      eyebrow: "Settings",
      title: "Content types"
    });
  });

  it("falls back gracefully for unknown paths", () => {
    expect(pageTitleForPath("/something-new")).toEqual({ eyebrow: "Hono CMS", title: "Workspace" });
  });
});
