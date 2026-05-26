import { test, expect } from "@playwright/test";
import { createPostViaApi, seedAdminToken } from "./helpers";

const COLLECTION = "articles";

test.describe("draft → publish cycle", () => {
  test("publish an existing draft article from the editor", async ({ page, request, context }) => {
    await seedAdminToken(context);

    // Seed a draft via the CMS API so the test focuses on the publish flow.
    const record = await createPostViaApi(request, { collection: COLLECTION });
    expect(record.id).toBeTruthy();

    await page.goto(`/content/${COLLECTION}/${record.id}`);
    await expect(page).toHaveURL(new RegExp(`/content/${COLLECTION}/${record.id}`));

    // The status sidebar starts as "Draft" for newly-created records.
    await expect(page.getByText(/^Draft$/).first()).toBeVisible({ timeout: 10_000 });

    // Click the "Publish to users" button rendered by the status panel.
    const publishButton = page.getByRole("button", { name: /publish to users/i });
    await expect(publishButton).toBeVisible();
    await publishButton.click();

    // Toast confirms the publish operation.
    await expect(page.getByText(/record published/i).first()).toBeVisible({ timeout: 10_000 });

    // Status badge flips to "Published".
    await expect(page.getByText(/^Published$/).first()).toBeVisible({ timeout: 10_000 });
  });
});
