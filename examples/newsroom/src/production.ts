import {
  createAIProvider,
  createCMS,
  createDrizzleAuditStore,
  createDrizzleTranslationStore,
  type CMSConfig
} from "@hono-cms/core";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import "@hono-cms/jobs";
import { newsroomSchema } from "./schema";

/**
 * Options for {@link createProductionNewsroomCMS}.
 *
 * `db` is a Drizzle database instance (e.g. the value returned by
 * `drizzle(new Database(...))` for `better-sqlite3`, or
 * `drizzle(pool)` for `node-postgres`). It is passed straight through to
 * `createDrizzleAuditStore` and `createDrizzleTranslationStore` — the factory
 * itself does not call the database. The required `audit_log` and
 * `locale_variants` tables must already exist on the underlying database.
 */
export type ProductionNewsroomCMSOptions = {
  db: unknown;
  dialect: "sqlite" | "postgres";
  aiProvider?:
    | { type: "anthropic"; apiKey: string; model?: string; baseUrl?: string }
    | { type: "openai"; apiKey: string; model?: string; baseUrl?: string };
  jobs?: CMSConfig<typeof newsroomSchema>["jobs"];
};

/**
 * Builds the {@link CMSConfig} used by {@link createProductionNewsroomCMS}.
 *
 * Exposed separately so tests and consumers can inspect or extend the wired
 * stores (audit store, translation store, translation provider) without
 * instantiating a full CMS.
 */
export function buildProductionNewsroomConfig(
  options: ProductionNewsroomCMSOptions
): CMSConfig<typeof newsroomSchema> {
  const auditStore = createDrizzleAuditStore(options.db, { dialect: options.dialect });
  const translationStore = createDrizzleTranslationStore(options.db, { dialect: options.dialect });

  const translationProvider = options.aiProvider
    ? createAIProvider(
        options.aiProvider.type === "anthropic"
          ? {
              provider: "anthropic",
              apiKey: options.aiProvider.apiKey,
              ...(options.aiProvider.model ? { model: options.aiProvider.model } : {}),
              ...(options.aiProvider.baseUrl ? { baseUrl: options.aiProvider.baseUrl } : {})
            }
          : {
              provider: "openai",
              apiKey: options.aiProvider.apiKey,
              ...(options.aiProvider.model ? { model: options.aiProvider.model } : {}),
              ...(options.aiProvider.baseUrl ? { baseUrl: options.aiProvider.baseUrl } : {})
            }
      )
    : undefined;

  return {
    collections: newsroomSchema,
    // The memory database is kept here so the example stays runnable as a
    // single file. Production deployments should swap this for a Drizzle or
    // Prisma adapter that shares the same underlying `options.db`.
    db: createMemoryDatabase({ provider: "memory", collections: newsroomSchema }),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    auth: {
      tokens: {
        admin: { userId: "admin_1", roles: ["admin"] },
        editor: { userId: "editor_1", roles: ["editor"] }
      }
    },
    rbac: { publicRead: true },
    openapi: {
      path: "/cms/openapi.json",
      docs: "/cms/docs",
      title: "Newsroom CMS API",
      version: "0.1.0",
      description: "Example newsroom API built with Hono CMS.",
      servers: [{ url: "https://newsroom.example.com", description: "Production" }]
    },
    auditLog: { store: auditStore },
    i18n: {
      store: translationStore,
      ...(translationProvider ? { provider: translationProvider } : {})
    }
  };
}

/**
 * Production-style newsroom CMS factory that wires Drizzle-backed audit and
 * translation stores and (optionally) an AI translation provider.
 *
 * The default `createNewsroomCMS` in `./app.ts` continues to use in-memory
 * stores so existing tests and quickstart flows remain hermetic.
 */
export function createProductionNewsroomCMS(options: ProductionNewsroomCMSOptions) {
  return createCMS(buildProductionNewsroomConfig(options));
}
