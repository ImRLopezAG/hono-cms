import { describe, expect, test } from "vitest";
import type { BetterAuthPlugin } from "better-auth";
import type { AuthConfig, BetterAuthLike, CMSConfig } from "../index";
import { createAuthSchemaSnapshot, createBetterAuthAdapter, isAuthConfig, toBetterAuthDatabaseProvider } from "../index";

describe("better-auth config typing", () => {
  test("maps CMS database providers to better-auth drizzle providers", () => {
    expect(toBetterAuthDatabaseProvider("sqlite")).toBe("sqlite");
    expect(toBetterAuthDatabaseProvider("d1")).toBe("sqlite");
    expect(toBetterAuthDatabaseProvider("turso")).toBe("sqlite");
    expect(toBetterAuthDatabaseProvider("postgres")).toBe("pg");
    expect(toBetterAuthDatabaseProvider("mysql")).toBe("mysql");
  });

  test("detects better-auth config separately from legacy built-in auth configs", () => {
    expect(isAuthConfig(authConfig)).toBe(true);
    expect(isAuthConfig({ tokens: { admin: { userId: "1", roles: ["admin"] } } })).toBe(false);
    expect(isAuthConfig({ provider: "api-key", keys: [] })).toBe(false);
  });

  test("adapts better-auth handlers and sessions into the CMS auth contract", async () => {
    const calls: Request[] = [];
    const auth = {
      async handler(request) {
        calls.push(request);
        return Response.json({ handled: true }, { status: 202 });
      },
      api: {
        async getSession({ headers }) {
          return headers.get("cookie")
            ? { user: { id: "user_1", roles: ["admin", "editor"] }, session: { id: "session_1" } }
            : null;
        }
      }
    } satisfies BetterAuthLike;

    const adapter = createBetterAuthAdapter(auth);
    await expect(adapter.sessionFromRequest(new Request("https://cms.test/cms/schema"))).resolves.toBeNull();
    await expect(adapter.sessionFromRequest(new Request("https://cms.test/cms/schema", {
      headers: { cookie: "better-auth.session_token=session" }
    }))).resolves.toEqual({ userId: "user_1", roles: ["admin", "editor"] });

    const response = await adapter.handleAuth?.(new Request("https://cms.test/api/auth/get-session"));
    expect(response?.status).toBe(202);
    expect(calls).toHaveLength(1);
  });

  test("creates deterministic better-auth table snapshots for migration planning", () => {
    const snapshot = createAuthSchemaSnapshot({
      emailAndPassword: { enabled: true },
      user: {
        additionalFields: {
          role: { type: "string", required: false, defaultValue: "user" }
        }
      }
    });

    expect(Object.keys(snapshot)).toEqual(expect.arrayContaining(["auth:account", "auth:session", "auth:user", "auth:verification"]));
    expect(snapshot["auth:user"]).toMatchObject({
      name: "user",
      fields: {
        email: { type: "string", required: true },
        role: { type: "string", required: false }
      }
    });
  });
});

const plugin = { id: "cms-test-plugin" } satisfies BetterAuthPlugin;

const authConfig = {
  appName: "Newsroom CMS",
  basePath: "/api/auth",
  trustedOrigins: ["https://admin.example.com"],
  emailAndPassword: { enabled: true },
  plugins: [plugin]
} satisfies AuthConfig;

const configAcceptsBetterAuth = {
  collections: {},
  db: {
    provider: "memory",
    collections: {},
    client: null,
    async list() {
      return { items: [] };
    },
    async get() {
      return null;
    },
    async create(_collection: string, input: Record<string, unknown>) {
      return { id: "1", createdAt: "", updatedAt: "", ...input };
    },
    async update(_collection: string, id: string, patch: Record<string, unknown>) {
      return { id, createdAt: "", updatedAt: "", ...patch };
    },
    async delete() {}
  },
  openapi: { path: "/cms/openapi.json", docs: "/cms/docs" },
  auth: authConfig
} satisfies CMSConfig;

// @ts-expect-error CMS-owned Better Auth config must not allow user-supplied database instances.
const authConfigRejectsDatabase = { database: {} } satisfies AuthConfig;

void configAcceptsBetterAuth;
void authConfigRejectsDatabase;
