import { PortableDocumentAdapter, createSqlDocumentExecutor, type DocumentExecutor, type SqlStatementExecutor } from "@hono-cms/adapter-kit";
import { registerProvider, type DatabaseAdapter } from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";

export type TursoAdapterConfig<Collections extends CMSCollections = CMSCollections> = {
  provider: "turso";
  collections: Collections;
  url?: string;
  authToken?: string;
  syncUrl?: string;
  syncInterval?: number;
  client?: SqlStatementExecutor;
  delegate?: DocumentExecutor;
};

export class TursoAdapter<Collections extends CMSCollections = CMSCollections> extends PortableDocumentAdapter<Collections, SqlStatementExecutor | null> {
  readonly url: string;
  readonly syncUrl: string | null;

  constructor(config: TursoAdapterConfig<Collections>) {
    const options: ConstructorParameters<typeof PortableDocumentAdapter<Collections, SqlStatementExecutor | null>>[0] = {
      provider: "turso",
      collections: config.collections,
      client: config.client ?? null,
      dialect: "sqlite",
      capabilities: {
        transactions: true,
        jsonOperators: true,
        advisoryLocks: false,
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
        dialect: "sqlite"
      });
    }
    super(options);
    this.url = config.url ?? "file::memory:";
    this.syncUrl = config.syncUrl ?? null;
  }
}

export function createTursoAdapter<Collections extends CMSCollections>(config: TursoAdapterConfig<Collections>): TursoAdapter<Collections> {
  return new TursoAdapter(config);
}

registerProvider<TursoAdapterConfig, DatabaseAdapter>("db", "turso", createTursoAdapter);
