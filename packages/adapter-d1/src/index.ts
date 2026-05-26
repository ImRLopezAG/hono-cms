import { PortableDocumentAdapter, createSqlDocumentExecutor, type DocumentExecutor, type SqlStatementExecutor } from "@hono-cms/adapter-kit";
import { registerProvider, type DatabaseAdapter } from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";

export type D1DatabaseLike = SqlStatementExecutor & {
  prepare?(statement: string): {
    bind(...values: unknown[]): { all<T = unknown>(): Promise<{ results: T[] }>; run(): Promise<unknown> };
  };
};

export type D1AdapterConfig<Collections extends CMSCollections = CMSCollections> = {
  provider: "d1";
  collections: Collections;
  binding?: D1DatabaseLike;
  delegate?: DocumentExecutor;
};

export class D1Adapter<Collections extends CMSCollections = CMSCollections> extends PortableDocumentAdapter<Collections, D1DatabaseLike | null> {
  constructor(config: D1AdapterConfig<Collections>) {
    const options: ConstructorParameters<typeof PortableDocumentAdapter<Collections, D1DatabaseLike | null>>[0] = {
      provider: "d1",
      collections: config.collections,
      client: config.binding ?? null,
      dialect: "sqlite",
      capabilities: {
        transactions: true,
        jsonOperators: false,
        advisoryLocks: false,
        migrations: true,
        populate: true
      }
    };
    if (config.delegate) {
      options.delegate = config.delegate;
    } else if (config.binding) {
      options.delegate = createSqlDocumentExecutor({
        collections: config.collections,
        executor: toD1Executor(config.binding),
        dialect: "sqlite"
      });
    }
    super(options);
  }
}

export function createD1Adapter<Collections extends CMSCollections>(config: D1AdapterConfig<Collections>): D1Adapter<Collections> {
  return new D1Adapter(config);
}

registerProvider<D1AdapterConfig, DatabaseAdapter>("db", "d1", createD1Adapter);

function toD1Executor(binding: D1DatabaseLike): SqlStatementExecutor {
  if (binding.query || binding.execute) return binding;
  return {
    async query(statement, params = []) {
      if (!binding.prepare) throw new Error("D1 binding does not provide prepare().");
      return binding.prepare(statement).bind(...params).all<Record<string, unknown>>().then((result) => result.results);
    },
    async execute(statement, params = []) {
      if (!binding.prepare) throw new Error("D1 binding does not provide prepare().");
      return binding.prepare(statement).bind(...params).run();
    }
  };
}

/** Preferred factory name per U24 — explicit alias of `createD1Adapter`. */
export const d1Adapter = createD1Adapter;
