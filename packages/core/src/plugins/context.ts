import type { CMSCollections } from "@hono-cms/schema";
import type { DatabaseAdapter, MediaStore, StorageAdapter } from "../types/providers";
import { createEventBus } from "./event-bus";
import { createHookRegistry } from "./hook-registry";
import { createServiceRegistry } from "./service-registry";
import type { PluginContext, PluginTableDef } from "./types";

export type PluginContextInit<Collections extends CMSCollections> = {
  collections: Collections;
  db: DatabaseAdapter<Collections>;
  storage?: StorageAdapter | undefined;
  mediaStore?: MediaStore | undefined;
  env?: Record<string, unknown> | undefined;
  baseUrl?: string | undefined;
  systemTables?: ReadonlyMap<string, PluginTableDef> | undefined;
};

export function createPluginContext<Collections extends CMSCollections>(
  init: PluginContextInit<Collections>
): PluginContext<Collections> {
  return {
    collections: init.collections,
    db: init.db,
    storage: init.storage,
    mediaStore: init.mediaStore,
    env: init.env ?? {},
    baseUrl: init.baseUrl,
    plugins: createServiceRegistry(),
    events: createEventBus(),
    hooks: createHookRegistry(),
    systemTables: init.systemTables ?? new Map()
  };
}
