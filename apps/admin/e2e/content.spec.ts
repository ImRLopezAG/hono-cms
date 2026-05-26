import { test, expect } from "@playwright/test";
import { seedAdminToken } from "./helpers";

// The newsroom example schema exposes `articles` (draftAndPublish enabled),
// not `posts` — the spec uses `articles` so the API routes & schema match
// the fixture seeded by `examples/newsroom/src/dev-server.ts`.
const COLLECTION = "articles";

test.describe("content workflow", () => {
  test("create a new article, save it, and see it in the list", async ({ page, context }) => {
    await seedAdminToken(context);
    await page.goto("/content");
    await expect(page).toHaveURL(/\/content/);

    // Click the collection in the rail. CollectionRail renders a button whose
    // accessible name is "<collection> <fieldCount>" (e.g. "articles 5").
    const railButton = page
      .getByRole("complementary", { name: /collections/i })
      .getByRole("button", { name: new RegExp(`^${COLLECTION}\\s+\\d+$`) });
    await expect(railButton).toBeVisible();
    await railButton.click();
    await expect(page).toHaveURL(new RegExp(`/content/${COLLECTION}`));

    // Open the editor for a new record.
    const createButton = page.getByRole("button", { name: /create new/i });
    await expect(createButton).toBeVisible();
    await createButton.click();
    await expect(page).toHaveURL(new RegExp(`/content/${COLLECTION}/new`));

    // Editor heading confirms we're in the new-record form.
    await expect(page.getByRole("heading", { name: new RegExp(`New ${COLLECTION}`, "i") })).toBeVisible();

    const unique = Date.now().toString(36);
    const title = `E2E Article ${unique}`;
    const slug = `e2e-article-${unique}`;

    await page.locator('input[name="title"]').fill(title);
    await page.locator('input[name="slug"]').fill(slug);
    // `articles` does not have a `body` field; it has `summary` (textarea).
    await page.locator('textarea[name="summary"]').fill("<p>real</p>");

    // Save via the editor's primary button.
    await page.getByRole("button", { name: /^save$/i }).click();

    // Toast or status confirms the save.
    await expect(
      page.getByText(/record (created|saved)/i).first()
    ).toBeVisible({ timeout: 10_000 });

    // Wait for navigation/state to settle, then go back to the list.
    await page.waitForLoadState("networkidle");
    const backButton = page.getByRole("button", { name: /^back$/i });
    if (await backButton.isVisible().catch(() => false)) {
      await backButton.click();
    } else {
      await page.goto(`/content/${COLLECTION}`);
    }
    await expect(page).toHaveURL(new RegExp(`/content/${COLLECTION}(?!/)`));

    // The new row appears in the rendered table (virtualized, but newly-created
    // records are at the top of the default `-updatedAt` sort).
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  });
});
