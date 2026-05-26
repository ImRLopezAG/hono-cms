import { test, expect } from "@playwright/test";
import { createPostViaApi, seedAdminToken } from "./helpers";

const COLLECTION = "articles";

test.describe("audit log", () => {
  test("shows a recent create entry for the seeded record", async ({ page, request, context }) => {
    await seedAdminToken(context);

    // Trigger a `create` audit event via the API.
    const record = await createPostViaApi(request, { collection: COLLECTION });
    expect(record.id).toBeTruthy();

    await page.goto("/settings/audit-log");
    await expect(page).toHaveURL(/\/settings\/audit-log/);
    // SettingsShell renders the canonical page title with an `id`. The workspace
    // header in the chrome ALSO mirrors that title, so scope to the shell-owned
    // heading to avoid a strict-mode collision.
    await expect(page.locator("#settings-audit-log-title")).toBeVisible();

    // Filter to the collection so the row we care about is on the first page,
    // even after many runs accumulate audit history.
    const collectionFilter = page.getByPlaceholder(/collection/i).first();
    await collectionFilter.fill(COLLECTION);
    await page.getByRole("button", { name: /^apply$/i }).click();

    // At least one row whose collection cell matches and operation cell is `create`.
    const tableRows = page.locator("table tbody tr");
    await expect(tableRows.first()).toBeVisible({ timeout: 10_000 });

    // Find a row that contains both `articles` and `create` somewhere in its cells.
    const matchingRow = tableRows.filter({ hasText: COLLECTION }).filter({ hasText: /create/i }).first();
    await expect(matchingRow).toBeVisible({ timeout: 10_000 });
  });
});
