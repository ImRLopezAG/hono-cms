import { test, expect } from "@playwright/test";
import { seedAdminToken, ADMIN_TOKEN, CMS_BASE_URL } from "./helpers";

/**
 * Exercises the Media Library folder hierarchy end-to-end:
 *   1. Create a folder via the "Add new folder" dialog.
 *   2. Navigate into the folder via the Rail 2 tree (URL state lives in
 *      `?folder=<id>`, surfaced through nuqs).
 *   3. Delete the folder from the rail (cascade path — folder is empty so the
 *      backend returns 204 without `?force=true`).
 *
 * The spec talks to the same in-memory CMS the smoke tests use (see
 * `playwright.config.ts` for the webServer block). To keep folders unique
 * across reruns we append a timestamp suffix.
 */

test.describe("media folders", () => {
  test("creates a folder, navigates into it, and deletes it", async ({ page, context, request }) => {
    await seedAdminToken(context);
    await page.goto("/media");

    // Clean any leftover folder named E2E-* from a previous run to keep the
    // tree small and deterministic. The admin token has write access.
    const folderListResponse = await request.get(`${CMS_BASE_URL}/api/media/folders`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    if (folderListResponse.ok()) {
      const body = (await folderListResponse.json()) as { items: Array<{ id: string; name: string }> };
      for (const folder of body.items) {
        if (folder.name.startsWith("E2E-")) {
          await request.delete(`${CMS_BASE_URL}/api/media/folders/${folder.id}?force=true`, {
            headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
          });
        }
      }
    }
    await page.reload();
    await expect(page.getByRole("heading", { name: "Media library", level: 1 })).toBeVisible();

    const unique = Date.now().toString(36);
    const folderName = `E2E-${unique}`;

    // Open the "Add new folder" dialog from the header.
    await page.getByRole("button", { name: /add new folder/i }).first().click();

    const dialog = page.getByRole("dialog", { name: /add new folder/i });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/folder name/i).fill(folderName);
    await dialog.getByRole("button", { name: /create folder/i }).click();

    // Toast confirmation, dialog closes, URL gains ?folder=<id>.
    await expect(page.getByText(`Folder "${folderName}" created.`)).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/[?&]folder=/, { timeout: 10_000 });

    // The page heading switches to the active folder name.
    await expect(page.getByRole("heading", { name: folderName, level: 1 })).toBeVisible();

    // The Rail 2 nav shows the folder, with aria-current pointing at it.
    const rail = page.getByRole("navigation", { name: /media folders/i });
    const folderItem = rail.getByRole("button", { name: folderName, exact: true });
    await expect(folderItem).toBeVisible();
    await expect(folderItem).toHaveAttribute("aria-current", "page");

    // Click the "Media library" root in the breadcrumb to navigate out.
    await page
      .getByRole("navigation", { name: /folder breadcrumbs/i })
      .getByRole("button", { name: /media library/i })
      .click();
    await expect(page).not.toHaveURL(/[?&]folder=/);
    await expect(page.getByRole("heading", { name: "Media library", level: 1 })).toBeVisible();

    // Navigate back into the folder via the rail to confirm round-tripping works.
    await folderItem.click();
    await expect(page).toHaveURL(/[?&]folder=/);

    // Delete the folder via the rail's hover action. force-focus the item so
    // the action buttons (only revealed on hover) are visible.
    await folderItem.focus();
    await rail.getByRole("button", { name: new RegExp(`^Delete folder ${folderName}$`) }).click();

    const confirm = page.getByRole("alertdialog", { name: new RegExp(`Delete folder .${folderName}.`) });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: /delete folder/i }).click();

    await expect(page.getByText(/Folder deleted/i)).toBeVisible({ timeout: 10_000 });
    // We should be bounced back to the root (URL no longer carries ?folder=).
    await expect(page).not.toHaveURL(/[?&]folder=/, { timeout: 10_000 });
    await expect(rail.getByRole("button", { name: folderName, exact: true })).toHaveCount(0);
  });
});
