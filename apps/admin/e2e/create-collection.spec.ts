import { test, expect } from "@playwright/test";
import { seedAdminToken } from "./helpers";

const CMS_BASE_URL = process.env.PLAYWRIGHT_CMS_BASE_URL ?? "http://127.0.0.1:8787";

test.describe("create collection from the web", () => {
  /**
   * The Strapi-mirror flow:
   *   1. Click "Create new collection type" in Rail 2.
   *   2. A modal dialog opens with Display name + auto-derived API IDs +
   *      Draft & Publish toggle.
   *   3. Click Continue. Dialog closes; form enters create mode pre-populated
   *      with the chosen plural API ID + draftAndPublish flag.
   *   4. Click Create. Backend persists the new collection. /cms/schema and
   *      Rail 2 both reflect it.
   *
   * Known runtime gap (documented separately):
   *   GET /api/<new-collection> returns 404 until the dev-server restarts —
   *   the CMS instance does not hot-reload the new collection's REST route.
   */
  test("operator creates a brand-new collection via the dialog wizard", async ({
    page,
    context,
    request
  }) => {
    await seedAdminToken(context);

    const displayName = `Dialog Test ${Date.now().toString(36)}`;

    await page.goto("/settings/content-types");
    await page.waitForLoadState("networkidle");

    // Stage 1: open the wizard dialog.
    await page.getByRole("button", { name: /create new collection type/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/create a collection type/i)).toBeVisible();

    // Stage 2: fill Display name, watch API IDs auto-derive.
    const displayNameInput = dialog.getByLabel(/display name/i);
    await displayNameInput.fill(displayName);

    const pluralInput = dialog.getByLabel(/api id \(plural\)/i);
    const pluralValue = await pluralInput.inputValue();
    expect(pluralValue.length).toBeGreaterThan(0);
    // Display name "Dialog Test 1abc" → plural "dialog-test-1abcs"
    expect(pluralValue).toMatch(/^[a-z][a-z0-9-]*s$/);

    // Stage 3: Continue closes the dialog and enters create mode.
    await dialog.getByRole("button", { name: /continue/i }).click();
    await expect(dialog).not.toBeVisible();

    // The form's Name field should be pre-filled with the plural API ID.
    const formNameInput = page
      .locator('input[name="name"], input[placeholder*="name" i], input[id*="name" i]')
      .first();
    await expect(formNameInput).toHaveValue(pluralValue);

    // Stage 4: save. Header button flips from "Create" once persisted.
    await page.getByRole("button", { name: /^create$/i }).last().click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);

    // Stage 5: /cms/schema contains the new collection.
    const schemaResponse = await request.get(`${CMS_BASE_URL}/cms/schema`, {
      headers: { Authorization: "Bearer admin" }
    });
    expect(schemaResponse.ok()).toBe(true);
    const schema = (await schemaResponse.json()) as {
      collections: Record<string, unknown>;
    };
    expect(Object.keys(schema.collections)).toContain(pluralValue);

    // Stage 6: Rail 2 lists the new collection.
    const railItem = page.getByRole("button", { name: new RegExp(pluralValue) });
    await expect(railItem).toBeVisible({ timeout: 5000 });
  });

  test("dialog blocks Continue when API ID conflicts with an existing collection", async ({
    page,
    context
  }) => {
    await seedAdminToken(context);

    await page.goto("/settings/content-types");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /create new collection type/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // "Author" → "authors" — collides with the seeded `authors` collection.
    await dialog.getByLabel(/display name/i).fill("Author");

    // Validation message should appear.
    await expect(dialog.getByText(/already exists/i)).toBeVisible();

    // Continue button is disabled.
    const continueButton = dialog.getByRole("button", { name: /continue/i });
    await expect(continueButton).toBeDisabled();

    // Cancel closes the dialog without side-effects.
    await dialog.getByRole("button", { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible();
  });
});
