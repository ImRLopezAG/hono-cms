import { describe, expect, test } from "vitest";
import { buildProductionNewsroomConfig, createProductionNewsroomCMS } from "./production";

// The Drizzle stores only touch `db` when a method like `append` or
// `upsertVariant` is invoked, so a bare object is enough for shape tests.
const dbStub = { __label: "drizzle-stub" } as unknown;

describe("createProductionNewsroomCMS", () => {
  test("is callable and returns a CMS instance with a fetch handler", async () => {
    const cms = createProductionNewsroomCMS({ db: dbStub, dialect: "sqlite" });

    expect(typeof cms.fetch).toBe("function");

    const live = await cms.fetch(new Request("https://cms.test/cms/health/live"));
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("wires Drizzle audit and translation stores into the config", () => {
    const config = buildProductionNewsroomConfig({ db: dbStub, dialect: "sqlite" });

    expect(config.auditLog).toBeTruthy();
    expect(config.auditLog ? config.auditLog.store : null).toBeTruthy();
    expect(typeof (config.auditLog ? config.auditLog.store?.append : undefined)).toBe(
      "function"
    );

    expect(config.i18n?.store).toBeTruthy();
    expect(typeof config.i18n?.store?.upsertVariant).toBe("function");
  });

  test("omits the translation provider when aiProvider is not supplied", () => {
    const config = buildProductionNewsroomConfig({ db: dbStub, dialect: "sqlite" });
    expect(config.i18n?.provider).toBeUndefined();
  });

  test("wires an Anthropic translation provider when aiProvider.type is 'anthropic'", () => {
    const config = buildProductionNewsroomConfig({
      db: dbStub,
      dialect: "sqlite",
      aiProvider: { type: "anthropic", apiKey: "test-key" }
    });

    expect(config.i18n?.provider).toBeTruthy();
    expect(config.i18n?.provider?.provider).toBe("anthropic");
    expect(typeof config.i18n?.provider?.translate).toBe("function");
  });

  test("wires an OpenAI translation provider when aiProvider.type is 'openai'", () => {
    const config = buildProductionNewsroomConfig({
      db: dbStub,
      dialect: "postgres",
      aiProvider: { type: "openai", apiKey: "test-key" }
    });

    expect(config.i18n?.provider?.provider).toBe("openai");
  });
});
