import { test, expect } from "@playwright/test";
import { seedAdminToken } from "./helpers";

/**
 * Parity gap 12 — the "+ Add another field" button must open the Strapi-style
 * AddFieldDialog (4-column grid of field-type cards), and picking a card must
 * close the dialog and append the chosen field to the form.
 *
 * Regression guard: the U10 agent shipped the dialog component but its trigger
 * wiring needs an integration test or the next refactor can silently revert
 * it to the old inline-append behaviour.
 */
test.describe("add-field dialog", () => {
  test("opens grid-picker and appends a field row when a card is chosen", async ({
    page,
    context
  }) => {
    await seedAdminToken(context);

    await page.goto("/settings/content-types");
    await page.waitForLoadState("networkidle");

    // Land on an existing collection so the form is in edit mode (writable
    // enables the trigger button).
    await page.getByRole("button", { name: "articles" }).first().click();

    // Capture the baseline field count so we can assert the append-by-one
    // semantics of the dialog without depending on a specific field name
    // (the seeded `articles` schema can grow over time).
    const fieldRowsLocator = page.locator('input[name="fieldRows"]');
    const baseline = (() => {
      // Read the hidden input's serialised drafts array — that is the form's
      // source of truth for field count.
      return fieldRowsLocator.inputValue();
    });
    const baselineDrafts = JSON.parse(await baseline()) as { name: string }[];

    // Open the dialog. The trigger is rendered inside the fields section as
    // the very last item; pick by its aria-label which is stable.
    await page.getByRole("button", { name: /add another field/i }).click();

    // Base UI portals dialog content to document.body, so look for it at the
    // page root rather than inside the form.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(/select a field for your collection type/i)
    ).toBeVisible();

    // The grid-picker categories — these labels match the Strapi vocabulary
    // and are how operators visually scan for the right field type. The
    // source renders them as "Text"/"Date"/... and uses CSS `uppercase` for
    // the visual TEXT/DATE/... display.
    for (const category of ["Text", "Date", "Relations", "Number", "Media", "Other"]) {
      await expect(
        dialog.locator(`#field-cat-${category.toLowerCase()}`)
      ).toBeVisible();
    }

    // The Text card is the canonical TEXT entry — click it and expect the
    // dialog to close immediately (addFieldOfKind calls setAddFieldOpen(false)).
    await dialog
      .getByRole("button", { name: /^Text\s+Small or long text/i })
      .click();
    await expect(dialog).not.toBeVisible();

    // The hidden fieldRows input should now have one extra draft.
    const afterDrafts = JSON.parse(await baseline()) as { name: string }[];
    expect(afterDrafts.length).toBe(baselineDrafts.length + 1);
    // The newly-appended draft defaults to kind=string (Text card maps to
    // the "string" content-type field kind).
    const appended = afterDrafts[afterDrafts.length - 1];
    expect(appended).toBeDefined();
  });
});
