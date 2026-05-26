import { describe, expect, it, vi } from "vitest";

import type { InfiniteData } from "@tanstack/react-query";
import { AdminApiError } from "../lib/api-client";
import type { AdminContentListResult } from "../lib/api-client";
import { EDITOR_HOTKEYS, SHELL_HOTKEYS, apiKeyInputFromForm, apiKeysFromQuery, auditEntriesFromQuery, auditLogOptionsFromForm, authActionInputFromForm, authRedirectForPath, authRedirectForStoredToken, authSessionsFromQuery, contentRecordsFromQuery, contentRouteStateFromParams, contentSelectionKey, contentTypeChangePreview, contentTypeFieldDraftsFromFields, contentTypeFieldsFromDrafts, contentTypeGenerationPreview, contentTypeInputFromForm, contentTypeWriteSummary, copyGeneratedSnippet, editorMutationErrorMessage, emptySchemaMetadata, healthReportFromQuery, i18nBackfillInputFromForm, i18nStatusFromQuery, invitationInputFromForm, isAdminAuthRoute, isRetryableWebhookDelivery, localizedCollectionOptions, mediaFromQuery, mediaRouteStateFromParams, memberInputFromForm, organizationFromQuery, organizationInputFromForm, organizationInvitationsFromQuery, organizationMembersFromQuery, parseContentTypeOptions, readStoredAdminAuthToken, relationRecordsFromQuery, removeAuthSession, removeCollectionSelection, schemaMetadataFromQuery, selectedApiKey, selectedItemsByCollection, selectedWebhook, sessionRevokeToken, shouldBlockAdminNavigation, toggleContentSelection, toggleVisibleContentSelection, updateContentListRecords, validateContentTypeFieldDrafts, webhookInputFromForm, webhooksFromQuery } from "./AdminApp";

describe("admin route state", () => {
  it("derives content workspace state from typed router params", () => {
    expect(contentRouteStateFromParams({ collectionName: "articles" })).toEqual({
      collectionName: "articles",
      recordId: null,
      createNew: false,
      routeSearch: { q: "", status: "all", sort: "-updatedAt" }
    });
    expect(contentRouteStateFromParams({ collectionName: "articles", recordId: "article_1" })).toEqual({
      collectionName: "articles",
      recordId: "article_1",
      createNew: false,
      routeSearch: { q: "", status: "all", sort: "-updatedAt" }
    });
    expect(contentRouteStateFromParams({ collectionName: "articles", createNew: true })).toEqual({
      collectionName: "articles",
      recordId: null,
      createNew: true,
      routeSearch: { q: "", status: "all", sort: "-updatedAt" }
    });
  });

  it("falls back to the default content workspace when params are absent", () => {
    expect(contentRouteStateFromParams({})).toEqual({
      collectionName: "",
      recordId: null,
      createNew: false,
      routeSearch: { q: "", status: "all", sort: "-updatedAt" }
    });
  });

  it("derives media detail state from typed router params", () => {
    expect(mediaRouteStateFromParams({ mediaId: "media_1" })).toEqual({ mediaId: "media_1" });
    expect(mediaRouteStateFromParams({})).toEqual({ mediaId: null });
  });
});

describe("editor keyboard shortcuts", () => {
  it("declares cross-platform save and publish shortcuts for TanStack Hotkeys", () => {
    expect(EDITOR_HOTKEYS).toEqual({
      save: "Mod+S",
      publish: "Mod+Shift+P"
    });
    expect(SHELL_HOTKEYS).toEqual({ commandPalette: "Mod+K" });
  });
});

describe("unsaved-change navigation policy", () => {
  it("blocks path changes only while the editor has unsaved changes", () => {
    expect(shouldBlockAdminNavigation(false, "/content/articles", "/media")).toBe(false);
    expect(shouldBlockAdminNavigation(true, "/content/articles", "/content/articles")).toBe(false);
    expect(shouldBlockAdminNavigation(true, "/content/articles", "/media")).toBe(true);
  });
});

describe("editor mutation errors", () => {
  it("turns auth and validation failures into editor-facing messages", () => {
    expect(editorMutationErrorMessage(new AdminApiError(401))).toContain("session expired");
    expect(editorMutationErrorMessage(new AdminApiError(403))).toContain("permission");
    expect(editorMutationErrorMessage(new AdminApiError(422, { issues: [{ message: "Title is required" }] }))).toBe("Title is required");
    expect(editorMutationErrorMessage(new Error("Network down"))).toBe("Network down");
    expect(editorMutationErrorMessage(null)).toBeNull();
  });
});

describe("admin auth route policy", () => {
  it("identifies unauthenticated auth routes", () => {
    expect(isAdminAuthRoute("/login")).toBe(true);
    expect(isAdminAuthRoute("/2fa/verify")).toBe(true);
    expect(isAdminAuthRoute("/content")).toBe(false);
  });

  it("redirects users based on authentication state", () => {
    expect(authRedirectForPath(false, "/content")).toBe("/login");
    expect(authRedirectForPath(false, "/login")).toBeNull();
    expect(authRedirectForPath(true, "/login")).toBe("/content");
    expect(authRedirectForPath(true, "/content")).toBeNull();
  });

  it("reads the same persisted auth token used by the router beforeLoad guard", () => {
    const storage = { getItem: (key: string) => key === "hono-cms:auth-token" ? JSON.stringify("admin-token") : null };
    expect(readStoredAdminAuthToken(storage)).toBe("admin-token");
    expect(authRedirectForStoredToken("/login", storage)).toBe("/content");
    expect(authRedirectForStoredToken("/content", storage)).toBeNull();
  });

  it("treats blank, missing, and JSON null persisted tokens as signed out", () => {
    expect(readStoredAdminAuthToken({ getItem: () => null })).toBeNull();
    expect(readStoredAdminAuthToken({ getItem: () => "null" })).toBeNull();
    expect(readStoredAdminAuthToken({ getItem: () => JSON.stringify("") })).toBeNull();
    expect(authRedirectForStoredToken("/content", { getItem: () => null })).toBe("/login");
  });
});

describe("content list selection", () => {
  it("uses only real query data for content and relation records", () => {
    expect(contentRecordsFromQuery(undefined)).toEqual([]);
    expect(relationRecordsFromQuery(undefined)).toEqual([]);

    const data: InfiniteData<AdminContentListResult> = {
      pageParams: [undefined],
      pages: [{
        items: [{ id: "article_1", title: "Real", createdAt: "", updatedAt: "" }]
      }]
    };

    expect(contentRecordsFromQuery(data)).toEqual([{ id: "article_1", title: "Real", createdAt: "", updatedAt: "" }]);
    expect(relationRecordsFromQuery(data.pages[0])).toEqual([{ id: "article_1", title: "Real", createdAt: "", updatedAt: "" }]);
  });

  it("scopes selected rows by collection", () => {
    let selected = new Set<string>();

    selected = toggleContentSelection(selected, "articles", "article_1", true);
    selected = toggleContentSelection(selected, "pages", "page_1", true);
    selected = toggleVisibleContentSelection(selected, "articles", ["article_2", "article_3"], true);
    selected = toggleContentSelection(selected, "articles", "article_2", false);

    expect(contentSelectionKey("articles", "article_1")).toBe("articles:article_1");
    expect(selectedItemsByCollection(selected, "articles")).toEqual(["article_1", "article_3"]);
    expect(selectedItemsByCollection(selected, "pages")).toEqual(["page_1"]);
    expect([...removeCollectionSelection(selected, "articles")]).toEqual(["pages:page_1"]);
  });

  it("optimistically updates cached content pages for bulk actions", () => {
    const data: InfiniteData<AdminContentListResult> = {
      pageParams: [undefined],
      pages: [{
        items: [
          { id: "article_1", title: "Draft", status: "draft", createdAt: "", updatedAt: "" },
          { id: "article_2", title: "Published", status: "published", createdAt: "", updatedAt: "" }
        ],
        nextCursor: "article_2"
      }]
    };

    expect(updateContentListRecords(data, ["article_1"], "publish")?.pages[0]?.items[0]).toMatchObject({ id: "article_1", status: "published" });
    expect(updateContentListRecords(data, ["article_2"], "unpublish")?.pages[0]?.items[1]).toMatchObject({ id: "article_2", status: "draft" });
    expect(updateContentListRecords(data, ["article_1"], "delete")?.pages[0]?.items).toEqual([
      { id: "article_2", title: "Published", status: "published", createdAt: "", updatedAt: "" }
    ]);
  });
});

describe("admin API list data", () => {
  it("uses only real query data for operational resources", () => {
    expect(auditEntriesFromQuery(undefined)).toEqual([]);
    expect(webhooksFromQuery(undefined)).toEqual([]);
    expect(apiKeysFromQuery(undefined)).toEqual([]);
    expect(authSessionsFromQuery(undefined)).toEqual([]);
    expect(mediaFromQuery(undefined)).toEqual([]);

    const auditData: InfiniteData<{ items: Array<{ id: string; operation: string; requestId: string; createdAt: string }>; nextCursor?: string }> = {
      pageParams: [undefined],
      pages: [{ items: [{ id: "audit_1", operation: "publish", requestId: "req_1", createdAt: "2026-05-22" }] }]
    };

    expect(auditEntriesFromQuery(auditData)).toEqual([{ id: "audit_1", operation: "publish", requestId: "req_1", createdAt: "2026-05-22" }]);
    expect(webhooksFromQuery({ items: [{ id: "hook_1", name: "Deploy", url: "https://hooks.test", events: ["content.published"], enabled: true }] })).toHaveLength(1);
    expect(apiKeysFromQuery({ items: [{ id: "key_1", userId: "bot", roles: ["editor"], enabled: true }] })).toHaveLength(1);
    expect(authSessionsFromQuery({ items: [{ id: "session_1", current: true }] })).toHaveLength(1);
    expect(mediaFromQuery({ items: [{ id: "media_1", key: "uploads/hero.jpg", url: "/hero.jpg", filename: "hero.jpg", size: 1, createdAt: "", updatedAt: "" }] })).toHaveLength(1);
  });

  it("uses only real query data for organization resources", () => {
    expect(organizationFromQuery(undefined)).toBeNull();
    expect(organizationMembersFromQuery(undefined)).toEqual([]);
    expect(organizationInvitationsFromQuery(undefined)).toEqual([]);

    expect(organizationFromQuery({ id: "org_1", name: "Studio", slug: "studio" })).toEqual({ id: "org_1", name: "Studio", slug: "studio" });
    expect(organizationMembersFromQuery({ items: [{ id: "member_1", email: "editor@example.com", role: "editor", status: "active" }] })).toHaveLength(1);
    expect(organizationInvitationsFromQuery({ items: [{ id: "invite_1", email: "writer@example.com", role: "writer", status: "pending" }] })).toHaveLength(1);
  });

  it("uses only real query data for health and i18n status", () => {
    expect(healthReportFromQuery(undefined)).toBeNull();
    expect(i18nStatusFromQuery(undefined)).toBeNull();

    const health = { status: "ok" as const, version: "1.0.0", uptime_seconds: 10, checks: { db: { status: "ok" as const } } };
    const i18nStatus = {
      locale: "es",
      collection: "pages",
      totals: { total: 1, missing: 0, pending: 0, inProgress: 0, complete: 1, error: 0 },
      collections: [{ collection: "pages", total: 1, missing: 0, pending: 0, inProgress: 0, complete: 1, error: 0 }]
    };

    expect(healthReportFromQuery(health)).toBe(health);
    expect(i18nStatusFromQuery(i18nStatus)).toBe(i18nStatus);
  });

  it("does not invent sample collections when schema metadata is unavailable", () => {
    const schema = {
      collections: {
        pages: {
          name: "pages",
          fields: {},
          options: {}
        }
      }
    };

    expect(emptySchemaMetadata()).toEqual({ collections: {} });
    expect(schemaMetadataFromQuery(undefined)).toEqual({ collections: {} });
    expect(schemaMetadataFromQuery(schema)).toBe(schema);
  });
});

describe("webhook form mapping", () => {
  it("normalizes webhook settings into the typed API input", () => {
    const form = new FormData();
    form.set("name", " Deploy ");
    form.set("url", " https://hooks.test/cms ");
    form.set("events", "content.created, content.published, , media.uploaded");
    form.set("secret", "  signer ");
    form.set("enabled", "on");

    expect(webhookInputFromForm(form)).toEqual({
      name: "Deploy",
      url: "https://hooks.test/cms",
      events: ["content.created", "content.published", "media.uploaded"],
      enabled: true,
      secret: "signer"
    });
  });

  it("omits blank webhook secrets so existing secrets are preserved", () => {
    const form = new FormData();
    form.set("name", "Deploy");
    form.set("url", "https://hooks.test/cms");
    form.set("events", "content.published");

    expect(webhookInputFromForm(form)).toEqual({
      name: "Deploy",
      url: "https://hooks.test/cms",
      events: ["content.published"],
      enabled: false
    });
  });
});

describe("api key form mapping", () => {
  it("normalizes API key settings into typed input", () => {
    const form = new FormData();
    form.set("name", " Automation ");
    form.set("userId", " bot ");
    form.set("roles", "editor, admin, , publisher");
    form.set("enabled", "on");

    expect(apiKeyInputFromForm(form)).toEqual({
      name: "Automation",
      userId: "bot",
      roles: ["editor", "admin", "publisher"],
      enabled: true
    });
  });

  it("omits blank API key names", () => {
    const form = new FormData();
    form.set("userId", "bot");
    form.set("roles", "editor");

    expect(apiKeyInputFromForm(form)).toEqual({
      userId: "bot",
      roles: ["editor"],
      enabled: false
    });
  });
});

describe("auth form mapping", () => {
  it("normalizes login credentials", () => {
    const form = new FormData();
    form.set("email", " admin@example.com ");
    form.set("password", " secret ");

    expect(authActionInputFromForm("login", form)).toEqual({
      email: "admin@example.com",
      password: "secret"
    });
  });

  it("prefers explicit API tokens for built-in login sessions", () => {
    const form = new FormData();
    form.set("email", " admin@example.com ");
    form.set("password", " secret ");
    form.set("token", " cms_live_secret ");

    expect(authActionInputFromForm("login", form)).toEqual({
      token: "cms_live_secret"
    });
  });

  it("only sends the challenge code for 2FA verification", () => {
    const form = new FormData();
    form.set("email", "ignored@example.com");
    form.set("code", " 123456 ");

    expect(authActionInputFromForm("2fa-verify", form)).toEqual({ code: "123456" });
  });
});

describe("auth session helpers", () => {
  it("uses provider tokens for revocation and falls back to ids", () => {
    expect(sessionRevokeToken({ id: "session_1", token: "token_1" })).toBe("token_1");
    expect(sessionRevokeToken({ id: "session_1" })).toBe("session_1");
  });

  it("removes revoked sessions optimistically", () => {
    expect(removeAuthSession([
      { id: "current", current: true },
      { id: "old", token: "old_token" }
    ], "old")).toEqual([{ id: "current", current: true }]);
  });
});

describe("organization form mapping", () => {
  it("normalizes organization settings", () => {
    const form = new FormData();
    form.set("name", " Editorial Studio ");
    form.set("slug", " editorial ");
    form.set("plan", " team ");

    expect(organizationInputFromForm(form)).toEqual({
      name: "Editorial Studio",
      slug: "editorial",
      plan: "team"
    });
  });

  it("normalizes member and invitation inputs", () => {
    const memberForm = new FormData();
    memberForm.set("role", " admin ");
    memberForm.set("status", "disabled");
    const invitationForm = new FormData();
    invitationForm.set("email", " editor@example.com ");
    invitationForm.set("role", " editor ");

    expect(memberInputFromForm("member_1", memberForm)).toEqual({ id: "member_1", role: "admin", status: "disabled" });
    expect(invitationInputFromForm(invitationForm)).toEqual({ email: "editor@example.com", role: "editor" });
  });
});

describe("content type form mapping", () => {
  it("serializes visual field builder rows into typed API input", () => {
    const form = new FormData();
    form.set("name", " sections ");
    form.set("draftAndPublish", "on");
    form.set("fieldRows", JSON.stringify([
      { name: "title", kind: "string", required: true, unique: true, localized: true, min: "3", max: "120" },
      { name: "layout", kind: "enum", values: "hero, grid, feature" },
      { name: "heroImage", kind: "media", multiple: true },
      { name: "author", kind: "relation", target: "authors", cardinality: "many-to-one", inverse: "articles", onDelete: "restrict" },
      { name: "slug", kind: "uid", targetField: "title" },
      { name: "sortOrder", kind: "number", int: true, min: "0" }
    ]));
    form.set("options", JSON.stringify({ timestamps: true }));

    expect(contentTypeInputFromForm(form)).toEqual({
      name: "sections",
      fields: {
        title: { kind: "string", required: true, unique: true, localized: true, min: 3, max: 120 },
        layout: { kind: "enum", values: ["hero", "grid", "feature"] },
        heroImage: { kind: "media", multiple: true },
        author: { kind: "relation", target: "authors", cardinality: "many-to-one", inverse: "articles", onDelete: "restrict" },
        slug: { kind: "uid", targetField: "title" },
        sortOrder: { kind: "number", int: true, min: 0 }
      },
      options: { timestamps: true, draftAndPublish: true }
    });
  });

  it("round-trips existing collection fields into visual builder rows", () => {
    const fields = {
      title: { kind: "string" as const, required: true, max: 120 },
      related: { kind: "relation" as const, target: "sections", cardinality: "many-to-many", inverse: "related" },
      thumbnail: { kind: "media" as const, multiple: true }
    };

    expect(contentTypeFieldsFromDrafts(contentTypeFieldDraftsFromFields(fields))).toEqual(fields);
  });

  it("rejects blank and duplicate visual builder field names", () => {
    expect(validateContentTypeFieldDrafts([{ name: "title" }, { name: " title " }])).toEqual({ valid: false, error: "Duplicate field name: title." });
    expect(validateContentTypeFieldDrafts([{ name: "" }])).toEqual({ valid: false, error: "Every content type field needs a name." });
    expect(validateContentTypeFieldDrafts([{ name: "bad-slug" }])).toEqual({ valid: false, error: "Field name must be a valid TypeScript identifier: bad-slug." });
    expect(() => contentTypeFieldsFromDrafts([
      { ...contentTypeFieldDraftsFromFields({ title: { kind: "string" } })[0]!, id: "one", name: "title" },
      { ...contentTypeFieldDraftsFromFields({ body: { kind: "text" } })[0]!, id: "two", name: "title" }
    ])).toThrow("Duplicate field name: title.");
  });

  it("rejects invalid visual builder field settings before generation", () => {
    const base = contentTypeFieldDraftsFromFields({
      title: { kind: "string" },
      slug: { kind: "uid", targetField: "title" },
      layout: { kind: "enum", values: ["hero"] },
      author: { kind: "relation", target: "authors", cardinality: "many-to-one" }
    });
    const field = (name: string) => base.find((draft) => draft.name === name)!;

    expect(validateContentTypeFieldDrafts([{ ...field("title"), min: "10", max: "2" }])).toEqual({ valid: false, error: "title min cannot be greater than max." });
    expect(validateContentTypeFieldDrafts([{ ...field("title"), min: "wide" }])).toEqual({ valid: false, error: "title min must be a number." });
    expect(validateContentTypeFieldDrafts([{ ...field("layout"), values: "" }])).toEqual({ valid: false, error: "layout enum needs at least one value." });
    expect(validateContentTypeFieldDrafts([{ ...field("layout"), values: "hero, hero" }])).toEqual({ valid: false, error: "layout enum values must be unique." });
    expect(validateContentTypeFieldDrafts([{ ...field("title") }, { ...field("slug"), targetField: "missing" }])).toEqual({ valid: false, error: "slug UID target field must reference another field in this content type." });
    expect(validateContentTypeFieldDrafts([{ ...field("author"), target: "" }])).toEqual({ valid: false, error: "author relation needs a target collection." });
    expect(validateContentTypeFieldDrafts([{ ...field("author"), inverse: "bad-slug" }])).toEqual({ valid: false, error: "author relation inverse must be a valid TypeScript identifier." });
  });

  it("normalizes content type JSON into typed API input", () => {
    const form = new FormData();
    form.set("name", " sections ");
    form.set("draftAndPublish", "on");
    form.set("fields", JSON.stringify({
      title: { kind: "string", required: true, max: 120 },
      layout: { kind: "enum", values: ["hero", "grid"] }
    }));
    form.set("options", JSON.stringify({
      i18n: { locales: ["en", "es"], defaultLocale: "en" }
    }));

    expect(contentTypeInputFromForm(form)).toEqual({
      name: "sections",
      fields: {
        title: { kind: "string", required: true, max: 120 },
        layout: { kind: "enum", values: ["hero", "grid"] }
      },
      options: {
        draftAndPublish: true,
        i18n: { locales: ["en", "es"], defaultLocale: "en" }
      }
    });
  });

  it("removes draft workflow when the checkbox is off", () => {
    const form = new FormData();
    form.set("name", "sections");
    form.set("fields", JSON.stringify({ title: { kind: "string" } }));
    form.set("options", JSON.stringify({ draftAndPublish: true }));

    expect(contentTypeInputFromForm(form)).toEqual({
      name: "sections",
      fields: { title: { kind: "string" } },
      options: {}
    });
  });

  it("validates advanced content type options as a JSON object", () => {
    expect(parseContentTypeOptions("{\"timestamps\":true}")).toEqual({ options: { timestamps: true }, error: null });
    expect(parseContentTypeOptions("[\"bad\"]")).toEqual({ options: {}, error: "Expected a JSON object." });
    expect(parseContentTypeOptions("{")).toMatchObject({ options: {}, error: expect.any(String) });
  });

  it("keeps generated source and artifacts visible after content type writes", () => {
    expect(contentTypeWriteSummary({
      collection: { name: "products" },
      source: `export const products = defineCollection("products", {});`,
      path: "cms/collections/products.ts",
      artifacts: ["node_modules/.cms/sdk/index.ts"],
      migrations: [".hono-cms/migrations/202605230001_create_products.sql"],
      message: "Generated typed SDK and database schema"
    })).toEqual({
      title: "Generated typed SDK and database schema",
      details: [
        "cms/collections/products.ts",
        "node_modules/.cms/sdk/index.ts",
        ".hono-cms/migrations/202605230001_create_products.sql"
      ],
      source: `export const products = defineCollection("products", {});`
    });
  });

  it("previews generated SDK and REST API before content type writes", () => {
    const preview = contentTypeGenerationPreview({
      name: "product-reviews",
      fields: {
        title: { kind: "string", required: true },
        rating: { kind: "number", required: true },
        state: { kind: "enum", values: ["draft", "approved"] },
        images: { kind: "media", multiple: true }
      },
      options: { draftAndPublish: true }
    });

    expect(preview.artifacts).toEqual(["collection source", "typed SDK", "OpenAPI schema", "database schema"]);
    expect(preview.steps).toEqual([
      { title: "1. Write schema source", detail: "Save product-reviews as a generated collection module." },
      { title: "2. Refresh contracts", detail: "Regenerate SDK and OpenAPI contracts for ProductReviews." },
      { title: "3. Plan persistence", detail: "Generate database schema and review the migration plan." },
      { title: "4. Verify before deploy", detail: "Run doctor and drift checks before shipping the content type." }
    ]);
    expect(preview.sdk).toContain("export type ProductReviewsInput");
    expect(preview.sdk).toContain("title: string;");
    expect(preview.sdk).toContain("rating: number;");
    expect(preview.sdk).toContain("state?: \"draft\" | \"approved\";");
    expect(preview.sdk).toContain("images?: string[];");
    expect(preview.sdk).toContain("client.productReviews.create(input satisfies ProductReviewsInput);");
    expect(preview.api).toContain("GET /api/product-reviews");
    expect(preview.api).toContain("POST /api/product-reviews/:id/publish");
    expect(preview.integration).toContain("bunx hono-cms doctor");
    expect(preview.integration).toContain("bunx hono-cms schema check-sdk --schema ./src/schema.ts --out ./src/generated/sdk.ts");
    expect(preview.integration).toContain("bunx hono-cms schema plan --schema ./src/schema.ts --state ./.hono-cms/schema-state.json");
    expect(preview.integration).toContain("// POST /api/product-reviews accepts ProductReviewsInput");
  });

  it("copies generated preview snippets through an injected clipboard", async () => {
    const clipboard = { writeText: async (_value: string) => undefined };
    const writeText = vi.spyOn(clipboard, "writeText");

    await copyGeneratedSnippet("client.products.findMany()", clipboard);

    expect(writeText).toHaveBeenCalledWith("client.products.findMany()");
  });

  it("previews schema builder risk before writes", () => {
    expect(contentTypeChangePreview(null, {
      name: "products",
      fields: { title: { kind: "string" } },
      options: {}
    })).toMatchObject({ risk: "low", details: ["Create products with 1 field."] });

    expect(contentTypeChangePreview({
      name: "products",
      fields: { title: { kind: "string" }, legacy: { kind: "text" } },
      options: {}
    }, {
      name: "catalog",
      fields: { title: { kind: "richtext", required: true, unique: true }, heroImage: { kind: "media" } },
      options: { draftAndPublish: true }
    })).toEqual({
      risk: "high",
      title: "High-risk schema change",
      details: [
        "Rename collection products to catalog.",
        "Change title from string to richtext.",
        "Make title required.",
        "Add unique constraint to title.",
        "Remove field legacy.",
        "Add heroImage (media).",
        "Enable draft/publish workflow."
      ]
    });

    expect(contentTypeChangePreview({
      name: "articles",
      fields: { title: { kind: "string" } },
      options: {}
    }, {
      name: "articles",
      fields: { title: { kind: "string" } },
      options: { draftAndPublish: true }
    })).toEqual({
      risk: "medium",
      title: "Review schema change",
      details: ["Enable draft/publish workflow."]
    });
  });
});

describe("i18n settings mapping", () => {
  it("normalizes i18n backfill form input", () => {
    const form = new FormData();
    form.set("locale", " es ");
    form.set("collection", " pages ");

    expect(i18nBackfillInputFromForm(form)).toEqual({
      locale: "es",
      collection: "pages"
    });
  });

  it("omits collection when all localized collections are selected", () => {
    const form = new FormData();
    form.set("locale", "es");
    form.set("collection", "all");

    expect(i18nBackfillInputFromForm(form)).toEqual({ locale: "es" });
  });

  it("derives localized collections excluding default locales", () => {
    expect(localizedCollectionOptions({
      collections: {
        articles: {
          name: "articles",
          fields: {},
          options: { i18n: { locales: ["en", "es", "fr"], defaultLocale: "en" } }
        },
        authors: { name: "authors", fields: {}, options: {} }
      }
    })).toEqual([{ collection: "articles", defaultLocale: "en", locales: ["es", "fr"] }]);
  });
});

describe("audit log form mapping", () => {
  it("normalizes filters into the typed audit query options", () => {
    const form = new FormData();
    form.set("collection", " articles ");
    form.set("documentId", " article_1 ");
    form.set("operation", "publish");
    form.set("actorId", " user_1 ");
    form.set("from", "2026-05-01T09:30");
    form.set("to", "2026-05-22T18:45");
    form.set("limit", "250");

    expect(auditLogOptionsFromForm(form)).toMatchObject({
      collection: "articles",
      documentId: "article_1",
      operation: "publish",
      actorId: "user_1",
      limit: 100
    });
    expect(auditLogOptionsFromForm(form).from).toMatch(/^2026-05-01T/);
    expect(auditLogOptionsFromForm(form).to).toMatch(/^2026-05-22T/);
  });

  it("omits blank filters and falls back to a valid page size", () => {
    const form = new FormData();
    form.set("limit", "not-a-number");

    expect(auditLogOptionsFromForm(form)).toEqual({ limit: 25 });
  });
});

describe("webhook selection", () => {
  const hooks = [
    { id: "webhook_1", name: "Deploy", url: "https://hooks.test/deploy", events: ["content.published"], enabled: true },
    { id: "webhook_2", name: "Search", url: "https://hooks.test/search", events: ["content.created"], enabled: false }
  ];

  it("keeps the editor in create mode until a webhook is selected", () => {
    expect(selectedWebhook(hooks, null)).toBeNull();
  });

  it("returns the selected webhook without falling back to the first hook", () => {
    expect(selectedWebhook(hooks, "webhook_2")).toMatchObject({ id: "webhook_2", name: "Search" });
    expect(selectedWebhook(hooks, "missing")).toBeNull();
  });
});

describe("api key selection", () => {
  const keys = [
    { id: "api_key_1", userId: "bot", roles: ["editor"], enabled: true },
    { id: "api_key_2", userId: "admin", roles: ["admin"], enabled: false }
  ];

  it("keeps the editor in create mode until an API key is selected", () => {
    expect(selectedApiKey(keys, null)).toBeNull();
  });

  it("returns the selected API key without falling back", () => {
    expect(selectedApiKey(keys, "api_key_2")).toMatchObject({ id: "api_key_2", userId: "admin" });
    expect(selectedApiKey(keys, "missing")).toBeNull();
  });
});

describe("webhook deliveries", () => {
  it("only retries failed delivery attempts", () => {
    expect(isRetryableWebhookDelivery({ status: "failed" })).toBe(true);
    expect(isRetryableWebhookDelivery({ status: "success" })).toBe(false);
    expect(isRetryableWebhookDelivery({ status: "retrying" })).toBe(false);
    expect(isRetryableWebhookDelivery({ status: "pending" })).toBe(false);
  });
});
