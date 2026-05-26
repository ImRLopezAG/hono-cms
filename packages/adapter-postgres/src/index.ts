import { PortableDocumentAdapter, createSqlDocumentExecutor, type DocumentExecutor, type SqlStatementExecutor } from "@hono-cms/adapter-kit";
import { registerProvider, type DatabaseAdapter } from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";

export type PostgresMode = "tcp" | "http";

export type PostgresAdapterConfig<Collections extends CMSCollections = CMSCollections> = {
  provider: "postgres";
  collections: Collections;
  url?: string;
  mode?: PostgresMode;
  client?: SqlStatementExecutor;
  delegate?: DocumentExecutor;
};

export class PostgresAdapter<Collections extends CMSCollections = CMSCollections> extends PortableDocumentAdapter<Collections, SqlStatementExecutor | null> {
  readonly mode: PostgresMode;

  constructor(config: PostgresAdapterConfig<Collections>) {
    const mode = config.mode ?? detectPostgresMode(config.url);
    const options: ConstructorParameters<typeof PortableDocumentAdapter<Collections, SqlStatementExecutor | null>>[0] = {
      provider: "postgres",
      collections: config.collections,
      client: config.client ?? null,
      dialect: "postgres",
      capabilities: {
        transactions: mode === "tcp",
        jsonOperators: true,
        advisoryLocks: mode === "tcp",
        migrations: true,
        populate: true
      }
    };
    if (config.delegate) {
      options.delegate = config.delegate;
    } else if (config.client) {
      options.delegate = createSqlDocumentExecutor({
        collections: config.collections,
        executor: config.client,
        dialect: "postgres"
      });
    }
    super(options);
    this.mode = mode;
  }
}

export function detectPostgresMode(url = ""): PostgresMode {
  if (url.includes("neon.tech")) return "http";
  return typeof process !== "undefined" && process.versions?.node ? "tcp" : "http";
}

export function createPostgresAdapter<Collections extends CMSCollections>(config: PostgresAdapterConfig<Collections>): PostgresAdapter<Collections> {
  return new PostgresAdapter(config);
}

registerProvider<PostgresAdapterConfig, DatabaseAdapter>("db", "postgres", createPostgresAdapter);
