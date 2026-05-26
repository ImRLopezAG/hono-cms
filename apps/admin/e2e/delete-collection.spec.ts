import { test, expect } from "@playwright/test";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_TOKEN, seedAdminToken } from "./helpers";

const CMS_BASE_URL = process.env.PLAYWRIGHT_CMS_BASE_URL ?? "http://127.0.0.1:8787";
// `playwright.config.ts` sets `cwd: "../../examples/newsroom"` for the CMS web
// server. The generated-collections dir lives alongside that working dir.
const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_COLLECTIONS_DIR = resolve(
  __dirname,
  "../../../examples/newsroom/generated-collections"
);

test.describe("delete collection from the web", () => {
  /**
   * Closes the strict-audit P1 gap "CT Builder cannot delete collections".
   *
   * Flow:
   *   1. Seed admin token.
   *   2. Create a throwaway collection via REST so the test is self-contained.
   *   3. Navigate to /settings/content-types, pick the collection in Rail 2.
   *   4. Click Delete in the header, confirm via AlertDialog.
   *   5. Verify the schema no longer lists it.
   *   6. Verify the generated file was removed from disk.
   */
  test("operator deletes a collection via the Content-Type Builder header", async ({
    page,
    context,
    request
  }) => {
    await seedAdminToken(context);

    const collectionName = `delete-test-${Date.now().toString(36)}`;

    // Step 2: create the throwaway collection so we always have something to
    // remove. The fields/options are minimal but valid for the schema writer.
    const createResponse = await request.post(`${CMS_BASE_URL}/cms/content-types`, {
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json"
      },
      data: {
        name: collectionName,
        fields: { title: { kind: "string", required: true } },
        options: { timestamps: true }
      }
    });
    expect(createResponse.ok()).toBe(true);

    const generatedFile = `${GENERATED_COLLECTIONS_DIR}/${collectionName}.ts`;
    await access(generatedFile); // confirm the writer staged the file

    // Step 3: open the CT Builder + select the new collection in Rail 2.
    await page.goto("/settings/content-types");
    await page.waitForLoadState("networkidle");

    const railItem = page.getByRole("button", { name: new RegExp(`^${collectionName}$`) });
    await expect(railItem).toBeVisible({ timeout: 7_500 });
    await railItem.click();

    // Step 4: trigger the danger button and confirm in the AlertDialog.
    // The button advertises itself with a stable test id so we don't collide
    // with rail items whose accessible name happens to contain the collection.
    const deleteButton = page.getByTestId("delete-content-type");
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/delete content type/i)).toBeVisible();
    await dialog.getByRole("button", { name: /delete collection/i }).click();

    // Wait for the mutation to settle (toast + schema invalidate + Rail 2 update).
    await expect(dialog).not.toBeVisible();
    await expect(railItem).toBeHidden({ timeout: 7_500 });

    // Step 5: /cms/schema must no longer expose the collection.
    const schemaResponse = await request.get(`${CMS_BASE_URL}/cms/schema`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    expect(schemaResponse.ok()).toBe(true);
    const schema = (await schemaResponse.json()) as { collections: Record<string, unknown> };
    expect(Object.keys(schema.collections)).not.toContain(collectionName);

    // Step 6: the writer must have removed the generated file from disk.
    await expect(access(generatedFile)).rejects.toThrow();
  });
});
