import type { CMSCollections } from "@hono-cms/schema";
import type {
  DatabaseAdapter,
  HookRegistry,
  Identity,
  PluginEvents
} from "@hono-cms/core";

/**
 * Context carried by every GraphQL resolver invocation. Built once per HTTP
 * request from the plugin context + the resolved {@link Identity} (the session
 * bridge, U21 R15 — `auth-tokens.identity(req)`).
 *
 * Resolvers stay thin: they touch the database adapter for reads/writes, dip
 * into {@link HookRegistry} to run lifecycle hooks before/after mutations,
 * and emit {@link PluginEvents.emit} so subscribing plugins (audit, webhooks,
 * content-cache) can do their work.
 */
export type GraphQLContext = {
  collections: CMSCollections;
  db: DatabaseAdapter<CMSCollections>;
  identity: Identity | null;
  request: Request;
  events: PluginEvents;
  hooks: HookRegistry;
};
