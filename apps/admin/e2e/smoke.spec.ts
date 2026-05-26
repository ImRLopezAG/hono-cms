import { test, expect } from "@playwright/test";
import { seedAdminToken } from "./helpers";

test.describe("admin smoke", () => {
  test("login page renders branded auth shell", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Hono CMS").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"], input[name="password"]').first()).toBeVisible();
  });

  test("authenticated bearer token unlocks content workspace", async ({ page, context }) => {
    await seedAdminToken(context);
    await page.goto("/content");
    await page.waitForLoadState("networkidle");
    expect(page.url()).not.toMatch(/\/login/);
    await expect(page.getByText("Hono CMS").first()).toBeVisible();
  });

  test("schema visualizer mounts the React Flow canvas", async ({ page, context }) => {
    await seedAdminToken(context);
    await page.goto("/settings/content-types/visualizer");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".react-flow, [data-testid='rf__wrapper']").first()).toBeVisible({ timeout: 15_000 });
  });
});
