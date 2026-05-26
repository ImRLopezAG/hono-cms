import { test, expect } from "@playwright/test";
import { seedAdminToken } from "./helpers";

test.describe("command palette", () => {
  test("Control+K opens the palette and navigates to /media", async ({ page, context }) => {
    await seedAdminToken(context);
    await page.goto("/content");
    await page.waitForLoadState("networkidle");

    // Ensure the page accepts keyboard input.
    await page.locator("body").click({ position: { x: 10, y: 10 } });

    // The app's hotkey lib resolves "Mod+K" to Meta on Mac and Control elsewhere.
    // Use the platform-correct modifier so the hotkey actually fires.
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+K" : "Control+K");

    // The palette renders inside a Radix Dialog (role="dialog").
    const dialog = page.getByRole("dialog").first();
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The cmdk input lives inside the dialog. Type "media" and select.
    const input = dialog.getByPlaceholder(/search pages/i);
    await expect(input).toBeVisible();
    await input.fill("media");

    // Wait for at least one matching command item.
    const mediaItem = dialog.getByText(/media library/i).first();
    await expect(mediaItem).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/media/, { timeout: 10_000 });
  });
});
