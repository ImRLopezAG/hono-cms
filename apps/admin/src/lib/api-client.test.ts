import { afterEach, describe, expect, it, vi } from "vitest";

import { createAdminApiClient, resolveAdminApiBase } from "./api-client";

describe("admin API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves independently hosted admin API origins from Vite env by default", () => {
    expect(resolveAdminApiBase(undefined, { VITE_CMS_API_URL: "https://cms.example.com" })).toBe("https://cms.example.com");
    expect(resolveAdminApiBase(null, { VITE_CMS_API_URL: "https://cms.example.com" })).toBe("https://cms.example.com");
    expect(resolveAdminApiBase("", { VITE_CMS_API_URL: "https://cms.example.com" })).toBe("");
    expect(resolveAdminApiBase("https://preview.example.com", { VITE_CMS_API_URL: "https://cms.example.com" })).toBe("https://preview.example.com");
  });

  it("loads bounded content pages with cursor params", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const cursor = "eyJpZCI6ImFydGljbGVfMSIsImNyZWF0ZWRBdCI6IjIwMjYtMDUtMjJUMTA6MDA6MDAuMDAwWiJ9";
    const nextCursor = "eyJpZCI6ImFydGljbGVfMiIsImNyZWF0ZWRBdCI6IjIwMjYtMDUtMjJUMTA6MDE6MDAuMDAwWiJ9";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ items: [], nextCursor });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await expect(client.listContent("articles", {
      limit: 50,
      cursor,
      status: "published",
      sort: "-updatedAt",
      filters: {
        title: { $contains: "edge" },
        status: { $in: ["draft", "published"] },
        createdAt: { $between: ["2026-05-01", "2026-05-22"] },
        body: { $notNull: true }
      }
    })).resolves.toEqual({ items: [], nextCursor });

    expect(requests[0]?.url).toBe(`https://cms.test/api/articles?pagination[limit]=50&pagination[cursor]=${cursor}&status=published&sort=-updatedAt&filters[title][$contains]=edge&filters[status][$in][]=draft&filters[status][$in][]=published&filters[createdAt][$between][]=2026-05-01&filters[createdAt][$between][]=2026-05-22&filters[body][$notNull]=true`);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
  });

  it("keeps legacy contains filter input mapped to canonical filters syntax", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ items: [] });
    }));

    const client = createAdminApiClient("https://cms.test");
    await client.listContent("articles", {
      filters: { title: { contains: "edge" }, featured: true }
    });

    expect(requests[0]?.url).toBe("https://cms.test/api/articles?filters[title][$contains]=edge&filters[featured]=true");
  });

  it("calls draft workflow endpoints with bearer auth", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ id: "article_1", title: "Hello", createdAt: "now", updatedAt: "now" });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await client.publishContent("articles", "article_1");
    await client.unpublishContent("articles", "article_1");
    await client.scheduleContent("articles", "article_1", "2026-05-23T12:00");
    await client.unscheduleContent("articles", "article_1");
    await client.deleteContent("articles", "article_1");

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ["POST", "https://cms.test/api/articles/article_1/publish"],
      ["POST", "https://cms.test/api/articles/article_1/unpublish"],
      ["POST", "https://cms.test/api/articles/article_1/schedule"],
      ["POST", "https://cms.test/api/articles/article_1/unschedule"],
      ["DELETE", "https://cms.test/api/articles/article_1"]
    ]);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ publishAt: "2026-05-23T12:00" }));
  });

  it("creates preview tokens for exact records", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ token: "preview-token", url: "/preview" });
    }));

    const client = createAdminApiClient();
    await expect(client.createPreviewToken("articles", "article_1")).resolves.toEqual({ token: "preview-token", url: "/preview" });
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ collection: "articles", documentId: "article_1" }));
  });

  it("loads schema metadata with bearer auth", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({
        collections: {
          articles: {
            name: "articles",
            options: { draftAndPublish: true },
            fields: {
              title: { kind: "string", required: true, unique: false, localized: false, private: false }
            }
          }
        }
      });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await expect(client.schema()).resolves.toMatchObject({
      collections: {
        articles: {
          fields: {
            title: { kind: "string", required: true }
          }
        }
      }
    });
    expect(requests[0]?.url).toBe("https://cms.test/cms/schema");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
  });

  it("manages content type builder endpoints with bearer auth", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (String(url).endsWith("/capabilities")) return Response.json({ writable: true, mode: "development" });
      if (init?.method === "POST" || init?.method === "PUT") {
        return Response.json({ collection: { name: "sections", fields: { title: { kind: "string", required: true, unique: false, localized: false, private: false } }, options: { draftAndPublish: true } }, path: "cms/collections/sections.ts" });
      }
      return Response.json({ collections: { sections: { name: "sections", fields: {}, options: {} } }, capabilities: { writable: true, mode: "development" } });
    }));

    const input = {
      name: "sections",
      fields: { title: { kind: "string" as const, required: true } },
      options: { draftAndPublish: true }
    };
    const client = createAdminApiClient("https://cms.test", "admin-token");
    await client.contentTypeCapabilities();
    await client.contentTypes();
    await client.createContentType(input);
    await client.updateContentType("sections", input);

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      [undefined, "https://cms.test/cms/content-types/capabilities"],
      [undefined, "https://cms.test/cms/content-types"],
      ["POST", "https://cms.test/cms/content-types"],
      ["PUT", "https://cms.test/cms/content-types/sections"]
    ]);
    expect(requests[2]?.init?.body).toBe(JSON.stringify(input));
    expect(requests[3]?.init?.body).toBe(JSON.stringify(input));
    expect(new Headers(requests[2]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(new Headers(requests[2]?.init?.headers).get("content-type")).toBe("application/json");
  });

  it("handles media upload, presigned browser upload, and delete endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (String(url).endsWith("/presign")) return Response.json({ uploadId: "up_1", uploadUrl: "https://upload.test", method: "PUT", key: "media/file.txt", headers: { "x-upload-token": "signed" }, expiresAt: "2026-05-23T00:00:00.000Z" });
      if (String(url) === "https://upload.test") return new Response(null, { status: 200 });
      if (String(url).endsWith("/confirm")) return Response.json({ id: "media_1", key: "media/file.txt", url: "/media/file.txt", filename: "file.txt", size: 4, createdAt: "now", updatedAt: "now" }, { status: 201 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: "media_1", key: "media/file.txt", url: "/media/file.txt", filename: "file.txt", size: 4, createdAt: "now", updatedAt: "now" }, { status: 201 });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await client.uploadMedia(new File(["file"], "file.txt", { type: "text/plain" }));
    await client.uploadMediaWithPresign(new File(["file"], "file.txt", { type: "text/plain" }));
    await client.deleteMedia("media_1");

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ["POST", "https://cms.test/api/media"],
      ["POST", "https://cms.test/api/media/presign"],
      ["PUT", "https://upload.test"],
      ["POST", "https://cms.test/api/media/confirm"],
      ["DELETE", "https://cms.test/api/media/media_1"]
    ]);
    expect(requests[0]?.init?.body).toBeInstanceOf(FormData);
    expect(new Headers(requests[0]?.init?.headers).has("content-type")).toBe(false);
    expect(new Headers(requests[1]?.init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(requests[2]?.init?.headers).get("authorization")).toBeNull();
    expect(new Headers(requests[2]?.init?.headers).get("x-upload-token")).toBe("signed");
    expect(new Headers(requests[2]?.init?.headers).get("content-type")).toBe("text/plain");
  });

  it("loads filtered audit log pages with canonical query params", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ items: [{ id: "audit_1", operation: "publish", actorRoles: ["admin"], requestId: "req_1", diff: { before: null, after: {} }, createdAt: "now" }], nextCursor: "audit_2" });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await expect(client.auditLog({
      collection: "articles",
      documentId: "article_1",
      operation: "publish",
      actorId: "user_1",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-05-22T23:59:59.000Z",
      cursor: "audit_1",
      limit: 10
    })).resolves.toMatchObject({ nextCursor: "audit_2" });

    expect(requests[0]?.url).toBe("https://cms.test/cms/audit-log?limit=10&collection=articles&documentId=article_1&operation=publish&actorId=user_1&from=2026-05-01T00%3A00%3A00.000Z&to=2026-05-22T23%3A59%3A59.000Z&cursor=audit_1");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
  });

  it("exports filtered audit logs as CSV with bearer auth", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response("id,operation\naudit_1,publish", { headers: { "content-type": "text/csv" } });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await expect(client.auditCsv({ collection: "articles", operation: "publish", limit: 50 })).resolves.toContain("audit_1");

    expect(requests[0]?.url).toBe("https://cms.test/cms/audit-log?limit=50&collection=articles&operation=publish&format=csv");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer admin-token");
    expect(headers.get("accept")).toBe("text/csv");
  });

  it("manages webhooks and delivery operations with bearer auth", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (String(url).includes("/deliveries/delivery_1/retry")) return Response.json({ id: "delivery_1", webhookId: "webhook_1", eventType: "content.published", url: "https://hooks.test/cms", attempt: 2, status: "success", requestBody: "{}", createdAt: "now" });
      if (String(url).endsWith("/test")) return Response.json({ id: "delivery_test", webhookId: "webhook_1", eventType: "webhook.test", url: "https://hooks.test/cms", attempt: 1, status: "success", requestBody: "{}", createdAt: "now" });
      if (String(url).includes("/deliveries")) return Response.json({ items: [{ id: "delivery_1", webhookId: "webhook_1", eventType: "content.published", url: "https://hooks.test/cms", attempt: 1, status: "failed", requestBody: "{}", createdAt: "now" }], nextCursor: "delivery_2" });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(url).endsWith("/cms/settings/webhooks")) {
        return Response.json({ items: [{ id: "webhook_1", name: "Deploy", url: "https://hooks.test/cms", events: ["*"], enabled: true, hasSecret: true, lastDeliveryAt: null, lastDeliveryStatus: null }], meta: { total: 1 } });
      }
      return Response.json({ id: "webhook_1", name: "Deploy", url: "https://hooks.test/cms", events: ["*"], enabled: true, createdAt: "now", updatedAt: "now" });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await client.webhooks();
    await client.createWebhook({ name: "Deploy", url: "https://hooks.test/cms", events: ["content.published"], enabled: true });
    await client.updateWebhook("webhook_1", { enabled: false, secret: null });
    await client.replaceWebhook("webhook_1", { name: "Deploy", url: "https://hooks.test/cms", events: ["*"] });
    await client.webhookDeliveries("webhook_1", { limit: 5, cursor: "delivery_1" });
    await client.retryWebhookDelivery("webhook_1", "delivery_1");
    await client.testWebhook("webhook_1");
    await client.deleteWebhook("webhook_1");

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      [undefined, "https://cms.test/cms/settings/webhooks"],
      ["POST", "https://cms.test/cms/settings/webhooks"],
      ["PATCH", "https://cms.test/cms/settings/webhooks/webhook_1"],
      ["PUT", "https://cms.test/cms/settings/webhooks/webhook_1"],
      [undefined, "https://cms.test/cms/settings/webhooks/webhook_1/deliveries?limit=5&cursor=delivery_1"],
      ["POST", "https://cms.test/cms/settings/webhooks/webhook_1/deliveries/delivery_1/retry"],
      ["POST", "https://cms.test/cms/settings/webhooks/webhook_1/test"],
      ["DELETE", "https://cms.test/cms/settings/webhooks/webhook_1"]
    ]);
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ name: "Deploy", url: "https://hooks.test/cms", events: ["content.published"], enabled: true }));
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ enabled: false, secret: null }));
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(new Headers(requests[1]?.init?.headers).get("content-type")).toBe("application/json");
  });

  it("manages API keys with bearer auth", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(url).endsWith("/cms/settings/api-keys")) {
        return Response.json({ items: [{ id: "api_key_1", userId: "bot", roles: ["editor"], enabled: true, prefix: "cms_live_abc..." }], meta: { total: 1 } });
      }
      if (init?.method === "POST") return Response.json({ id: "api_key_1", userId: "bot", roles: ["editor"], enabled: true, secret: "cms_live_secret" });
      return Response.json({ id: "api_key_1", userId: "bot", roles: ["admin"], enabled: false });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await client.apiKeys();
    await client.createApiKey({ userId: "bot", roles: ["editor"], enabled: true });
    await client.updateApiKey("api_key_1", { roles: ["admin"], enabled: false });
    await client.deleteApiKey("api_key_1");

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      [undefined, "https://cms.test/cms/settings/api-keys"],
      ["POST", "https://cms.test/cms/settings/api-keys"],
      ["PATCH", "https://cms.test/cms/settings/api-keys/api_key_1"],
      ["DELETE", "https://cms.test/cms/settings/api-keys/api_key_1"]
    ]);
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ userId: "bot", roles: ["editor"], enabled: true }));
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(new Headers(requests[1]?.init?.headers).get("content-type")).toBe("application/json");
  });

  it("posts auth actions and manages organization endpoints with bearer auth", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (String(url).endsWith("/auth/list-sessions")) return Response.json({ sessions: [{ id: "session_1", token: "token_1", userAgent: "Safari", current: true }] });
      if (String(url).endsWith("/auth/revoke-session") || String(url).endsWith("/auth/revoke-other-sessions")) return Response.json({ ok: true });
      if (String(url).includes("/auth/")) return Response.json({ ok: true, token: "session-token" });
      if (String(url).endsWith("/members")) return Response.json({ items: [] });
      if (String(url).endsWith("/invitations")) return Response.json({ items: [] });
      if (String(url).endsWith("/revoke")) return Response.json({ id: "invite_1", email: "editor@example.com", role: "editor", status: "revoked" });
      if (String(url).includes("/members/") && init?.method === "PATCH") return Response.json({ id: "member_1", email: "admin@example.com", role: "admin", status: "active" });
      if (String(url).includes("/members/") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(url).includes("/invitations") && init?.method === "POST") return Response.json({ id: "invite_1", email: "editor@example.com", role: "editor", status: "pending" });
      return Response.json({ id: "org_1", name: "Team", slug: "team", plan: "team" });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await client.authAction("login", { email: "admin@example.com", password: "secret" });
    await expect(client.authSessions()).resolves.toEqual({ items: [{ id: "session_1", token: "token_1", userAgent: "Safari", current: true }] });
    await client.revokeAuthSession("token_1");
    await client.revokeOtherAuthSessions();
    await client.organization();
    await client.updateOrganization({ name: "Team", slug: "team", plan: "team" });
    await client.organizationMembers();
    await client.updateOrganizationMember("member_1", { role: "admin", status: "active" });
    await client.removeOrganizationMember("member_1");
    await client.organizationInvitations();
    await client.createOrganizationInvitation({ email: "editor@example.com", role: "editor" });
    await client.revokeOrganizationInvitation("invite_1");

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ["POST", "https://cms.test/api/auth/login"],
      [undefined, "https://cms.test/api/auth/list-sessions"],
      ["POST", "https://cms.test/api/auth/revoke-session"],
      ["POST", "https://cms.test/api/auth/revoke-other-sessions"],
      [undefined, "https://cms.test/cms/settings/organization"],
      ["PUT", "https://cms.test/cms/settings/organization"],
      [undefined, "https://cms.test/cms/settings/organization/members"],
      ["PATCH", "https://cms.test/cms/settings/organization/members/member_1"],
      ["DELETE", "https://cms.test/cms/settings/organization/members/member_1"],
      [undefined, "https://cms.test/cms/settings/organization/invitations"],
      ["POST", "https://cms.test/cms/settings/organization/invitations"],
      ["POST", "https://cms.test/cms/settings/organization/invitations/invite_1/revoke"]
    ]);
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ email: "admin@example.com", password: "secret" }));
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ token: "token_1" }));
    expect(requests[5]?.init?.body).toBe(JSON.stringify({ name: "Team", slug: "team", plan: "team" }));
    expect(new Headers(requests[7]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
  });

  it("loads and enqueues i18n backfills with bearer auth", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (init?.method === "POST") {
        return Response.json({ status: "enqueued", locale: "es", collection: "pages", jobCount: 2, collections: { pages: 2 } });
      }
      return Response.json({
        locale: "es",
        collection: "pages",
        totals: { total: 2, missing: 0, pending: 1, inProgress: 0, complete: 1, error: 0 },
        collections: [{ collection: "pages", total: 2, missing: 0, pending: 1, inProgress: 0, complete: 1, error: 0 }]
      });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await client.i18nBackfillStatus({ locale: "es", collection: "pages" });
    await client.enqueueI18nBackfill({ locale: "es", collection: "pages" });

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      [undefined, "https://cms.test/cms/admin/i18n/backfill/status?locale=es&collection=pages"],
      ["POST", "https://cms.test/cms/admin/i18n/backfill"]
    ]);
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ locale: "es", collection: "pages" }));
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(new Headers(requests[1]?.init?.headers).get("content-type")).toBe("application/json");
  });

  it("serializes media search and type filters for the media library", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ items: [], nextCursor: "media_2" });
    }));

    const client = createAdminApiClient("https://cms.test", "admin-token");
    await expect(client.listMedia({
      q: "launch kit",
      type: "image",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-05-22T00:00:00.000Z",
      cursor: "media_1",
      limit: 25
    })).resolves.toEqual({ items: [], nextCursor: "media_2" });

    expect(requests[0]?.url).toBe("https://cms.test/api/media?q=launch%20kit&type=image&from=2026-05-01T00%3A00%3A00.000Z&to=2026-05-22T00%3A00%3A00.000Z&cursor=media_1&limit=25");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer admin-token");
  });
});
