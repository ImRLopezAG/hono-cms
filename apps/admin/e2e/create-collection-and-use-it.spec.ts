import { test, expect } from "@playwright/test";
import { ADMIN_TOKEN, CMS_BASE_URL } from "./helpers";

/**
 * Gap-A runtime fix: creating a content-type via the admin REST endpoint
 * must immediately make `POST /api/<new-collection>` work without restarting
 * the CMS process. Before the fix, `createCMS()` baked its routes at boot
 * time and new collections only became reachable after a server restart.
 *
 * This spec hits the API surface directly (no UI). The UI flow is covered
 * separately by `create-collection.spec.ts`; here we isolate the runtime
 * route registration so a regression cannot be masked by UI changes.
 */
test.describe("create collection + immediately use it (Gap-A)", () => {
  test("POSTs a CT and POSTs a record into it without restart", async ({ request }) => {
    const ts = Date.now().toString(36);
    const collectionName = `hot-${ts}`;
    const authHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}` };

    // 1. Create the content type via the admin endpoint.
    const create = await request.post(`${CMS_BASE_URL}/cms/content-types`, {
      headers: { ...authHeaders, "content-type": "application/json" },
      data: {
        name: collectionName,
        fields: {
          title: { kind: "string", required: true }
        }
      }
    });
    expect(create.ok(), `create CT response was ${create.status()}`).toBe(true);
    expect(create.status()).toBe(201);

    // 2. IMMEDIATELY (no restart) POST a record into the new collection.
    const recordCreate = await request.post(
      `${CMS_BASE_URL}/api/${collectionName}`,
      {
        headers: { ...authHeaders, "content-type": "application/json" },
        data: { title: "Hot record" }
      }
    );
    expect(recordCreate.status(), "POST /api/<new> must work without restart").toBe(201);
    const recordBody = (await recordCreate.json()) as {
      id: string;
      title: string;
    };
    expect(recordBody.title).toBe("Hot record");

    // 3. GET /api/<new-collection> returns the record.
    const list = await request.get(`${CMS_BASE_URL}/api/${collectionName}`, {
      headers: authHeaders
    });
    expect(list.status()).toBe(200);
    const listBody = (await list.json()) as { items: Array<{ id: string }> };
    expect(listBody.items.length).toBeGreaterThanOrEqual(1);
    expect(listBody.items.find((item) => item.id === recordBody.id)).toBeTruthy();

    // 4. DELETE the CT removes it from the live REST surface.
    const remove = await request.delete(
      `${CMS_BASE_URL}/cms/content-types/${collectionName}`,
      { headers: authHeaders }
    );
    expect(remove.status()).toBe(200);

    // 5. After deletion the API returns 404 again.
    const after = await request.get(`${CMS_BASE_URL}/api/${collectionName}`);
    expect(after.status()).toBe(404);
  });
});
