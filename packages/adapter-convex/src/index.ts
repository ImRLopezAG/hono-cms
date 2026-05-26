import { assertCapability, PortableDocumentAdapter, type DocumentExecutor } from "@hono-cms/adapter-kit";
import { registerProvider, type DatabaseAdapter } from "@hono-cms/core";
import type { CMSCollections, ContentRecord, QueryParams } from "@hono-cms/schema";

export type ConvexClientLike = {
  query?(name: string, args?: Record<string, unknown>): Promise<unknown>;
  mutation?(name: string, args?: Record<string, unknown>): Promise<unknown>;
};

export type ConvexAdapterConfig<Collections extends CMSCollections = CMSCollections> = {
  provider: "convex";
  collections: Collections;
  url?: string;
  client?: ConvexClientLike;
  delegate?: DocumentExecutor;
};

export class ConvexAdapter<Collections extends CMSCollections = CMSCollections> extends PortableDocumentAdapter<Collections, ConvexClientLike | null> {
  constructor(config: ConvexAdapterConfig<Collections>) {
    const options: ConstructorParameters<typeof PortableDocumentAdapter<Collections, ConvexClientLike | null>>[0] = {
      provider: "convex",
      collections: config.collections,
      client: config.client ?? null,
      dialect: "convex",
      capabilities: {
        transactions: false,
        jsonOperators: false,
        advisoryLocks: false,
        migrations: true,
        populate: true
      }
    };
    if (config.delegate) options.delegate = config.delegate;
    super(options);
  }

  override async list(collection: keyof Collections & string, query?: QueryParams) {
    if (query?.sort) assertCapability("convex", false, "server-side arbitrary sort");
    return super.list(collection, query);
  }

  override async publish(collection: keyof Collections & string, id: string): Promise<ContentRecord> {
    return this.update(collection, id, { status: "published" });
  }
}

export function createConvexAdapter<Collections extends CMSCollections>(config: ConvexAdapterConfig<Collections>): ConvexAdapter<Collections> {
  return new ConvexAdapter(config);
}

registerProvider<ConvexAdapterConfig, DatabaseAdapter>("db", "convex", createConvexAdapter);

/** Preferred factory name per U24 — explicit alias of `createConvexAdapter`. */
export const convexAdapter = createConvexAdapter;
