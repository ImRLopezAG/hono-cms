import { describe, expect, test } from "vitest";
import { defineCollection, fields } from "@hono-cms/schema";
import { buildRBACMatrix } from "../rbac-matrix";

describe("buildRBACMatrix", () => {
  test("aggregates roles, rules, and per-collection allow-lists", () => {
    const collections = {
      articles: defineCollection(
        "articles",
        { title: fields.string({ required: true }) },
        {
          rbac: {
            public: ["read"],
            authenticated: ["create", "read"]
          }
        }
      ),
      pages: defineCollection(
        "pages",
        { title: fields.string({ required: true }) }
      )
    };

    const matrix = buildRBACMatrix({
      collections,
      rbac: {
        publicRead: false,
        rules: [
          { action: "publish", collection: "articles", roles: ["editor", "publisher"] },
          { action: "delete", collection: "articles", roles: ["editor"] }
        ]
      }
    });

    expect(matrix.publicRead).toBe(false);
    // admin is always surfaced first; remaining roles sorted alphabetically.
    expect(matrix.roles).toEqual(["admin", "editor", "publisher"]);
    expect(matrix.rules).toEqual([
      { action: "publish", collection: "articles", roles: ["editor", "publisher"] },
      { action: "delete", collection: "articles", roles: ["editor"] }
    ]);
    expect(matrix.collections).toEqual([
      { name: "articles", public: ["read"], authenticated: ["create", "read"] },
      { name: "pages", public: [], authenticated: [] }
    ]);
  });

  test("returns an admin-only role list and empty rules when nothing is configured", () => {
    const matrix = buildRBACMatrix({
      collections: {
        pages: defineCollection("pages", { title: fields.string({ required: true }) })
      }
    });

    expect(matrix.roles).toEqual(["admin"]);
    expect(matrix.rules).toEqual([]);
    expect(matrix.publicRead).toBe(false);
    expect(matrix.collections).toEqual([
      { name: "pages", public: [], authenticated: [] }
    ]);
  });
});
