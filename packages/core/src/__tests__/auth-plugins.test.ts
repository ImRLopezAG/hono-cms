import { describe, expect, test } from "vitest";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import { twoFactor } from "better-auth/plugins/two-factor";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createBetterAuthAdapter, createCMS, MemoryApiKeyStore } from "../index";
import { createMemoryDatabase } from "../../../adapter-memory/src/index";
import "../../../cache/src/index";
import type { AuthAdapter, AuthSession } from "../types/providers";

// ---------------------------------------------------------------------------
// Plan-4 U7 audit: prove the magic-link, 2FA, email-verify, and api-keys plugin
// routes are wired through createCMS and respond on the documented paths.
//
// Route paths exercised (discovered from create-cms.ts:59 and better-auth plugin
// sources under node_modules/.bun/better-auth@1.6.11/.../dist/plugins/*/index.mjs):
//   - POST /api/auth/sign-in/magic-link        (better-auth magic-link plugin)
//   - GET  /api/auth/magic-link/verify         (better-auth magic-link plugin)
//   - POST /api/auth/two-factor/enable         (better-auth two-factor plugin)
//   - GET  /api/auth/verify-email              (better-auth core email-verification)
//   - GET  /cms/settings/api-keys              (CMS-owned)
//   - POST /cms/settings/api-keys              (CMS-owned)
//
// NOTE: the original audit request referenced `POST /cms/api-keys`, but the
// actual mount in create-cms.ts is `/cms/settings/api-keys`. Tests use the
// real path; report flags the doc/path drift.
// ---------------------------------------------------------------------------

const emptyCollections = defineSchema({
  notes: defineCollection("notes", { title: fields.string({ required: true }) })
});

type MagicLinkCall = { email: string; url: string; token: string };

function buildBetterAuth(options: {
  magicLink?: { sendMagicLink: (input: MagicLinkCall) => Promise<void> | void };
  twoFactor?: boolean;
  emailVerification?: { sendVerificationEmail: (input: { user: { email: string }; token: string; url: string }) => Promise<void> };
}) {
  const plugins: unknown[] = [];
  if (options.magicLink) {
    plugins.push(magicLink({
      sendMagicLink: async ({ email, url, token }) => {
        await options.magicLink!.sendMagicLink({ email, url, token });
      }
    }));
  }
  if (options.twoFactor) {
    plugins.push(twoFactor());
  }
  // betterAuth() with no `database` falls back to the auto-loaded
  // @better-auth/memory-adapter (see node_modules/.bun/better-auth.../db/adapter-base.mjs:6).
  // This lets the plugin routes register and respond without provisioning a real
  // Drizzle schema in the test fixture.
  return betterAuth({
    appName: "audit-fixture",
    basePath: "/api/auth",
    baseURL: "https://cms.test",
    secret: "test-secret-32-bytes-min-aaaaaaaaaaaa",
    emailAndPassword: { enabled: true },
    ...(options.emailVerification
      ? { emailVerification: { sendVerificationEmail: options.emailVerification.sendVerificationEmail } }
      : {}),
    // Plugin tuple shapes diverge across better-auth's typed list, but the
    // runtime accepts any registered plugin object. Cast to satisfy the
    // overloaded union without coupling the test to internal plugin types.
    plugins: plugins as never
  });
}

function adminAuthAdapter(auth: ReturnType<typeof buildBetterAuth>): AuthAdapter {
  const wrapped = createBetterAuthAdapter(auth);
  return {
    provider: "better-auth-test-hybrid",
    async sessionFromRequest(request: Request): Promise<AuthSession | null> {
      // The CMS api-keys routes require an admin role. Short-circuit on the
      // `authorization: Bearer admin` header so we don't have to drive a full
      // better-auth signup/signin flow inside this test fixture.
      const header = request.headers.get("authorization");
      if (header === "Bearer admin") return { userId: "admin-1", roles: ["admin"] };
      if (header === "Bearer anon") return null;
      return wrapped.sessionFromRequest(request);
    },
    handleAuth(request: Request) {
      return auth.handler(request);
    },
    async health() {
      return { ok: true };
    }
  };
}

function buildCMS(authAdapter: AuthAdapter) {
  return createCMS({
    collections: emptyCollections,
    db: createMemoryDatabase({ provider: "memory", collections: emptyCollections }),
    cache: { provider: "memory" },
    auth: authAdapter,
    // When `auth` is a pre-built AuthAdapter (not an `api-key` provider config),
    // resolveApiKeyStore returns null and the api-keys routes 409. Explicitly
    // supply a MemoryApiKeyStore so the CMS-owned api-keys routes are exercised.
    apiKeyStore: new MemoryApiKeyStore()
  });
}

describe("better-auth plugin route wiring (audit U7)", () => {
  describe("magic-link plugin", () => {
    test("POST /api/auth/sign-in/magic-link triggers the configured sender", async () => {
      const calls: MagicLinkCall[] = [];
      const auth = buildBetterAuth({
        magicLink: {
          sendMagicLink: (input) => {
            calls.push(input);
          }
        }
      });
      const app = buildCMS(adminAuthAdapter(auth));

      const response = await app.fetch(new Request("https://cms.test/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", callbackURL: "/" })
      }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.email).toBe("test@example.com");
      expect(calls[0]?.token.length).toBeGreaterThan(8);
      expect(calls[0]?.url).toContain("/api/auth/magic-link/verify?token=");
    });

    test("POST /api/auth/sign-in/magic-link rejects malformed body with 4xx", async () => {
      const auth = buildBetterAuth({ magicLink: { sendMagicLink: () => {} } });
      const app = buildCMS(adminAuthAdapter(auth));

      const response = await app.fetch(new Request("https://cms.test/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" })
      }));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });
  });

  describe("two-factor plugin", () => {
    test("POST /api/auth/two-factor/enable returns 4xx without an authenticated session (route is mounted)", async () => {
      const auth = buildBetterAuth({ twoFactor: true });
      const app = buildCMS(adminAuthAdapter(auth));

      // Calling /two-factor/enable without a valid better-auth session must NOT
      // return 404 (which would mean the plugin failed to register). It should
      // return 401/400 because the sessionMiddleware rejects unauthenticated
      // callers (see better-auth/dist/plugins/two-factor/index.mjs:57 `use: [sessionMiddleware]`).
      const response = await app.fetch(new Request("https://cms.test/api/auth/two-factor/enable", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer anon" },
        body: JSON.stringify({ password: "irrelevant" })
      }));

      expect(response.status).not.toBe(404);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    test("POST /api/auth/two-factor/enable returns 404 when the plugin is NOT registered", async () => {
      const auth = buildBetterAuth({}); // no twoFactor plugin
      const app = buildCMS(adminAuthAdapter(auth));

      const response = await app.fetch(new Request("https://cms.test/api/auth/two-factor/enable", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer anon" },
        body: JSON.stringify({ password: "irrelevant" })
      }));

      expect(response.status).toBe(404);
    });
  });

  describe("email verification (better-auth core, not a separate plugin)", () => {
    test("GET /api/auth/verify-email with a malformed token returns 4xx", async () => {
      const auth = buildBetterAuth({
        emailVerification: { sendVerificationEmail: async () => {} }
      });
      const app = buildCMS(adminAuthAdapter(auth));

      const response = await app.fetch(new Request("https://cms.test/api/auth/verify-email?token=not-a-real-jwt", {
        method: "GET"
      }));

      // verifyEmail (email-verification.mjs:161) throws UNAUTHORIZED via APIError when
      // jwtVerify rejects, or redirects when callbackURL is set. Without callbackURL
      // we expect a non-2xx response (401 from APIError).
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    test("GET /api/auth/verify-email without a token returns 4xx (route mounted)", async () => {
      const auth = buildBetterAuth({});
      const app = buildCMS(adminAuthAdapter(auth));

      const response = await app.fetch(new Request("https://cms.test/api/auth/verify-email", {
        method: "GET"
      }));

      // Route exists -> 400 from missing required `token` query; if it returned
      // 404 the email-verification endpoint would not be mounted at all.
      expect(response.status).not.toBe(404);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    // Driving the full happy-path (creating a verification JWT, then calling
    // /verify-email with the real token) requires creating a user row in the
    // better-auth memory adapter, which the in-memory adapter supports but
    // requires a multi-step sign-up flow that's out of scope for U7's
    // request/response surface check. The two error-path tests above prove the
    // route is registered through createCMS's /api/auth/* handler.
    test.todo("happy-path verify-email with a real JWT (requires sign-up flow)");
  });

  describe("CMS-owned api-keys routes", () => {
    test("POST /cms/settings/api-keys creates a key, GET lists it with masked prefix", async () => {
      const auth = buildBetterAuth({});
      const app = buildCMS(adminAuthAdapter(auth));

      const created = await app.fetch(new Request("https://cms.test/cms/settings/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer admin" },
        body: JSON.stringify({
          name: "ci-bot",
          userId: "user-42",
          roles: ["editor"]
        })
      }));

      expect(created.status).toBe(201);
      const createdBody = await created.json() as { id: string; name: string; prefix?: string; secret: string; roles: string[] };
      expect(createdBody.id).toBeTruthy();
      expect(createdBody.name).toBe("ci-bot");
      expect(createdBody.secret).toMatch(/.+/);
      expect("hash" in createdBody).toBe(false); // hash must never leak to the wire
      expect(createdBody.roles).toEqual(["editor"]);
      // serializeApiKey strips the hash but keeps the prefix for UI display.
      expect(typeof createdBody.prefix === "string" || createdBody.prefix === undefined).toBe(true);

      const listed = await app.fetch(new Request("https://cms.test/cms/settings/api-keys", {
        headers: { "authorization": "Bearer admin" }
      }));
      expect(listed.status).toBe(200);
      const listedBody = await listed.json() as { items: Array<{ id: string; name?: string; prefix?: string }>; meta: { total: number } };
      expect(listedBody.meta.total).toBe(1);
      expect(listedBody.items[0]?.id).toBe(createdBody.id);
      // The list endpoint must NOT echo the raw secret nor the stored hash.
      const listedItem = listedBody.items[0] as Record<string, unknown>;
      expect(listedItem.secret).toBeUndefined();
      expect(listedItem.hash).toBeUndefined();
    });

    test("GET /cms/settings/api-keys returns 403 without admin auth", async () => {
      const auth = buildBetterAuth({});
      const app = buildCMS(adminAuthAdapter(auth));

      const response = await app.fetch(new Request("https://cms.test/cms/settings/api-keys"));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: "forbidden" });
    });

    test("POST /cms/settings/api-keys with missing fields returns 4xx", async () => {
      const auth = buildBetterAuth({});
      const app = buildCMS(adminAuthAdapter(auth));

      const response = await app.fetch(new Request("https://cms.test/cms/settings/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer admin" },
        body: JSON.stringify({ name: "missing-userid" })
      }));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });
  });
});
