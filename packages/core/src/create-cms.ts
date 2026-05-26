import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { Hono } from "hono";
import { TrieRouter } from "hono/router/trie-router";
import { collectionToZod, defineCollection, defineSchema, generateCollectionFile, getSchemaComponents, relationHasLocalIdField, type CMSCollections, type CollectionDefinition, type CollectionOptions, type FieldDefinition, type FieldsDefinition, type RelationCardinality } from "@hono-cms/schema";
import { apiKeyPrefix, generateApiKeySecret, hashApiKey, MemoryApiKeyStore, type ApiKeyListItem, type ApiKeyRecord, type ApiKeyStore } from "./auth";
import { auditEntriesToCSV, auditLogCleanupJob, MemoryAuditStore, writeAuditEntry } from "./audit";
import { applyListQuery, filterRecordsByRelations, InvalidCursorError, parseQueryParams, publicListResult, splitRelationFilters, type QueryValidationIssue, type RelationFilter, validateQueryParams } from "./content/query";
import { contentCacheTtl, invalidateContentCache, normalizedRequestCacheSource, readContentCache, writeContentCache } from "./content/cache";
import { deleteWithRelationPolicy, RelationConstraintError } from "./content/delete";
import { populateRecords } from "./content/populate";
import { forbiddenWriteFields, projectRecords, projectRecord } from "./content/projection";
import { listWithLocaleFallback, localeFromRequest, localeValidationError, withDefaultLocale } from "./content/i18n";
import { generatePreviewToken, revokePreviewToken, verifyPreviewToken } from "./content/preview";
import { normalizeDraftInput, publishDocument, runScheduledPublishes, schedulePublish, stripSystemDraftFields, unpublishDocument, unschedulePublish } from "./content/publish";
import { enqueueTranslationJobs, getLocaleVariantWithFallback, localizableFieldNames, MemoryTranslationStore, overlayLocaleVariant, overlayLocaleVariants, translateDocument } from "./content/translation";
import { canAccess, type Action } from "./content/rbac";
import { buildRBACMatrix } from "./content/rbac-matrix";
import { createOpenAPISpec, mergeOpenAPISpec } from "./openapi";
import { buildCollectionRouteConfigs } from "./openapi-content-routes";
import { createGraphQLSDL } from "./graphql";
import { buildGraphQLSchema } from "./graphql/schema-builder";
import { createApolloHandler } from "./graphql/apollo-handler";
import type { CMSGraphQLContext } from "./graphql/context";
import { runHealthChecks } from "./health";
import { confirmMediaUpload, createMediaPresign, MediaPresignStore, MemoryMediaStore, uploadMediaObject } from "./media";
import { MemoryOrganizationStore, type OrganizationInvitationInput, type OrganizationMemberStatus, type OrganizationUpdateInput } from "./organization";
import { applyPlugins } from "./plugins";
import { createAuthAdapter, createCacheAdapter, createDatabaseAdapter, createJobsAdapter, createStorageAdapter } from "./providers/factories";
import { deliverWebhookTest, dispatchWebhooks, MemoryWebhookStore, retryFailedWebhookDelivery, retryWebhookDelivery, runWebhookRetrySweep, serializeWebhook, webhookDeliveryCleanupJob } from "./webhooks";
import type { CMSConfig, CorsConfig, GraphQLConfig, HookFunction, OpenAPIConfig, SchemaWriteResult } from "./types/config";
import type { CMSInstance, HonoCMSEnv } from "./types/instance";
import type { AuditLogQuery, AuditOperation, AuthSession, CacheAdapter, ContentRecord, DatabaseAdapter, HealthStatus, ListQuery, MediaListQuery, MediaRecord, WebhookDelivery, WebhookRecord, WebhookStore, WebhookEvent } from "./types/providers";
import {logger} from 'hono/logger'
import {poweredBy} from 'hono/powered-by'
import { requestId } from 'hono/request-id'

const AUDIT_OPERATIONS = new Set<AuditOperation>(["create", "update", "delete", "publish", "unpublish", "media_upload", "media_delete", "schema_change"]);

export function createCMS<const Collections extends CMSCollections>(config: CMSConfig<Collections>): CMSInstance<Collections> {
  // Shallow-copy the collections record so live mutations from the content-type
  // builder don't leak back into the caller's schema object. The CollectionDefinition
  // entries themselves are read-only at runtime.
  config = { ...config, collections: { ...config.collections } as Collections };
  const startedAt = Date.now();
  const db = createDatabaseAdapter(config.db);
  const storage = createStorageAdapter(config.storage);
  const cache = createCacheAdapter(config.cache);
  const jobs = createJobsAdapter(config.jobs, config.baseUrl);
  const apiKeyStore = resolveApiKeyStore(config.auth, config.apiKeyStore);
  const auth = createAuthAdapter(withResolvedApiKeyStore(config.auth, apiKeyStore), db);
  const organizationStore = config.organizationStore ?? new MemoryOrganizationStore();
  const auditStore = config.auditLog === false ? null : config.auditLog?.store ?? new MemoryAuditStore();
  const webhookStore = config.webhookStore ?? new MemoryWebhookStore();
  const mediaStore = config.mediaStore ?? new MemoryMediaStore();
  const translationStore = config.i18n?.store ?? new MemoryTranslationStore();
  const mediaPresigns = new MediaPresignStore(cache);
  const openAPI = buildOpenAPIResponse(config);
  const graphQL = buildGraphQLConfig(config);
  // Plan-12 U1: use OpenAPIHono so content-collection routes registered via
  // `app.openapi(createRoute({...}), handler)` populate the OpenAPI registry.
  // Other routes (auth, admin, media, GraphQL) remain on the plain
  // `app.get/post/...` path and continue to be described by the hand-rolled
  // spec in `./openapi.ts` until their follow-up migrations land.
  const app = new OpenAPIHono<HonoCMSEnv>();
  app.use(logger());
  app.use(poweredBy({ serverName: "Hono CMS" }));
  app.use(requestId());

  app.use("*", async (context, next) => {
    const preflight = corsPreflightResponse(config.cors, context.req.raw);
    if (preflight) return preflight;
    await next();
    applyCorsHeaders(config.cors, context.req.raw, context.res);
  });

  app.all("/api/auth/*", async (context) => {
    const limited = await enforceRateLimit(cache, config, context.req.raw, "auth");
    if (limited) return limited;
    return auth.handleAuth?.(context.req.raw) ?? Response.json({ ok: true });
  });

  app.use("*", async (context, next) => {
    context.set("session", await auth.sessionFromRequest(context.req.raw));
    await next();
  });

  app.get("/cms/health/live", () => Response.json({ status: "ok", version: "0.1.0", uptime_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)) }));
  app.get("/cms/health", async () => healthResponse(startedAt, [
    { name: "db", check: () => db.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "storage", check: () => storage?.health?.() ?? Promise.resolve({ ok: true, message: "not configured" }) },
    { name: "media", check: () => mediaStore.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "cache", check: () => cache?.health?.() ?? Promise.resolve({ ok: true, message: "not configured" }) },
    { name: "jobs", check: () => jobs?.health?.() ?? Promise.resolve({ ok: true, message: "not configured" }) },
    { name: "audit", check: () => auditStore?.health?.() ?? Promise.resolve({ ok: true, message: "disabled" }) },
    { name: "organization", check: () => organizationStore.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "auth", check: () => auth.health?.() ?? Promise.resolve({ ok: true }) }
  ]));
  app.get("/cms/health/ready", async () => healthResponse(startedAt, [
    { name: "db", check: () => db.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "storage", check: () => storage?.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "media", check: () => mediaStore.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "cache", check: () => cache?.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "jobs", check: () => jobs?.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "audit", check: () => auditStore?.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "organization", check: () => organizationStore.health?.() ?? Promise.resolve({ ok: true }) },
    { name: "auth", check: () => auth.health?.() ?? Promise.resolve({ ok: true }) }
  ]));

  app.get("/cms/schema", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    return Response.json(schemaMetadata(config.collections));
  });

  app.get("/cms/rbac/matrix", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    return Response.json(buildRBACMatrix(config));
  });

  app.get("/cms/content-types/capabilities", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    return Response.json(contentTypeCapabilities(config));
  });

  app.get("/cms/content-types", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    return Response.json({
      ...schemaMetadata(config.collections),
      capabilities: contentTypeCapabilities(config)
    });
  });

  app.post("/cms/content-types", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const writer = config.contentTypeBuilder === false ? undefined : config.contentTypeBuilder?.writer;
    if (!writer) return Response.json({ error: "content_type_builder_read_only" }, { status: 403 });
    const body = await context.req.json().catch(() => null);
    const parsed = parseContentTypeInput(body);
    if (parsed instanceof Response) return parsed;
    if (config.collections[parsed.name]) return Response.json({ error: "collection_exists" }, { status: 409 });
    const validation = validateContentTypeChange(config.collections, parsed.collection);
    if (validation) return validation;
    const source = generateCollectionFile(parsed.collection, writer.importPath ? { importPath: writer.importPath } : {});
    const result = await writer.writeCollection({ collection: parsed.collection, source, mode: "create" });
    (config.collections as Record<string, typeof parsed.collection>)[parsed.name] = parsed.collection;
    // Gap-A runtime fix: install REST/GraphQL/OpenAPI routes for the new
    // collection so `GET /api/<new-name>` works without a server restart.
    try { (db as unknown as { ensureCollection?: (name: string) => void | Promise<void> }).ensureCollection?.(parsed.name); } catch { /* noop */ }
    registerCollectionRoutes(parsed.name);
    rebuildGraphQLHandler();
    refreshOpenAPISpec();
    await writeAuditEntry({
      store: auditStore,
      operation: "schema_change",
      collection: parsed.name,
      before: null,
      after: { mode: "create", name: parsed.name, options: parsed.collection.options, fields: parsed.collection.fields } as unknown as ContentRecord,
      session: context.get("session"),
      requestId: getRequestId(context.req.raw),
      config: auditConfig(config)
    });
    const afterWrite = await writer.afterWrite?.({ collection: parsed.collection, source, mode: "create", result });
    return Response.json(contentTypeWriteResponse(parsed.collection, source, result, afterWrite), { status: 201 });
  });

  app.put("/cms/content-types/:name", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const writer = config.contentTypeBuilder === false ? undefined : config.contentTypeBuilder?.writer;
    if (!writer) return Response.json({ error: "content_type_builder_read_only" }, { status: 403 });
    const currentName = context.req.param("name");
    if (!config.collections[currentName]) return Response.json({ error: "not_found" }, { status: 404 });
    const body = await context.req.json().catch(() => null);
    const parsed = parseContentTypeInput(body, currentName);
    if (parsed instanceof Response) return parsed;
    if (parsed.name !== currentName && config.collections[parsed.name]) return Response.json({ error: "collection_exists" }, { status: 409 });
    const validation = validateContentTypeChange(config.collections, parsed.collection, currentName);
    if (validation) return validation;
    const source = generateCollectionFile(parsed.collection, writer.importPath ? { importPath: writer.importPath } : {});
    const result = await writer.writeCollection({ collection: parsed.collection, source, mode: "update" });
    const mutableCollections = config.collections as Record<string, typeof parsed.collection>;
    const beforeCollection = mutableCollections[currentName];
    if (parsed.name !== currentName) {
      delete mutableCollections[currentName];
      collectionRouteState.delete(currentName);
    }
    mutableCollections[parsed.name] = parsed.collection;
    // Refresh per-collection validators + GraphQL schema + OpenAPI spec.
    try { (db as unknown as { ensureCollection?: (name: string) => void | Promise<void> }).ensureCollection?.(parsed.name); } catch { /* noop */ }
    registerCollectionRoutes(parsed.name);
    rebuildGraphQLHandler();
    refreshOpenAPISpec();
    await writeAuditEntry({
      store: auditStore,
      operation: "schema_change",
      collection: parsed.name,
      before: beforeCollection ? { mode: "update", name: currentName, options: beforeCollection.options, fields: beforeCollection.fields } as unknown as ContentRecord : null,
      after: { mode: "update", name: parsed.name, options: parsed.collection.options, fields: parsed.collection.fields } as unknown as ContentRecord,
      session: context.get("session"),
      requestId: getRequestId(context.req.raw),
      config: auditConfig(config)
    });
    const afterWrite = await writer.afterWrite?.({ collection: parsed.collection, source, mode: "update", result });
    return Response.json(contentTypeWriteResponse(parsed.collection, source, result, afterWrite));
  });

  app.delete("/cms/content-types/:name", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const writer = config.contentTypeBuilder === false ? undefined : config.contentTypeBuilder?.writer;
    if (!writer) return Response.json({ error: "content_type_builder_read_only" }, { status: 403 });
    // The writer must opt in to deletes by implementing `removeCollection`.
    // Without it we cannot guarantee the underlying file is removed, so we
    // refuse rather than silently mutating the in-memory schema only.
    if (!writer.removeCollection) {
      return Response.json({
        error: "content_type_remove_unsupported",
        message: "The configured schema writer does not implement removeCollection. Remove the collection from your schema source manually, or upgrade the writer."
      }, { status: 501 });
    }
    const currentName = context.req.param("name");
    const existing = config.collections[currentName];
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
    const result = await writer.removeCollection({ collection: existing });
    const mutableCollections = config.collections as Record<string, typeof existing>;
    delete mutableCollections[currentName];
    // Drop the collection from the live REST/GraphQL/OpenAPI surface. The
    // installed route handlers stay registered on the content sub-app (Hono
    // cannot un-register) but their `liveCollection()` guard now returns
    // null so they reply 404 — matching what callers expect post-delete.
    collectionRouteState.delete(currentName);
    rebuildGraphQLHandler();
    refreshOpenAPISpec();
    const deletedAt = new Date().toISOString();
    await writeAuditEntry({
      store: auditStore,
      operation: "schema_change",
      collection: currentName,
      before: { mode: "remove", name: currentName, options: existing.options, fields: existing.fields } as unknown as ContentRecord,
      after: null,
      session: context.get("session"),
      requestId: getRequestId(context.req.raw),
      config: auditConfig(config)
    });
    const afterRemove = await writer.afterRemove?.({ collection: existing, mode: "remove", result });
    return Response.json({
      collection: { name: currentName, deletedAt },
      ...result,
      ...(afterRemove ?? {})
    });
  });

  if (openAPI) {
    app.options(openAPI.specPath, (context) => new Response(null, { status: 200, headers: openAPIPreflightHeaders(openAPI, context.req.raw) }));
    app.get(openAPI.specPath, (context) => {
      const headers = openAPIHeaders(openAPI, context.req.raw);
      if (context.req.header("if-none-match") === openAPI.etag) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(openAPI.json, { headers });
    });
    if (openAPI.docsPath) {
      app.options(openAPI.docsPath, (context) => new Response(null, { status: 200, headers: openAPIPreflightHeaders(openAPI, context.req.raw) }));
      app.get(openAPI.docsPath, (context) => {
        const response = context.html(renderDocs(openAPI.specPath));
        applyOpenAPICorsHeaders(openAPI.cors, context.req.raw, response);
        return response;
      });
    }
  }
  // Bridge Hono's per-request session into the request-scoped GraphQL context.
  // Hoisted out of the `if (graphQL)` block so `registerCollection` can rebuild
  // the apollo handler later without rewiring routes.
  const graphQLSessionRef = new WeakMap<Request, AuthSession | null>();
  let graphQLApolloHandler: ((request: Request) => Promise<Response>) | null = null;
  const rebuildGraphQLHandler = (): void => {
    if (!graphQL) return;
    let graphQLSchema;
    try {
      graphQLSchema = buildGraphQLSchema(config.collections);
    } catch (error) {
      // Schema construction can fail when a freshly-registered collection
      // collides with system field names (e.g. `status` while
      // `draftAndPublish` is enabled). Keep the previous Apollo handler so
      // GraphQL traffic stays on the last-known-good schema and let REST
      // continue serving the new collection.
      console.warn("[hono-cms] GraphQL schema rebuild failed; keeping previous schema:", error instanceof Error ? error.message : error);
      if (graphQLApolloHandler) return;
      // No previous handler (first build at boot also failed). Re-throw so
      // the caller sees the actual schema error.
      throw error;
    }
    const buildGraphQLContext = (request: Request, session: AuthSession | null): CMSGraphQLContext => ({
      collections: config.collections,
      db,
      cache,
      session,
      jobs,
      request,
      introspection: graphQL.introspection,
      canRead: (collectionName: string) => canAccess(config, session, "read", collectionName),
      canAccess: (collectionName: string, action: "create" | "update" | "delete" | "publish") => canAccess(config, session, action, collectionName),
      publicStatus: (collectionName: string) => publicStatusFilter(config.collections[collectionName]?.options.draftAndPublish, session),
      auditStore,
      auditConfig: auditConfig(config),
      webhookStore,
      cacheOutcome: {},
      ...(config.contentCache !== undefined ? { contentCache: config.contentCache } : {}),
      ...(config.hooks ? { hooks: config.hooks } : {}),
      ...(config.webhooks ? { webhooks: config.webhooks } : {})
    });
    graphQLApolloHandler = createApolloHandler({
      schema: graphQLSchema,
      introspection: graphQL.introspection,
      collections: config.collections,
      context: (request) => buildGraphQLContext(request, graphQLSessionRef.get(request) ?? null)
    });
  };
  if (graphQL) {
    rebuildGraphQLHandler();

    for (const schemaPath of graphQL.schemaPaths) {
      // Resolve the SDL at request time so it reflects collections that were
      // registered after boot via `cms.registerCollection(...)`.
      app.get(schemaPath, () => new Response(createGraphQLSDL(config.collections), { headers: { "content-type": "text/plain; charset=utf-8" } }));
    }
    for (const path of graphQL.paths) {
      app.get(path, async (context) => {
        graphQLSessionRef.set(context.req.raw, context.get("session"));
        return graphQLApolloHandler!(context.req.raw);
      });
      app.post(path, async (context) => {
        graphQLSessionRef.set(context.req.raw, context.get("session"));
        if (await isGraphQLMutationRequest(context.req.raw)) {
          const limited = await enforceRateLimit(cache, config, context.req.raw, "graphql");
          if (limited) return limited;
        }
        return graphQLApolloHandler!(context.req.raw);
      });
    }
  }

  app.get("/cms/audit-log", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    if (!auditStore) return Response.json({ items: [] });
    const url = new URL(context.req.url);
    const parsed = parseAuditQuery(url);
    if (parsed.issues.length) return Response.json({ error: "validation_error", issues: parsed.issues }, { status: 422 });
    const query = parsed.query;
    const result = await auditStore.list(query);
    if (query.format === "csv") {
      return new Response(auditEntriesToCSV(result.items), { headers: { "content-type": "text/csv; charset=utf-8" } });
    }
    return Response.json(result);
  });

  app.get("/cms/settings/webhooks", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const webhooks = await webhookStore.listWebhooks();
    const deliveries = await webhookStore.listDeliveries({ limit: 200 });
    return Response.json({
      items: webhooks.map((webhook) => serializeWebhookListItem(webhook, deliveries.items.find((delivery) => delivery.webhookId === webhook.id))),
      meta: { total: webhooks.length }
    });
  });

  app.post("/cms/settings/webhooks", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const body = await context.req.json<{ name: string; url: string; secret?: string; events?: string[]; enabled?: boolean }>();
    const validation = validateWebhookInput(body);
    if (validation) return validation;
    const input: { name: string; url: string; secret?: string; events: string[]; enabled: boolean } = {
      name: body.name.trim(),
      url: body.url,
      events: body.events ?? ["*"],
      enabled: body.enabled ?? true
    };
    if (body.secret) input.secret = body.secret;
    const webhook = await webhookStore.createWebhook(input);
    return Response.json(webhook, { status: 201 });
  });

  app.patch("/cms/settings/webhooks/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    return updateManagedWebhook(webhookStore, context.req.param("id"), await context.req.json(), { partial: true });
  });

  app.put("/cms/settings/webhooks/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    return updateManagedWebhook(webhookStore, context.req.param("id"), await context.req.json(), { partial: false });
  });

  app.delete("/cms/settings/webhooks/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    await webhookStore.deleteWebhook(context.req.param("id"));
    return new Response(null, { status: 204 });
  });

  app.get("/cms/settings/webhooks/:id/deliveries", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const parsed = parseWebhookDeliveryListQuery(new URL(context.req.url), context.req.param("id"));
    if (parsed instanceof Response) return parsed;
    return Response.json(await webhookStore.listDeliveries(parsed));
  });

  app.get("/cms/settings/api-keys", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const records = apiKeyStore ? await apiKeyStore.list() : [];
    return Response.json({
      items: records.map(serializeApiKey),
      meta: { total: records.length }
    });
  });

  app.post("/cms/settings/api-keys", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    if (!apiKeyStore) return Response.json({ error: "api_key_store_not_configured" }, { status: 409 });
    const body = await context.req.json<Partial<Pick<ApiKeyRecord, "name" | "userId" | "roles" | "enabled">>>();
    const validation = validateApiKeyInput(body);
    if (validation) return validation;
    const secret = generateApiKeySecret();
    const createInput: Parameters<ApiKeyStore["create"]>[0] = {
      userId: body.userId!.trim(),
      roles: body.roles!.map((role) => role.trim()),
      enabled: body.enabled ?? true,
      hash: await hashApiKey(secret),
      prefix: apiKeyPrefix(secret)
    };
    if (body.name?.trim()) createInput.name = body.name.trim();
    const record = await apiKeyStore.create(createInput);
    return Response.json({ ...serializeApiKey(record), secret }, { status: 201 });
  });

  app.patch("/cms/settings/api-keys/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    if (!apiKeyStore) return Response.json({ error: "api_key_store_not_configured" }, { status: 409 });
    const body = await context.req.json<Partial<Pick<ApiKeyRecord, "name" | "roles" | "enabled">>>();
    const validation = validateApiKeyInput(body, { partial: true });
    if (validation) return validation;
    try {
      const record = await apiKeyStore.update(context.req.param("id"), {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.roles !== undefined ? { roles: body.roles.map((role) => role.trim()) } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {})
      });
      return Response.json(serializeApiKey(record));
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) return Response.json({ error: "not_found" }, { status: 404 });
      throw error;
    }
  });

  app.delete("/cms/settings/api-keys/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    if (!apiKeyStore) return Response.json({ error: "api_key_store_not_configured" }, { status: 409 });
    const deleted = await apiKeyStore.delete(context.req.param("id"));
    return deleted ? new Response(null, { status: 204 }) : Response.json({ error: "not_found" }, { status: 404 });
  });

  app.get("/cms/settings/organization", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    return Response.json(await organizationStore.getOrganization());
  });

  app.put("/cms/settings/organization", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const body = await context.req.json<Partial<OrganizationUpdateInput>>().catch(() => null);
    const validation = validateOrganizationInput(body);
    if (validation) return validation;
    return Response.json(await organizationStore.updateOrganization({
      name: body!.name!.trim(),
      slug: body!.slug!.trim(),
      ...(body!.plan?.trim() ? { plan: body!.plan.trim() } : {})
    }));
  });

  app.get("/cms/settings/organization/members", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const members = await organizationStore.listMembers();
    return Response.json({ items: members, meta: { total: members.length } });
  });

  app.patch("/cms/settings/organization/members/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const body = await context.req.json<{ role?: string; status?: OrganizationMemberStatus }>().catch(() => null);
    const validation = validateOrganizationMemberInput(body);
    if (validation) return validation;
    try {
      return Response.json(await organizationStore.updateMember(context.req.param("id"), {
        role: body!.role!.trim(),
        status: body!.status!
      }));
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) return Response.json({ error: "not_found" }, { status: 404 });
      throw error;
    }
  });

  app.delete("/cms/settings/organization/members/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const deleted = await organizationStore.removeMember(context.req.param("id"));
    return deleted ? new Response(null, { status: 204 }) : Response.json({ error: "not_found" }, { status: 404 });
  });

  app.get("/cms/settings/organization/invitations", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const invitations = await organizationStore.listInvitations();
    return Response.json({ items: invitations, meta: { total: invitations.length } });
  });

  app.post("/cms/settings/organization/invitations", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const body = await context.req.json<Partial<OrganizationInvitationInput>>().catch(() => null);
    const validation = validateOrganizationInvitationInput(body);
    if (validation) return validation;
    return Response.json(await organizationStore.createInvitation({
      email: body!.email!.trim(),
      role: body!.role!.trim()
    }), { status: 201 });
  });

  app.post("/cms/settings/organization/invitations/:id/revoke", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    try {
      return Response.json(await organizationStore.revokeInvitation(context.req.param("id")));
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) return Response.json({ error: "not_found" }, { status: 404 });
      throw error;
    }
  });

  app.post("/cms/settings/webhooks/:id/deliveries/:deliveryId/retry", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const webhook = (await webhookStore.listWebhooks()).find((item) => item.id === context.req.param("id"));
    if (!webhook) return Response.json({ error: "not_found" }, { status: 404 });
    const result = await retryFailedWebhookDelivery({
      store: webhookStore,
      webhook,
      deliveryId: context.req.param("deliveryId")
    });
    return result instanceof Response ? result : Response.json(result);
  });

  app.post("/api/preview-tokens", async (context) => {
    const session = context.get("session");
    if (!session?.roles.some((role) => role === "admin" || role === "editor")) return Response.json({ error: "forbidden" }, { status: 403 });
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    if (!cache) return Response.json({ error: "preview_cache_not_configured" }, { status: 503 });
    const body = await context.req.json<{ collection?: string; documentId?: string }>();
    if (!body.collection || !body.documentId) {
      return Response.json({ error: "validation_error", issues: [{ path: ["collection", "documentId"], message: "collection and documentId are required" }] }, { status: 422 });
    }
    const collection = config.collections[body.collection];
    if (!collection?.options.draftAndPublish) return Response.json({ error: "draft_publish_not_enabled" }, { status: 400 });
    const record = await db.get(body.collection, body.documentId);
    if (!record) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(await generatePreviewToken(cache, {
      collection: body.collection,
      documentId: body.documentId,
      previewUrlBase: config.preview?.url ?? "http://localhost:3000"
    }));
  });

  app.delete("/api/preview-tokens/:token", async (context) => {
    const session = context.get("session");
    if (!session?.roles.some((role) => role === "admin" || role === "editor")) return Response.json({ error: "forbidden" }, { status: 403 });
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    await revokePreviewToken(cache, context.req.param("token"));
    return new Response(null, { status: 204 });
  });

  app.post("/cms/admin/i18n/backfill", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    if (!config.i18n?.provider) return Response.json({ error: "translation_provider_not_configured" }, { status: 503 });
    if (!jobs?.enqueue) return Response.json({ error: "jobs_not_configured" }, { status: 503 });
    const body: { locale?: string; collection?: string } = await context.req.json().catch(() => ({}));
    const targets = resolveI18nBackfillTargets(config.collections, body);
    if (targets instanceof Response) return targets;

    let jobCount = 0;
    const collectionsBackfilled: Record<string, number> = {};
    for (const collectionName of targets.collections) {
      const records = await listAllRecords(db, collectionName);
      collectionsBackfilled[collectionName] = records.length;
      for (const record of records) {
        await translationStore.upsertVariant({
          collection: collectionName,
          documentId: record.id,
          locale: targets.locale,
          status: "pending",
          translatedBy: "pending",
          sourceUpdatedAt: record.updatedAt
        });
        await jobs.enqueue("/cms/jobs/translation", { collection: collectionName, documentId: record.id, targetLocale: targets.locale });
        jobCount += 1;
      }
    }

    return Response.json({ status: "enqueued", locale: targets.locale, collection: body.collection ?? null, jobCount, collections: collectionsBackfilled });
  });

  app.get("/cms/admin/i18n/backfill/status", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const url = new URL(context.req.url);
    const locale = url.searchParams.get("locale") ?? undefined;
    const collection = url.searchParams.get("collection") ?? undefined;
    const targetInput: { locale?: string; collection?: string } = {};
    if (locale) targetInput.locale = locale;
    if (collection) targetInput.collection = collection;
    const targets = resolveI18nBackfillTargets(config.collections, targetInput);
    if (targets instanceof Response) return targets;

    const collections = await Promise.all(targets.collections.map(async (collectionName) => {
      const records = await listAllRecords(db, collectionName);
      const variants = await Promise.all(records.map((record) => translationStore.getVariant(collectionName, record.id, targets.locale)));
      return {
        collection: collectionName,
        total: records.length,
        missing: variants.filter((variant) => !variant).length,
        pending: variants.filter((variant) => variant?.status === "pending").length,
        inProgress: variants.filter((variant) => variant?.status === "in_progress").length,
        complete: variants.filter((variant) => variant?.status === "complete").length,
        error: variants.filter((variant) => variant?.status === "error").length
      };
    }));
    const totals = collections.reduce((acc, item) => ({
      total: acc.total + item.total,
      missing: acc.missing + item.missing,
      pending: acc.pending + item.pending,
      inProgress: acc.inProgress + item.inProgress,
      complete: acc.complete + item.complete,
      error: acc.error + item.error
    }), { total: 0, missing: 0, pending: 0, inProgress: 0, complete: 0, error: 0 });
    return Response.json({ locale: targets.locale, collection: collection ?? null, totals, collections });
  });

  if (jobs) {
    const runScheduledPublish = async () => {
      const published = await publishDueScheduledContent(db, config.collections, cache);
      return { published: published.length };
    };
    const runAuditLogCleanup = async () => {
      const retentionDays = typeof config.auditLog === "object" ? config.auditLog.retentionDays ?? 90 : 90;
      const result = await auditLogCleanupJob({ store: auditStore, retentionDays });
      return { deleted: result.deletedCount };
    };
    const runCacheSweep = async () => await cache?.sweep?.() ?? { swept: 0 };
    const runWebhookRetry = async (payload: unknown) => {
      const body = isRecord(payload) ? payload as { deliveryId?: string } : {};
      if (!body.deliveryId) return new Response(JSON.stringify({ error: "validation_error", issues: [{ path: ["deliveryId"], message: "deliveryId is required" }] }), {
        status: 422,
        headers: { "content-type": "application/json" }
      });
      return await retryWebhookDelivery({ store: webhookStore, jobs, deliveryId: body.deliveryId });
    };
    // Plan-15 U4 (Gap-B/J follow-up): on Vercel-cron-only and Cloudflare-no-queue
    // deployments, jobs.enqueue() throws JobsConfigError so on-demand
    // webhook-retry jobs cannot be scheduled. dispatchWebhooks() persists the
    // delivery row with status="retrying" + nextAttemptAt regardless of jobs
    // availability; this sweeper drives retries on those deployments via a
    // 1-minute cron, and is also safe to run on QStash/Queue topologies (it's
    // a no-op when no row is overdue).
    const runWebhookRetrySweepJob = async () => await runWebhookRetrySweep({
      store: webhookStore,
      ...(config.webhooks ? { staticTargets: config.webhooks } : {})
    });
    const runWebhookDeliveryCleanup = async () => {
      const retentionDays = typeof config.webhookDeliveryRetentionDays === "number" ? config.webhookDeliveryRetentionDays : 30;
      const result = await webhookDeliveryCleanupJob({ store: webhookStore, retentionDays });
      return { deleted: result.deletedCount };
    };
    const runTranslation = async (payload: unknown) => {
      if (!config.i18n?.provider) return Response.json({ error: "translation_provider_not_configured" }, { status: 503 });
      const body = isRecord(payload) ? payload as { collection?: string; documentId?: string; targetLocale?: string; sourceLocale?: string } : {};
      if (!body.collection || !body.documentId || !body.targetLocale) {
        return Response.json({ error: "validation_error", issues: [{ path: ["collection", "documentId", "targetLocale"], message: "collection, documentId, and targetLocale are required" }] }, { status: 422 });
      }
      return await translateDocument({
        collections: config.collections,
        db,
        store: translationStore,
        provider: config.i18n.provider,
        collectionName: body.collection as keyof Collections & string,
        documentId: body.documentId,
        targetLocale: body.targetLocale,
        ...(body.sourceLocale ? { sourceLocale: body.sourceLocale } : {})
      });
    };

    registerJob(jobs, "scheduled-publish", runScheduledPublish);
    registerJob(jobs, "audit-log-cleanup", runAuditLogCleanup);
    registerJob(jobs, "cache-sweep", runCacheSweep);
    registerJob(jobs, "webhook-retry", runWebhookRetry);
    registerJob(jobs, "webhook-retry-sweep", runWebhookRetrySweepJob);
    registerJob(jobs, "webhook-delivery-cleanup", runWebhookDeliveryCleanup);
    registerJob(jobs, "translation", runTranslation);
    registerJob(jobs, "scheduled", async () => {
      await runScheduledPublish();
      await runAuditLogCleanup();
      await runCacheSweep();
      await runWebhookRetrySweepJob();
    });

    const runScheduledPublishJob = async (request: Request) => runVerifiedJob(jobs, request, runScheduledPublish);
    app.get("/cms/jobs/scheduled-publish", async (context) => runScheduledPublishJob(context.req.raw));
    app.post("/cms/jobs/scheduled-publish", async (context) => runScheduledPublishJob(context.req.raw));

    const runAuditLogCleanupJob = async (request: Request) => runVerifiedJob(jobs, request, runAuditLogCleanup);
    app.get("/cms/jobs/audit-log-cleanup", async (context) => runAuditLogCleanupJob(context.req.raw));
    app.post("/cms/jobs/audit-log-cleanup", async (context) => runAuditLogCleanupJob(context.req.raw));

    const runCacheSweepJob = async (request: Request) => runVerifiedJob(jobs, request, runCacheSweep);
    app.get("/cms/jobs/cache-sweep", async (context) => runCacheSweepJob(context.req.raw));
    app.post("/cms/jobs/cache-sweep", async (context) => runCacheSweepJob(context.req.raw));

    app.post("/cms/jobs/webhook-retry", async (context) => runVerifiedJob(jobs, context.req.raw, async () => runWebhookRetry(await context.req.json().catch(() => ({})))));

    const runWebhookRetrySweepEndpoint = async (request: Request) => runVerifiedJob(jobs, request, runWebhookRetrySweepJob);
    app.get("/cms/jobs/webhook-retry-sweep", async (context) => runWebhookRetrySweepEndpoint(context.req.raw));
    app.post("/cms/jobs/webhook-retry-sweep", async (context) => runWebhookRetrySweepEndpoint(context.req.raw));

    const runWebhookDeliveryCleanupEndpoint = async (request: Request) => runVerifiedJob(jobs, request, runWebhookDeliveryCleanup);
    app.get("/cms/jobs/webhook-delivery-cleanup", async (context) => runWebhookDeliveryCleanupEndpoint(context.req.raw));
    app.post("/cms/jobs/webhook-delivery-cleanup", async (context) => runWebhookDeliveryCleanupEndpoint(context.req.raw));

    app.post("/cms/jobs/translation", async (context) => runVerifiedJob(jobs, context.req.raw, async () => runTranslation(await context.req.json().catch(() => ({})))));
  }

  app.post("/cms/settings/webhooks/:id/test", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "admin");
    if (limited) return limited;
    const webhook = (await webhookStore.listWebhooks()).find((item) => item.id === context.req.param("id"));
    if (!webhook) return Response.json({ error: "not_found" }, { status: 404 });
    const delivery = await deliverWebhookTest(webhook, {
      type: "cms.test",
      timestamp: new Date().toISOString(),
      requestId: context.req.header("x-request-id") ?? crypto.randomUUID()
    }, 10_000);
    await webhookStore.appendDelivery(delivery);
    return Response.json(delivery);
  });

  app.get("/api/media/folders", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const folderStore = mediaStore.folders;
    if (!folderStore) return Response.json({ items: [] });
    const items = await folderStore.list();
    return Response.json({ items });
  });

  app.post("/api/media/folders", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const folderStore = mediaStore.folders;
    if (!folderStore) return Response.json({ error: "folders_not_supported" }, { status: 501 });
    const body = await context.req.json<{ name?: string; parentId?: string | null }>().catch(() => ({} as { name?: string; parentId?: string | null }));
    if (!body.name || !body.name.trim()) {
      return Response.json({ error: "validation_error", issues: [{ path: ["name"], message: "name is required" }] }, { status: 422 });
    }
    try {
      const folder = await folderStore.create({ name: body.name, parentId: body.parentId ?? null });
      return Response.json(folder, { status: 201 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "folder_create_failed" }, { status: 400 });
    }
  });

  app.patch("/api/media/folders/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const folderStore = mediaStore.folders;
    if (!folderStore) return Response.json({ error: "folders_not_supported" }, { status: 501 });
    const id = context.req.param("id");
    const body = await context.req.json<{ name?: string; parentId?: string | null }>().catch(() => ({} as { name?: string; parentId?: string | null }));
    const patch: { name?: string; parentId?: string | null } = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.parentId !== undefined) patch.parentId = body.parentId;
    try {
      const updated = await folderStore.update(id, patch);
      if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(updated);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "folder_update_failed" }, { status: 400 });
    }
  });

  app.delete("/api/media/folders/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const folderStore = mediaStore.folders;
    if (!folderStore) return Response.json({ error: "folders_not_supported" }, { status: 501 });
    const id = context.req.param("id");
    const force = new URL(context.req.url).searchParams.get("force") === "true";
    const result = await folderStore.delete(id, { force });
    if (!result.ok) {
      if (result.reason === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ error: "folder_not_empty" }, { status: 409 });
    }
    return new Response(null, { status: 204 });
  });

  app.get("/api/media", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const url = new URL(context.req.url);
    const query = parseMediaListQuery(url);
    if (query instanceof Response) return query;
    return Response.json(await mediaStore.list(query));
  });

  app.post("/api/media", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "media");
    if (limited) return limited;
    if (!storage) return Response.json({ error: "storage_not_configured" }, { status: 503 });
    const requestId = getRequestId(context.req.raw);
    const folderIdParam = new URL(context.req.url).searchParams.get("folderId");
    const folderId = folderIdParam && folderIdParam !== "null" && folderIdParam !== "" ? folderIdParam : null;
    if (folderId && mediaStore.folders && !(await mediaStore.folders.get(folderId))) {
      return Response.json({ error: "folder_not_found" }, { status: 404 });
    }
    try {
      const uploaded = await uploadMediaObject(storage, context.req.raw, mediaSecurityOptions(config));
      const record = await mediaStore.create({ ...uploaded, folderId });
      await writeAuditEntry({ store: auditStore, operation: "media_upload", collection: "media", before: null, after: record, session: context.get("session"), requestId, config: auditConfig(config) });
      return Response.json(record, { status: 201 });
    } catch (error) {
      return Response.json({ error: "upload_failed", message: error instanceof Error ? error.message : "upload failed" }, { status: 400 });
    }
  });

  app.post("/api/media/presign", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "media");
    if (limited) return limited;
    if (!storage) return Response.json({ error: "storage_not_configured" }, { status: 503 });
    try {
      const body = await context.req.json<{ filename?: string; contentType?: string; mimeType?: string; size?: number }>();
      const presignOptions: { expiresInSeconds?: number; maxSizeBytes?: number; allowActiveContent?: boolean } = {};
      if (config.media?.presignExpirySeconds !== undefined) presignOptions.expiresInSeconds = config.media.presignExpirySeconds;
      if (config.media?.maxPresignUploadSizeBytes !== undefined) presignOptions.maxSizeBytes = config.media.maxPresignUploadSizeBytes;
      if (config.media?.allowActiveContent === true) presignOptions.allowActiveContent = true;
      const presign = await createMediaPresign(storage, {
        filename: body.filename ?? "",
        contentType: body.contentType ?? body.mimeType ?? "",
        size: Number(body.size)
      }, presignOptions);
      await mediaPresigns.set({
        uploadId: presign.uploadId,
        key: presign.key,
        filename: presign.filename,
        contentType: presign.contentType,
        size: presign.size,
        expiresAt: presign.expiresAt
      }, config.media?.presignExpirySeconds ?? 3600);
      return Response.json(presign);
    } catch (error) {
      return Response.json({ error: "presign_failed", message: error instanceof Error ? error.message : "presign failed" }, { status: 400 });
    }
  });

  app.post("/api/media/confirm", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "media");
    if (limited) return limited;
    if (!storage) return Response.json({ error: "storage_not_configured" }, { status: 503 });
    const requestId = getRequestId(context.req.raw);
    const body = await context.req.json<{ uploadId?: string; key?: string; filename?: string; contentType?: string; mimeType?: string; size?: number; metadata?: Record<string, string>; folderId?: string | null }>();
    if (!body.uploadId) return Response.json({ error: "validation_error", issues: [{ path: ["uploadId"], message: "uploadId is required" }] }, { status: 422 });
    const session = await mediaPresigns.get(body.uploadId);
    if (!session) return Response.json({ error: "presign_session_not_found" }, { status: 400 });
    if (body.folderId && mediaStore.folders && !(await mediaStore.folders.get(body.folderId))) {
      return Response.json({ error: "folder_not_found" }, { status: 404 });
    }
    try {
      const confirmInput: { uploadId: string; key: string; filename: string; contentType: string; size: number; metadata?: Record<string, string>; folderId?: string | null } = {
        uploadId: body.uploadId,
        key: body.key ?? "",
        filename: body.filename ?? "",
        contentType: body.contentType ?? body.mimeType ?? "",
        size: Number(body.size)
      };
      if (body.metadata) confirmInput.metadata = body.metadata;
      if (body.folderId !== undefined) confirmInput.folderId = body.folderId;
      const confirmed = await confirmMediaUpload(mediaStore, storage, session, confirmInput);
      await mediaPresigns.delete(body.uploadId);
      await writeAuditEntry({ store: auditStore, operation: "media_upload", collection: "media", before: null, after: confirmed, session: context.get("session"), requestId, config: auditConfig(config) });
      return Response.json(confirmed, { status: 201 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "confirm_failed" }, { status: 400 });
    }
  });

  app.get("/api/media/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const record = await mediaStore.get(context.req.param("id"));
    return record ? Response.json(record) : Response.json({ error: "not_found" }, { status: 404 });
  });

  app.get("/api/media/:id/file", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    if (!storage) return Response.json({ error: "storage_not_configured" }, { status: 503 });
    const record = await mediaStore.get(context.req.param("id"));
    if (!record) return Response.json({ error: "not_found" }, { status: 404 });
    return await storage.get(record.key) ?? Response.json({ error: "not_found" }, { status: 404 });
  });

  app.patch("/api/media/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    if (!mediaStore.update) return Response.json({ error: "media_update_not_supported" }, { status: 501 });
    const id = context.req.param("id");
    const body = await context.req.json<{ folderId?: string | null; filename?: string; metadata?: Record<string, string> }>().catch(() => ({} as { folderId?: string | null; filename?: string; metadata?: Record<string, string> }));
    const patch: Partial<Pick<MediaRecord, "folderId" | "filename" | "metadata">> = {};
    if (body.folderId !== undefined) {
      const folderStore = mediaStore.folders;
      if (body.folderId !== null && folderStore && !(await folderStore.get(body.folderId))) {
        return Response.json({ error: "folder_not_found" }, { status: 404 });
      }
      patch.folderId = body.folderId;
    }
    if (body.filename !== undefined) patch.filename = body.filename;
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    const updated = await mediaStore.update(id, patch);
    if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(updated);
  });

  app.delete("/api/media/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const limited = await enforceRateLimit(cache, config, context.req.raw, "media");
    if (limited) return limited;
    const mediaId = context.req.param("id");
    const references = await findMediaReferences(db, config.collections, mediaId);
    if (references.length) {
      return Response.json({ error: "media_in_use", references }, { status: 409 });
    }
    const requestId = getRequestId(context.req.raw);
    const record = await mediaStore.delete(mediaId);
    if (!record) return new Response(null, { status: 204 });
    await storage?.delete(record.key);
    await writeAuditEntry({ store: auditStore, operation: "media_delete", collection: "media", before: record, after: null, session: context.get("session"), requestId, config: auditConfig(config) });
    return new Response(null, { status: 204 });
  });

  // Hot-registration plumbing (Gap-A runtime fix): content-collection routes
  // are registered on a dedicated sub-app backed by a `TrieRouter`, which
  // accepts late `.add()` calls. The main `app` uses Hono's default
  // `SmartRouter` which bakes its matcher on first request and therefore
  // cannot accept new routes at runtime.
  //
  // The main app reaches the sub-app via a single catch-all `app.all('/api/*',
  // dispatcher)` registered after all explicit `/api/media`, `/api/preview-tokens`,
  // and `/api/auth/*` routes. Hono's RegExpRouter prefers the most specific
  // match, so the catch-all only fires for content-collection paths.
  const contentApp = new Hono<HonoCMSEnv>({ router: new TrieRouter() });
  // Re-resolve the auth session inside the sub-app so handlers can call
  // `context.get("session")` exactly like the main-app handlers do. This is
  // idempotent — the main app already resolves the session once per request,
  // and `auth.sessionFromRequest` is a cheap pure-token lookup in the
  // built-in adapters.
  contentApp.use("*", async (context, next) => {
    context.set("session", await auth.sessionFromRequest(context.req.raw));
    await next();
  });

  type CollectionRouteDeps = {
    validator: ReturnType<typeof collectionToZod>;
  };
  const collectionRouteState = new Map<string, CollectionRouteDeps>();
  // Track which collections currently have routes registered on `contentApp`.
  // TrieRouter cannot un-register routes, so unregister is implemented by
  // having the route handlers short-circuit when the collection is no longer
  // in `config.collections`. We keep this set to avoid re-adding routes when
  // a collection is re-registered after deletion (the existing handler closure
  // already reads the live `config.collections[name]` each request).
  const registeredCollections = new Set<string>();

  function registerCollectionRoutes(collectionName: string): void {
    if (registeredCollections.has(collectionName)) {
      // Route handlers already exist; they will read the (possibly updated)
      // collection definition from `config.collections` at request time.
      const collection = config.collections[collectionName];
      if (collection) {
        const schemaComponents = getSchemaComponents(config.collections);
        collectionRouteState.set(collectionName, {
          validator: collectionToZod(collection, schemaComponents)
        });
      }
      return;
    }
    const collection = config.collections[collectionName];
    if (!collection) throw new Error(`Cannot register routes for unknown collection "${collectionName}"`);
    const schemaComponents = getSchemaComponents(config.collections);
    collectionRouteState.set(collectionName, {
      validator: collectionToZod(collection, schemaComponents)
    });
    registeredCollections.add(collectionName);

    const base = `/api/${collectionName}`;
    // Plan-12 U1: build OpenAPI route declarations for the seven core CRUD
    // operations. We register their RouteConfig on the main app's OpenAPI
    // registry so the served spec describes the collection. The actual
    // handlers live on `contentApp` (TrieRouter) so they can be wired up
    // after the matcher has been built.
    const routeConfigs = buildCollectionRouteConfigs(collectionName, collection);
    const registerSpec = (route: RouteConfig): void => {
      try {
        app.openAPIRegistry.registerPath(route);
      } catch {
        // Duplicate registrations or invalid schemas should not break route
        // wiring; the served spec stays on the last successful build.
      }
    };

    // Helper that resolves the live collection definition. If a collection was
    // unregistered we 404 here instead of touching `db`/cache with a stale
    // identifier (the in-memory adapter throws on unknown collections).
    const liveCollection = (): typeof collection | null => {
      const current = config.collections[collectionName];
      return current ?? null;
    };

    registerSpec(routeConfigs.list);
    contentApp.get(`${base}`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "read", collectionName);
      if (denied) return denied;
      const session = context.get("session");
      const localeError = localeValidationError(liveColl, new URL(context.req.url).searchParams.get("locale"));
      if (localeError) return localeError;
      const publicStatus = publicStatusFilter(liveColl.options.draftAndPublish, session);
      let parsedQuery;
      try {
        parsedQuery = parseQueryParams(new URL(context.req.url));
      } catch (error) {
        if (error instanceof InvalidCursorError) return validationErrorResponse([{ path: ["pagination", "cursor"], message: "Invalid cursor" }]);
        throw error;
      }
      const queryIssues = validateQueryParams(config.collections, collectionName, parsedQuery);
      if (queryIssues.length) return validationErrorResponse(queryIssues);
      const query = { ...parsedQuery, ...publicStatus };
      const ttl = session ? null : contentCacheTtl(config.contentCache);
      const cacheSource = normalizedRequestCacheSource(context.req.raw);
      const cached = ttl === null ? null : await readContentCache(cache, collectionName, cacheSource, context.req.header("if-none-match") ?? null);
      if (cached) return cached;
      const { directFilters, relationFilters } = splitRelationFilters(config.collections, collectionName, query.filters);
      const result = relationFilters.length
        ? await listWithRelationFilters(db, config.collections, collectionName, liveColl, { ...query, filters: directFilters }, relationFilters)
        : await listWithLocaleFallback((nextQuery) => db.list(collectionName, nextQuery), liveColl, query);
      const localizedItems = await overlayLocaleVariants(translationStore, liveColl, result.items, query.locale, query.fallback !== false);
      const items = await populateRecords(db, config.collections, collectionName, localizedItems, query.populate, { ...publicStatus, session });
      return await writeContentCache(cache, collectionName, cacheSource, publicListResult({ ...result, items: projectRecords(liveColl, items, query.fields, session) }), ttl);
    });

    registerSpec(routeConfigs.create);
    contentApp.post(`${base}`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "create", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      const locale = localeFromRequest(liveColl, new URL(context.req.url));
      const localeError = localeValidationError(liveColl, locale);
      if (localeError) return localeError;
      const requestId = getRequestId(context.req.raw);
      const body = normalizeRelationInputAliases(liveColl, await context.req.json<Record<string, unknown>>());
      const forbiddenFields = forbiddenWriteFields(liveColl, body, context.get("session"));
      if (forbiddenFields.length) return forbiddenFieldResponse(forbiddenFields);
      const validator = collectionRouteState.get(collectionName)?.validator;
      if (!validator) return Response.json({ error: "not_found" }, { status: 404 });
      const parsed = validator.safeParse(body);
      if (!parsed.success) return Response.json({ error: "validation_error", issues: parsed.error.issues }, { status: 422 });
      const input = await runHooks(config.hooks?.beforeCreate, withDefaultLocale(liveColl, parsed.data, locale), { collection: collectionName, session: context.get("session"), request: context.req.raw });
      const record = await db.create(collectionName, normalizeDraftInput(liveColl.options.draftAndPublish, input));
      await runHooks(config.hooks?.afterCreate, record, { collection: collectionName, id: record.id, session: context.get("session"), request: context.req.raw });
      await enqueueTranslationJobs(jobs, liveColl, record, translationJobOptions(config));
      await invalidateContentCache(cache, collectionName);
      await writeAuditEntry({ store: auditStore, operation: "create", collection: collectionName, before: null, after: record, session: context.get("session"), requestId, config: auditConfig(config) });
      await emitMutationEvent(config, webhookStore, jobs, { type: "content.created", collection: collectionName, record, previous: null, timestamp: new Date().toISOString(), requestId });
      return Response.json(projectRecord(liveColl, record, undefined, context.get("session")), { status: 201 });
    });

    registerSpec(routeConfigs.get);
    contentApp.get(`${base}/:id`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "read", collectionName);
      if (denied) return denied;
      const session = context.get("session");
      const localeError = localeValidationError(liveColl, new URL(context.req.url).searchParams.get("locale"));
      if (localeError) return localeError;
      const publicStatus = publicStatusFilter(liveColl.options.draftAndPublish, session);
      const query = parseQueryParams(new URL(context.req.url));
      const queryIssues = validateQueryParams(config.collections, collectionName, query);
      if (queryIssues.length) return validationErrorResponse(queryIssues);
      const preview = await verifyPreviewToken(cache, new URL(context.req.url).searchParams.get("preview"));
      const ttl = session || preview ? null : contentCacheTtl(config.contentCache);
      const cacheSource = normalizedRequestCacheSource(context.req.raw);
      const cached = ttl === null ? null : await readContentCache(cache, collectionName, cacheSource, context.req.header("if-none-match") ?? null);
      if (cached) return cached;
      const getQuery: { populate?: typeof query.populate; fields?: typeof query.fields } = {};
      if (query.populate) getQuery.populate = query.populate;
      if (query.fields) getQuery.fields = query.fields;
      const record = await db.get(collectionName, context.req.param("id"), getQuery);
      if (!record) return Response.json({ error: "not_found" }, { status: 404 });
      const hasPreviewAccess = preview?.collection === collectionName && preview.documentId === record.id;
      if (!hasPreviewAccess && publicStatus.status === "published" && record.status !== "published") return Response.json({ error: "not_found" }, { status: 404 });
      const localeVariant = await getLocaleVariantWithFallback(translationStore, liveColl, record.id, query.locale, query.fallback !== false);
      if (liveColl.options.i18n && query.locale && query.locale !== liveColl.options.i18n.defaultLocale && query.fallback === false && !localeVariant && record.locale !== query.locale) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const localizedRecord = overlayLocaleVariant(record, localeVariant);
      const [populated] = await populateRecords(db, config.collections, collectionName, [localizedRecord], query.populate, { ...publicStatus, session });
      return await writeContentCache(cache, collectionName, cacheSource, projectRecord(liveColl, populated ?? record, query.fields, session), ttl);
    });

    contentApp.get(`${base}/:id/locales`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "read", collectionName);
      if (denied) return denied;
      if (!liveColl.options.i18n) return Response.json({ error: "i18n_not_enabled" }, { status: 400 });
      const record = await db.get(collectionName, context.req.param("id"));
      if (!record) return Response.json({ error: "not_found" }, { status: 404 });
      const variants = await translationStore.listVariants(collectionName, record.id);
      return Response.json({
        defaultLocale: liveColl.options.i18n.defaultLocale,
        locales: liveColl.options.i18n.locales.map((locale) => {
          const variant = variants.find((item) => item.locale === locale);
          return {
            locale,
            status: locale === liveColl.options.i18n?.defaultLocale ? "complete" : variant?.status ?? "missing",
            translatedBy: locale === liveColl.options.i18n?.defaultLocale ? "human" : variant?.translatedBy ?? "pending",
            translatedAt: variant?.translatedAt,
            error: variant?.error
          };
        })
      });
    });

    contentApp.post(`${base}/:id/translate`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "update", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      if (!config.i18n?.provider) return Response.json({ error: "translation_provider_not_configured" }, { status: 503 });
      const body: { targetLocale?: string; sourceLocale?: string } = await context.req.json().catch(() => ({}));
      if (!body.targetLocale) return Response.json({ error: "validation_error", issues: [{ path: ["targetLocale"], message: "targetLocale is required" }] }, { status: 422 });
      const result = await translateDocument({
        collections: config.collections,
        db,
        store: translationStore,
        provider: config.i18n.provider,
        collectionName,
        documentId: context.req.param("id"),
        targetLocale: body.targetLocale,
        ...(body.sourceLocale ? { sourceLocale: body.sourceLocale } : {})
      });
      if (result instanceof Response) return result;
      await invalidateContentCache(cache, collectionName);
      return Response.json(result);
    });

    contentApp.patch(`${base}/:id/locales/:locale`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "update", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      if (!liveColl.options.i18n) return Response.json({ error: "i18n_not_enabled" }, { status: 400 });
      const locale = context.req.param("locale");
      const localeError = localeMutationError(liveColl, locale);
      if (localeError) return localeError;
      const body: { translatedBy?: unknown } = await context.req.json().catch(() => ({}));
      if (body.translatedBy !== "human") {
        return Response.json({ error: "validation_error", issues: [{ path: ["translatedBy"], message: "translatedBy must be 'human'." }] }, { status: 422 });
      }
      const record = await db.get(collectionName, context.req.param("id"));
      if (!record) return Response.json({ error: "not_found" }, { status: 404 });
      const existing = await translationStore.getVariant(collectionName, record.id, locale);
      if (!existing) return Response.json({ error: "locale_variant_not_found" }, { status: 404 });
      const variant = await translationStore.upsertVariant({
        collection: collectionName,
        documentId: record.id,
        locale,
        fields: existing.fields,
        status: existing.status,
        translatedBy: "human",
        sourceUpdatedAt: existing.sourceUpdatedAt ?? record.updatedAt,
        translatedAt: existing.translatedAt ?? new Date().toISOString(),
        ...(existing.provider ? { provider: existing.provider } : {}),
        ...(existing.error ? { error: existing.error } : {})
      });
      await invalidateContentCache(cache, collectionName);
      return Response.json(variant);
    });

    contentApp.put(`${base}/:id/locales/:locale`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "update", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      if (!liveColl.options.i18n) return Response.json({ error: "i18n_not_enabled" }, { status: 400 });
      const locale = context.req.param("locale");
      const localeError = localeMutationError(liveColl, locale);
      if (localeError) return localeError;
      const record = await db.get(collectionName, context.req.param("id"));
      if (!record) return Response.json({ error: "not_found" }, { status: 404 });
      const body = await context.req.json<Record<string, unknown>>().catch(() => ({}));
      const fields = writableLocaleFields(liveColl, body);
      if (Object.keys(fields).length === 0) {
        return Response.json({ error: "validation_error", issues: [{ path: ["fields"], message: "At least one localizable field is required." }] }, { status: 422 });
      }
      const variant = await translationStore.upsertVariant({
        collection: collectionName,
        documentId: record.id,
        locale,
        fields,
        status: "complete",
        translatedBy: "human",
        sourceUpdatedAt: record.updatedAt,
        translatedAt: new Date().toISOString()
      });
      await invalidateContentCache(cache, collectionName);
      return Response.json(variant);
    });

    registerSpec(routeConfigs.update);
    contentApp.patch(`${base}/:id`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "update", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      const requestId = getRequestId(context.req.raw);
      const before = await db.get(collectionName, context.req.param("id"));
      const body = normalizeRelationInputAliases(liveColl, stripSystemDraftFields(await context.req.json<Record<string, unknown>>()));
      const forbiddenFields = forbiddenWriteFields(liveColl, body, context.get("session"));
      if (forbiddenFields.length) return forbiddenFieldResponse(forbiddenFields);
      const input = await runHooks(config.hooks?.beforeUpdate, body, { collection: collectionName, id: context.req.param("id"), session: context.get("session"), request: context.req.raw });
      const record = await db.update(collectionName, context.req.param("id"), input);
      await runHooks(config.hooks?.afterUpdate, record, { collection: collectionName, id: record.id, session: context.get("session"), request: context.req.raw });
      await enqueueTranslationJobs(jobs, liveColl, record, translationJobOptions(config));
      await invalidateContentCache(cache, collectionName);
      await writeAuditEntry({ store: auditStore, operation: "update", collection: collectionName, before, after: record, session: context.get("session"), requestId, config: auditConfig(config) });
      await emitMutationEvent(config, webhookStore, jobs, { type: "content.updated", collection: collectionName, record, previous: before, timestamp: new Date().toISOString(), requestId });
      return Response.json(projectRecord(liveColl, record, undefined, context.get("session")));
    });

    // Publish/unpublish/schedule routes are always registered, but guarded by
    // the live collection's `draftAndPublish` flag so a collection that gains
    // the flag via a future PUT immediately picks up the routes.
    if (routeConfigs.publish) registerSpec(routeConfigs.publish);
    if (routeConfigs.unpublish) registerSpec(routeConfigs.unpublish);
    contentApp.post(`${base}/:id/publish`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      if (!liveColl.options.draftAndPublish) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "publish", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      const requestId = getRequestId(context.req.raw);
      const before = await db.get(collectionName, context.req.param("id"));
      const record = await publishDocument(db, collectionName, context.req.param("id"));
      await enqueueTranslationJobs(jobs, liveColl, record, translationJobOptions(config));
      await invalidateContentCache(cache, collectionName);
      await writeAuditEntry({ store: auditStore, operation: "publish", collection: collectionName, before, after: record, session: context.get("session"), requestId, config: auditConfig(config) });
      await emitMutationEvent(config, webhookStore, jobs, { type: "content.published", collection: collectionName, record, previous: before, timestamp: new Date().toISOString(), requestId });
      return Response.json(projectRecord(liveColl, record, undefined, context.get("session")));
    });

    contentApp.post(`${base}/:id/unpublish`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      if (!liveColl.options.draftAndPublish) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "publish", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      const requestId = getRequestId(context.req.raw);
      const before = await db.get(collectionName, context.req.param("id"));
      const record = await unpublishDocument(db, collectionName, context.req.param("id"));
      await invalidateContentCache(cache, collectionName);
      await writeAuditEntry({ store: auditStore, operation: "unpublish", collection: collectionName, before, after: record, session: context.get("session"), requestId, config: auditConfig(config) });
      await emitMutationEvent(config, webhookStore, jobs, { type: "content.unpublished", collection: collectionName, record, previous: before, timestamp: new Date().toISOString(), requestId });
      return Response.json(projectRecord(liveColl, record, undefined, context.get("session")));
    });

    contentApp.post(`${base}/:id/schedule`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      if (!liveColl.options.draftAndPublish) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "publish", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      const { publishAt } = await context.req.json<{ publishAt?: string }>();
      if (!publishAt) return Response.json({ error: "validation_error", issues: [{ path: ["publishAt"], message: "publishAt is required" }] }, { status: 422 });
      const record = await schedulePublish(db, collectionName, context.req.param("id"), new Date(publishAt));
      await invalidateContentCache(cache, collectionName);
      return Response.json(projectRecord(liveColl, record, undefined, context.get("session")));
    });

    contentApp.post(`${base}/:id/unschedule`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      if (!liveColl.options.draftAndPublish) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "publish", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      const record = await unschedulePublish(db, collectionName, context.req.param("id"));
      await invalidateContentCache(cache, collectionName);
      return Response.json(projectRecord(liveColl, record, undefined, context.get("session")));
    });

    registerSpec(routeConfigs.delete);
    contentApp.delete(`${base}/:id`, async (context) => {
      const liveColl = liveCollection();
      if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
      const denied = requireAccess(config, context.get("session"), "delete", collectionName);
      if (denied) return denied;
      const limited = await enforceMutationRateLimit(cache, config, context.req.raw);
      if (limited) return limited;
      const requestId = getRequestId(context.req.raw);
      const existing = await db.get(collectionName, context.req.param("id"));
      if (!existing) return new Response(null, { status: 204 });
      await runHooks(config.hooks?.beforeDelete, existing, { collection: collectionName, id: context.req.param("id"), session: context.get("session"), request: context.req.raw });
      const relationDelete = await deleteWithRelationPolicy(db, config.collections, collectionName, context.req.param("id")).catch((error: unknown) => {
        if (error instanceof RelationConstraintError) return relationConstraintResponse(error);
        throw error;
      });
      if (relationDelete instanceof Response) return relationDelete;
      await runHooks(config.hooks?.afterDelete, existing ?? {}, { collection: collectionName, id: context.req.param("id"), session: context.get("session"), request: context.req.raw });
      if (existing) {
        for (const affectedCollection of relationDelete.affectedCollections) await invalidateContentCache(cache, affectedCollection);
        await writeAuditEntry({ store: auditStore, operation: "delete", collection: collectionName, before: existing, after: null, session: context.get("session"), requestId, config: auditConfig(config) });
        await emitMutationEvent(config, webhookStore, jobs, { type: "content.deleted", collection: collectionName, record: existing, previous: existing, timestamp: new Date().toISOString(), requestId });
      }
      return new Response(null, { status: 204 });
    });
  }

  // Boot-time registration: wire up every collection currently in the config.
  for (const collectionName of Object.keys(config.collections)) {
    registerCollectionRoutes(collectionName);
  }

  // Mount the content sub-app behind a catch-all on the main app. This route
  // is registered AFTER all explicit `/api/media`, `/api/media/folders`,
  // `/api/media/presign`, `/api/media/confirm`, and `/api/preview-tokens`
  // routes so Hono's RegExpRouter prefers them when paths overlap.
  app.all("/api/*", async (context) => {
    // Forward the request to the content sub-app, which re-resolves the
    // session in its own middleware. We don't need to strip the `/api`
    // prefix since handlers above include the full `/api/...` path.
    return contentApp.fetch(context.req.raw);
  });

  // Plan-12 U6: now that every migrated `createRoute` declaration has been
  // registered, ask the OpenAPI registry for its document and merge it into
  // the hand-rolled spec. The merge keeps the rich `x-cms-*` extensions and
  // descriptions for paths the registry doesn't yet capture in detail.
  const refreshOpenAPISpec = (): void => {
    if (!openAPI) return;
    try {
      const registrySpec = app.getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "Hono CMS API", version: "0.1.0" }
      }) as unknown as Record<string, unknown>;
      openAPI.finalize(registrySpec);
    } catch {
      // If the registry generator fails (e.g., zod schema produced an invalid
      // OpenAPI fragment) keep serving the hand-rolled spec instead of 500ing.
    }
  };
  refreshOpenAPISpec();

  const internals = {
    collections: config.collections,
    db,
    storage,
    cache,
    jobs,
    auditStore,
    webhookStore,
    auth,
    content: {} as CMSInstance<Collections>["content"],
    async scheduled(event: unknown, env?: unknown, ctx?: unknown): Promise<void> {
      await publishDueScheduledContent(db, config.collections, cache);
      if (jobs?.scheduled) {
        await jobs.scheduled(event, env, ctx);
        return;
      }
      const cron = scheduledEventCron(event);
      if (cron && jobs?.scheduledHandler) {
        await jobs.scheduledHandler(cron, env, ctx);
      }
    },
    async scheduledHandler(cron: string, env?: unknown, ctx?: unknown): Promise<void> {
      if (jobs?.scheduledHandler) {
        await jobs.scheduledHandler(cron, env, ctx);
        return;
      }
      await publishDueScheduledContent(db, config.collections, cache);
    },
    /**
     * Gap-A runtime fix: install a new collection into the live CMS without a
     * server restart. Adds REST routes to the content sub-app, rebuilds the
     * GraphQL schema, refreshes the OpenAPI spec, and prepares the database
     * adapter for the new collection name when it supports it.
     */
    registerCollection(collection: CollectionDefinition<string, FieldsDefinition>): void {
      if (!/^[a-z][a-z0-9-]*$/.test(collection.name)) {
        throw new Error(`Invalid collection name "${collection.name}": must be kebab-case.`);
      }
      // Validate the merged schema; defineSchema throws on relation/UID issues.
      const replacing = config.collections[collection.name];
      const nextCollections = { ...config.collections, [collection.name]: collection };
      defineSchema(nextCollections);
      (config.collections as Record<string, typeof collection>)[collection.name] = collection;
      // Memory and most adapters maintain per-collection state (e.g. a table
      // map) populated at construction time. Drive a best-effort hook so the
      // adapter can allocate storage for the new collection. Adapters without
      // this hook are expected to allocate lazily on first call.
      const adapter = db as unknown as { ensureCollection?: (name: string) => void | Promise<void> };
      try { adapter.ensureCollection?.(collection.name); } catch { /* noop */ }
      registerCollectionRoutes(collection.name);
      rebuildGraphQLHandler();
      refreshOpenAPISpec();
      void replacing;
    },
    /**
     * Drop a collection from the live CMS. Subsequent REST/GraphQL/OpenAPI
     * traffic for this name reports 404. The actual route handlers remain
     * installed on the content sub-app (Hono's router cannot un-register),
     * but the handlers short-circuit when the collection is no longer in
     * `config.collections`.
     */
    unregisterCollection(name: string): void {
      const mutable = config.collections as Record<string, CollectionDefinition<string, FieldsDefinition>>;
      if (!(name in mutable)) return;
      delete mutable[name];
      collectionRouteState.delete(name);
      rebuildGraphQLHandler();
      refreshOpenAPISpec();
    }
  };

  const composedApp = applyPlugins(app, config.plugins, { collections: config.collections, db }, config);
  return Object.assign(composedApp, internals);
}

function requireAccess(config: Pick<CMSConfig, "collections" | "rbac">, session: AuthSession | null, action: Action, collection: string): Response | null {
  return canAccess(config, session, action, collection)
    ? null
    : Response.json({ error: "forbidden" }, { status: 403 });
}

function schemaMetadata(collections: CMSCollections): Record<string, unknown> {
  return {
    collections: Object.fromEntries(Object.values(collections).map((collection) => [
      collection.name,
      schemaCollectionMetadata(collection)
    ]))
  };
}

function schemaCollectionMetadata(collection: CMSCollections[string]): Record<string, unknown> {
  return {
    name: collection.name,
    options: collection.options,
    fields: Object.fromEntries(Object.entries(collection.fields).map(([name, field]) => [name, fieldMetadata(field)]))
  };
}

function contentTypeWriteResponse(
  collection: CMSCollections[string],
  source: string,
  result: SchemaWriteResult,
  afterWrite?: SchemaWriteResult | void
): Record<string, unknown> {
  return {
    collection: schemaCollectionMetadata(collection),
    source,
    ...result,
    ...(afterWrite ?? {})
  };
}

function fieldMetadata(field: CMSCollections[string]["fields"][string]): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    kind: field.kind,
    required: field.required === true,
    unique: field.unique === true,
    localized: field.localized === true,
    private: field.private === true
  };
  if (field.permissions) metadata.permissions = field.permissions;
  if ("default" in field && field.default !== undefined) metadata.default = field.default;
  if (field.kind === "string") {
    if (field.min !== undefined) metadata.min = field.min;
    if (field.max !== undefined) metadata.max = field.max;
  }
  if (field.kind === "uid" && field.targetField) metadata.targetField = field.targetField;
  if (field.kind === "number") {
    metadata.int = field.int === true;
    if (field.min !== undefined) metadata.min = field.min;
    if (field.max !== undefined) metadata.max = field.max;
  }
  if (field.kind === "enum") metadata.values = field.values;
  if (field.kind === "media") metadata.multiple = field.multiple === true;
  if (field.kind === "relation") {
    metadata.target = field.target;
    metadata.cardinality = field.cardinality;
    if (field.inverse) metadata.inverse = field.inverse;
    if (field.onDelete) metadata.onDelete = field.onDelete;
  }
  return metadata;
}

function contentTypeCapabilities<Collections extends CMSCollections>(config: CMSConfig<Collections>): Record<string, unknown> {
  const writer = config.contentTypeBuilder === false ? undefined : config.contentTypeBuilder?.writer;
  return {
    writable: Boolean(writer),
    mode: writer ? "development" : "read-only",
    removable: Boolean(writer?.removeCollection),
    endpoints: {
      list: "/cms/content-types",
      create: "/cms/content-types",
      update: "/cms/content-types/{name}",
      delete: "/cms/content-types/{name}"
    }
  };
}

function parseContentTypeInput(body: unknown, fallbackName?: string): { name: string; collection: CollectionDefinition<string, FieldsDefinition> } | Response {
  if (!body || typeof body !== "object") {
    return validationResponse([{ path: [], message: "Body must be a collection definition object." }]);
  }
  const input = body as { name?: unknown; fields?: unknown; options?: unknown };
  const name = typeof input.name === "string" ? input.name : fallbackName;
  const fields = input.fields;
  const options = input.options ?? {};
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (!name) issues.push({ path: ["name"], message: "Collection name is required." });
  if (name && !/^[a-z][a-z0-9-]*$/.test(name)) issues.push({ path: ["name"], message: "Collection name must be kebab-case." });
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) issues.push({ path: ["fields"], message: "fields must be an object." });
  if (!options || typeof options !== "object" || Array.isArray(options)) issues.push({ path: ["options"], message: "options must be an object when provided." });
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    const fieldEntries = Object.entries(fields as Record<string, unknown>);
    if (!fieldEntries.length) issues.push({ path: ["fields"], message: "At least one field is required." });
    for (const [fieldName, field] of fieldEntries) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fieldName)) {
        issues.push({ path: ["fields", fieldName], message: "Field names must be valid TypeScript identifiers." });
      }
      issues.push(...validateFieldDefinition(field, ["fields", fieldName]));
      if (isRecord(field) && field.kind === "uid" && typeof field.targetField === "string" && field.targetField && !(field.targetField in (fields as Record<string, unknown>))) {
        issues.push({ path: ["fields", fieldName, "targetField"], message: `UID targetField "${field.targetField}" must reference another field in this collection.` });
      }
    }
  }
  if (options && typeof options === "object" && !Array.isArray(options)) {
    issues.push(...validateCollectionOptions(options as Record<string, unknown>));
  }
  if (issues.length) return validationResponse(issues);

  try {
    return {
      name: name!,
      collection: defineCollection(name!, fields as FieldsDefinition, options as CollectionOptions)
    };
  } catch (error) {
    return validationResponse([{ path: [], message: error instanceof Error ? error.message : "Invalid collection definition." }]);
  }
}

function validateContentTypeChange(collections: CMSCollections, collection: CollectionDefinition<string, FieldsDefinition>, replacing?: string): Response | null {
  try {
    const nextCollections = { ...collections };
    if (replacing && replacing !== collection.name) delete nextCollections[replacing];
    nextCollections[collection.name] = collection;
    defineSchema(nextCollections);
    return null;
  } catch (error) {
    return validationResponse([{ path: [], message: error instanceof Error ? error.message : "Invalid schema." }]);
  }
}

function validateFieldDefinition(field: unknown, path: Array<string | number>): Array<{ path: Array<string | number>; message: string }> {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    return [{ path, message: "Field definition must be an object." }];
  }
  const definition = field as Record<string, unknown>;
  const kind = definition.kind;
  if (typeof kind !== "string" || !isFieldKind(kind)) {
    issues.push({ path: [...path, "kind"], message: "Unsupported field kind." });
    return issues;
  }
  for (const flag of ["required", "unique", "localized", "private"] as const) {
    if (definition[flag] !== undefined && typeof definition[flag] !== "boolean") {
      issues.push({ path: [...path, flag], message: `${flag} must be a boolean.` });
    }
  }
  if (definition.permissions !== undefined && (!definition.permissions || typeof definition.permissions !== "object" || Array.isArray(definition.permissions))) {
    issues.push({ path: [...path, "permissions"], message: "permissions must be an object." });
  }
  if ((kind === "string" || kind === "number") && definition.min !== undefined && typeof definition.min !== "number") {
    issues.push({ path: [...path, "min"], message: "min must be a number." });
  }
  if ((kind === "string" || kind === "number") && definition.max !== undefined && typeof definition.max !== "number") {
    issues.push({ path: [...path, "max"], message: "max must be a number." });
  }
  if ((kind === "string" || kind === "number") && typeof definition.min === "number" && typeof definition.max === "number" && definition.min > definition.max) {
    issues.push({ path: [...path, "min"], message: "min cannot be greater than max." });
  }
  if (kind === "number" && definition.int !== undefined && typeof definition.int !== "boolean") {
    issues.push({ path: [...path, "int"], message: "int must be a boolean." });
  }
  if (kind === "uid" && definition.targetField !== undefined && typeof definition.targetField !== "string") {
    issues.push({ path: [...path, "targetField"], message: "targetField must be a string." });
  }
  if (kind === "enum" && (!Array.isArray(definition.values) || definition.values.length === 0 || definition.values.some((value) => typeof value !== "string" || value.length === 0))) {
    issues.push({ path: [...path, "values"], message: "Enum fields require at least one non-empty string value." });
  }
  if (kind === "enum" && Array.isArray(definition.values) && definition.values.every((value) => typeof value === "string") && new Set(definition.values).size !== definition.values.length) {
    issues.push({ path: [...path, "values"], message: "Enum values must be unique." });
  }
  if (kind === "relation") {
    if (typeof definition.target !== "string" || !definition.target) issues.push({ path: [...path, "target"], message: "Relation fields require a target collection." });
    if (!isRelationCardinality(definition.cardinality)) issues.push({ path: [...path, "cardinality"], message: "Relation fields require a supported cardinality." });
    if (definition.inverse !== undefined && typeof definition.inverse !== "string") issues.push({ path: [...path, "inverse"], message: "inverse must be a string." });
    if (typeof definition.inverse === "string" && definition.inverse && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(definition.inverse)) {
      issues.push({ path: [...path, "inverse"], message: "inverse must be a valid TypeScript identifier." });
    }
    if (definition.onDelete !== undefined && definition.onDelete !== "cascade" && definition.onDelete !== "restrict" && definition.onDelete !== "set_null") {
      issues.push({ path: [...path, "onDelete"], message: "onDelete must be cascade, restrict, or set_null." });
    }
  }
  if (kind === "media" && definition.multiple !== undefined && typeof definition.multiple !== "boolean") {
    issues.push({ path: [...path, "multiple"], message: "multiple must be a boolean." });
  }
  return issues;
}

function validateCollectionOptions(options: Record<string, unknown>): Array<{ path: Array<string | number>; message: string }> {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (options.draftAndPublish !== undefined && typeof options.draftAndPublish !== "boolean") {
    issues.push({ path: ["options", "draftAndPublish"], message: "draftAndPublish must be a boolean." });
  }
  if (options.timestamps !== undefined && typeof options.timestamps !== "boolean") {
    issues.push({ path: ["options", "timestamps"], message: "timestamps must be a boolean." });
  }
  if (options.i18n !== undefined) {
    const i18n = options.i18n as Record<string, unknown>;
    if (!i18n || typeof i18n !== "object" || Array.isArray(i18n)) {
      issues.push({ path: ["options", "i18n"], message: "i18n must be an object." });
    } else {
      if (!Array.isArray(i18n.locales) || i18n.locales.length === 0 || i18n.locales.some((locale) => typeof locale !== "string")) {
        issues.push({ path: ["options", "i18n", "locales"], message: "i18n.locales must contain at least one locale string." });
      }
      if (typeof i18n.defaultLocale !== "string") issues.push({ path: ["options", "i18n", "defaultLocale"], message: "i18n.defaultLocale is required." });
    }
  }
  return issues;
}

function isFieldKind(kind: string): kind is FieldDefinition["kind"] {
  return kind === "string" || kind === "text" || kind === "richtext" || kind === "number" || kind === "boolean" || kind === "datetime" || kind === "date" || kind === "time" || kind === "json" || kind === "email" || kind === "url" || kind === "password" || kind === "uid" || kind === "enum" || kind === "media" || kind === "relation";
}

function isRelationCardinality(value: unknown): value is RelationCardinality {
  return value === "one" || value === "many" || value === "one-to-one" || value === "many-to-one" || value === "one-to-many" || value === "many-to-many";
}

function validationResponse(issues: Array<{ path: Array<string | number>; message: string }>): Response {
  return Response.json({ error: "validation_error", issues }, { status: 422 });
}

function forbiddenFieldResponse(fields: string[]): Response {
  return Response.json({
    error: "forbidden_field",
    issues: fields.map((field) => ({ path: [field], message: `Field "${field}" cannot be written by this session.` }))
  }, { status: 403 });
}

function relationConstraintResponse(error: RelationConstraintError): Response {
  return Response.json({
    error: error.code,
    message: error.message,
    collection: error.collection,
    relatedCollection: error.relatedCollection,
    field: error.field,
    relatedIds: error.relatedIds
  }, { status: error.status });
}

function serializeWebhookListItem(record: WebhookRecord, lastDelivery?: WebhookDelivery): Omit<WebhookRecord, "secret"> & {
  hasSecret: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: WebhookDelivery["status"] | null;
} {
  const { secret, ...safe } = record;
  return {
    ...safe,
    hasSecret: Boolean(secret),
    lastDeliveryAt: lastDelivery?.createdAt ?? null,
    lastDeliveryStatus: lastDelivery?.status ?? null
  };
}

function serializeApiKey(record: ApiKeyRecord): ApiKeyListItem {
  const { hash, ...safe } = record;
  return {
    ...safe,
    roles: [...record.roles]
  };
}

function validateApiKeyInput(
  input: Partial<Pick<ApiKeyRecord, "name" | "userId" | "roles" | "enabled">>,
  options?: { partial?: boolean }
): Response | null {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (!options?.partial || input.userId !== undefined) {
    if (typeof input.userId !== "string" || !input.userId.trim()) issues.push({ path: ["userId"], message: "userId is required" });
  }
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim())) {
    issues.push({ path: ["name"], message: "name must be a non-empty string" });
  }
  if (!options?.partial || input.roles !== undefined) {
    if (!Array.isArray(input.roles) || input.roles.length === 0 || input.roles.some((role) => typeof role !== "string" || !role.trim())) {
      issues.push({ path: ["roles"], message: "roles must be a non-empty string array" });
    }
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") issues.push({ path: ["enabled"], message: "enabled must be a boolean" });
  return issues.length ? Response.json({ error: "validation_error", issues }, { status: 400 }) : null;
}

function validateOrganizationInput(input: Partial<OrganizationUpdateInput> | null): Response | null {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (!input || typeof input !== "object") issues.push({ path: [], message: "Body must be an organization object" });
  if (typeof input?.name !== "string" || !input.name.trim()) issues.push({ path: ["name"], message: "name is required" });
  if (typeof input?.slug !== "string" || !input.slug.trim()) issues.push({ path: ["slug"], message: "slug is required" });
  if (input?.plan !== undefined && (typeof input.plan !== "string" || !input.plan.trim())) issues.push({ path: ["plan"], message: "plan must be a non-empty string" });
  return issues.length ? Response.json({ error: "validation_error", issues }, { status: 400 }) : null;
}

function validateOrganizationMemberInput(input: { role?: string; status?: OrganizationMemberStatus } | null): Response | null {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (!input || typeof input !== "object") issues.push({ path: [], message: "Body must be a member update object" });
  if (typeof input?.role !== "string" || !input.role.trim()) issues.push({ path: ["role"], message: "role is required" });
  if (!isOrganizationMemberStatus(input?.status)) issues.push({ path: ["status"], message: "status must be active, pending, or disabled" });
  return issues.length ? Response.json({ error: "validation_error", issues }, { status: 400 }) : null;
}

function validateOrganizationInvitationInput(input: Partial<OrganizationInvitationInput> | null): Response | null {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (!input || typeof input !== "object") issues.push({ path: [], message: "Body must be an invitation object" });
  if (typeof input?.email !== "string" || !input.email.trim() || !input.email.includes("@")) issues.push({ path: ["email"], message: "valid email is required" });
  if (typeof input?.role !== "string" || !input.role.trim()) issues.push({ path: ["role"], message: "role is required" });
  return issues.length ? Response.json({ error: "validation_error", issues }, { status: 400 }) : null;
}

function isOrganizationMemberStatus(value: unknown): value is OrganizationMemberStatus {
  return value === "active" || value === "pending" || value === "disabled";
}

function resolveApiKeyStore(auth: CMSConfig["auth"], configuredStore?: ApiKeyStore): ApiKeyStore | null {
  if (configuredStore) return configuredStore;
  if (isApiKeyAuthConfig(auth)) {
    return auth.store ?? new MemoryApiKeyStore(auth.keys ?? []);
  }
  // When the caller wires better-auth (AuthAdapter or AuthConfig) and doesn't
  // pass an apiKeyStore explicitly, default to an in-memory store so the CMS
  // api-keys routes work out of the box rather than 409-ing with
  // `api_key_store_not_configured` (sharp edge surfaced by Plan-4 U7 audit).
  if (auth != null) return new MemoryApiKeyStore();
  return null;
}

function withResolvedApiKeyStore(auth: CMSConfig["auth"], store: ApiKeyStore | null): CMSConfig["auth"] {
  if (isApiKeyAuthConfig(auth) && store) {
    return { ...auth, store };
  }
  return auth;
}

function isApiKeyAuthConfig(auth: CMSConfig["auth"]): auth is Extract<NonNullable<CMSConfig["auth"]>, { provider: "api-key" }> {
  return Boolean(auth && typeof auth === "object" && !("sessionFromRequest" in auth) && "provider" in auth && auth.provider === "api-key");
}

async function updateManagedWebhook(
  store: WebhookStore,
  id: string,
  body: Partial<WebhookRecord> & { secret?: string | null },
  options: { partial: boolean }
): Promise<Response> {
  const validation = validateWebhookInput(body, { partial: options.partial });
  if (validation) return validation;
  const patch: Partial<Omit<WebhookRecord, "id" | "createdAt" | "updatedAt" | "secret">> & { secret?: string | undefined } = {};
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.url !== undefined) patch.url = body.url;
  if (body.events !== undefined) patch.events = body.events;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if ("secret" in body) {
    if (typeof body.secret === "string" && body.secret.trim()) patch.secret = body.secret;
    else patch.secret = undefined;
  }
  try {
    const webhook = await store.updateWebhook(id, patch);
    return Response.json("secret" in body && typeof body.secret === "string" && body.secret.trim() ? webhook : serializeWebhook(webhook));
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) return Response.json({ error: "not_found" }, { status: 404 });
    throw error;
  }
}

function validateWebhookInput(input: Partial<Pick<WebhookRecord, "name" | "url" | "events" | "enabled">>, options?: { partial?: boolean }): Response | null {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (!options?.partial || input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) issues.push({ path: ["name"], message: "name is required" });
  }
  if (!options?.partial || input.url !== undefined) {
    if (typeof input.url !== "string" || !isValidHttpUrl(input.url)) issues.push({ path: ["url"], message: "url must be a valid HTTP URL" });
  }
  if (!options?.partial || input.events !== undefined) {
    if (!Array.isArray(input.events) || input.events.length === 0 || input.events.some((event) => typeof event !== "string" || !event.trim())) {
      issues.push({ path: ["events"], message: "events must be a non-empty string array" });
    }
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") issues.push({ path: ["enabled"], message: "enabled must be a boolean" });
  return issues.length ? Response.json({ error: "validation_error", issues }, { status: 400 }) : null;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveI18nBackfillTargets(
  collections: CMSCollections,
  input: { locale?: string; collection?: string }
): { locale: string; collections: string[] } | Response {
  if (!input.locale) {
    return Response.json({ error: "validation_error", issues: [{ path: ["locale"], message: "locale is required" }] }, { status: 422 });
  }
  const localizedCollections = Object.values(collections).filter((collection) => collection.options.i18n);
  const sourceCollections = input.collection
    ? localizedCollections.filter((collection) => collection.name === input.collection)
    : localizedCollections;
  if (input.collection && sourceCollections.length === 0) {
    return Response.json({ error: "i18n_not_enabled", issues: [{ path: ["collection"], message: `Collection "${input.collection}" is not localized.` }] }, { status: 400 });
  }
  if (sourceCollections.length === 0) {
    return Response.json({ error: "i18n_not_enabled" }, { status: 400 });
  }
  const unsupported = sourceCollections.find((collection) => !collection.options.i18n?.locales.includes(input.locale as string));
  if (unsupported) {
    return Response.json({ error: "unsupported_locale", issues: [{ path: ["locale"], message: `Locale "${input.locale}" is not configured for "${unsupported.name}".` }] }, { status: 422 });
  }
  const defaultLocale = sourceCollections.find((collection) => collection.options.i18n?.defaultLocale === input.locale);
  if (defaultLocale) {
    return Response.json({ error: "validation_error", issues: [{ path: ["locale"], message: `Locale "${input.locale}" is the default locale for "${defaultLocale.name}".` }] }, { status: 422 });
  }
  return { locale: input.locale, collections: sourceCollections.map((collection) => collection.name) };
}

async function listAllRecords<Collections extends CMSCollections>(
  db: ReturnType<typeof createDatabaseAdapter<Collections>>,
  collectionName: keyof Collections & string
): Promise<ContentRecord[]> {
  const items: ContentRecord[] = [];
  let cursor: string | undefined;
  do {
    const query: { limit: number; cursor?: string } = { limit: 200 };
    if (cursor) query.cursor = cursor;
    const result = await db.list(collectionName, query);
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

async function listWithRelationFilters<Collections extends CMSCollections>(
  db: ReturnType<typeof createDatabaseAdapter<Collections>>,
  collections: Collections,
  collectionName: keyof Collections & string,
  collection: CollectionDefinition<string, FieldsDefinition>,
  query: ListQuery,
  relationFilters: readonly RelationFilter[]
): Promise<{ items: ContentRecord[]; nextCursor?: string; total?: number }> {
  const sourceQuery: ListQuery = { ...query, limit: 200 };
  delete sourceQuery.cursor;
  delete sourceQuery.cursorCreatedAt;
  delete sourceQuery.page;
  delete sourceQuery.pageSize;
  const all = await collectListRecords((nextQuery) => listWithLocaleFallback((localeQuery) => db.list(collectionName, localeQuery), collection, nextQuery), {
    ...sourceQuery
  });
  const related = await filterRecordsByRelations(db, collections, all, relationFilters, query.status === "published" ? { status: "published" } : {});
  return applyListQuery(related, { ...query, filters: {} });
}

async function collectListRecords(
  list: (query: ListQuery) => Promise<{ items: ContentRecord[]; nextCursor?: string }>,
  query: ListQuery
): Promise<ContentRecord[]> {
  const items: ContentRecord[] = [];
  let cursor: string | undefined;
  do {
    const nextQuery: ListQuery = { ...query };
    if (cursor) nextQuery.cursor = cursor;
    const result = await list(nextQuery);
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

function scheduledEventCron(event: unknown): string | null {
  if (!event || typeof event !== "object" || !("cron" in event)) return null;
  const cron = (event as { cron?: unknown }).cron;
  return typeof cron === "string" && cron.trim() ? cron : null;
}

function localeMutationError(collection: CMSCollections[string], locale: string): Response | null {
  if (!collection.options.i18n?.locales.includes(locale)) {
    return Response.json({ error: "unsupported_locale", issues: [{ path: ["locale"], message: `Locale "${locale}" is not configured for "${collection.name}".` }] }, { status: 422 });
  }
  if (locale === collection.options.i18n.defaultLocale) {
    return Response.json({ error: "validation_error", issues: [{ path: ["locale"], message: "Default locale is edited through the content record." }] }, { status: 422 });
  }
  return null;
}

async function enforceMutationRateLimit<Collections extends CMSCollections>(
  cache: CacheAdapter | null,
  config: CMSConfig<Collections>,
  request: Request
): Promise<Response | null> {
  return enforceRateLimit(cache, config, request, "mutations");
}

async function enforceRateLimit<Collections extends CMSCollections>(
  cache: CacheAdapter | null,
  config: CMSConfig<Collections>,
  request: Request,
  scope: "mutations" | "graphql" | "media" | "auth" | "admin" | "jobs"
): Promise<Response | null> {
  const options = rateLimitOptions(config, scope);
  if (!options || !cache?.checkRateLimit) return null;
  const result = await cache.checkRateLimit(clientIdentifier(request), {
    limit: options.limit ?? 100,
    window: options.window ?? "1 m",
    prefix: options.prefix ?? `cms:${scope}`
  });
  if (result.success) return null;
  const headers = new Headers({
    "retry-after": retryAfterSeconds(result.resetAt),
    "x-ratelimit-remaining": String(result.remaining)
  });
  if (result.resetAt) headers.set("x-ratelimit-reset", result.resetAt);
  return Response.json({ error: "rate_limited" }, { status: 429, headers });
}

function rateLimitOptions<Collections extends CMSCollections>(
  config: CMSConfig<Collections>,
  scope: "mutations" | "graphql" | "media" | "auth" | "admin" | "jobs"
): { limit?: number; window?: string; prefix?: string } | undefined {
  if (config.rateLimit === false) return undefined;
  const configured = config.rateLimit?.[scope];
  if (configured === false) return undefined;
  if (configured) return configured;
  if (scope === "jobs") return undefined;
  return config.rateLimit?.mutations;
}

async function isGraphQLMutationRequest(request: Request): Promise<boolean> {
  try {
    if (request.method === "GET") {
      return /^\s*mutation\b/.test(new URL(request.url).searchParams.get("query") ?? "");
    }
    const body = await request.clone().json() as { query?: unknown };
    return typeof body.query === "string" && /^\s*mutation\b/.test(body.query);
  } catch {
    return false;
  }
}

function clientIdentifier(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
}

function retryAfterSeconds(resetAt: string | undefined): string {
  if (!resetAt) return "60";
  const seconds = Math.ceil((Date.parse(resetAt) - Date.now()) / 1000);
  return String(Math.max(1, seconds));
}

function writableLocaleFields(collection: CMSCollections[string], input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(localizableFieldNames(collection));
  const fields = "fields" in input && input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
    ? input.fields as Record<string, unknown>
    : input;
  return Object.fromEntries(Object.entries(fields).filter(([field]) => allowed.has(field)));
}

function normalizeRelationInputAliases(collection: CMSCollections[string], input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  for (const [name, field] of Object.entries(collection.fields)) {
    if (field.kind !== "relation" || !relationHasLocalIdField(field)) continue;
    const idName = `${name}Id`;
    if (normalized[name] === undefined && normalized[idName] !== undefined) {
      normalized[name] = normalized[idName];
    }
  }
  return normalized;
}

function validationErrorResponse(issues: QueryValidationIssue[]): Response {
  return Response.json({ error: "validation_error", issues }, { status: 422 });
}

function requireAdmin(session: AuthSession | null): Response | null {
  return session?.roles.includes("admin") ? null : Response.json({ error: "forbidden" }, { status: 403 });
}

function requireEditor(session: AuthSession | null): Response | null {
  return session?.roles.some((role) => role === "admin" || role === "editor") ? null : Response.json({ error: "forbidden" }, { status: 403 });
}

function publicStatusFilter(enabled: boolean | undefined, session: AuthSession | null): { status?: "published" } {
  if (!enabled) return {};
  return session ? {} : { status: "published" };
}

async function runHooks(
  hooks: HookFunction[] | undefined,
  input: Record<string, unknown>,
  context: { collection: string; id?: string; session: AuthSession | null; request: Request }
): Promise<Record<string, unknown>> {
  let current = input;
  for (const hook of hooks ?? []) {
    const next = await hook(current, context);
    if (next) current = next;
  }
  return current;
}

async function emitMutationEvent(config: Pick<CMSConfig, "webhooks">, webhookStore: NonNullable<CMSConfig["webhookStore"]>, jobs: ReturnType<typeof createJobsAdapter>, event: WebhookEvent): Promise<void> {
  await dispatchWebhooks({
    staticTargets: config.webhooks ?? [],
    store: webhookStore,
    event,
    ...(jobs?.enqueue ? { retry: { enqueue: (endpoint: string, body?: unknown, options?: { delay?: number }) => jobs.enqueue?.(endpoint, body, options) ?? Promise.resolve() } } : {})
  });
}

async function publishDueScheduledContent<Collections extends CMSCollections>(
  db: ReturnType<typeof createDatabaseAdapter<Collections>>,
  collections: Collections,
  cache: ReturnType<typeof createCacheAdapter>
): Promise<ContentRecord[]> {
  const published = await runScheduledPublishes(db, collections);
  if (published.length) {
    await Promise.all(Object.keys(collections)
      .filter((collectionName) => collections[collectionName]?.options.draftAndPublish)
      .map((collectionName) => invalidateContentCache(cache, collectionName)));
  }
  return published;
}

async function runVerifiedJob(jobs: NonNullable<ReturnType<typeof createJobsAdapter>>, request: Request, run: () => Promise<unknown>): Promise<Response> {
  try {
    if (jobs.verify && !await jobs.verify(request.clone())) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const result = await run();
    if (result instanceof Response) return result;
    return Response.json(result);
  } catch (error) {
    console.error("[hono-cms/jobs]", error);
    return Response.json({ error: "job_failed", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function registerJob(jobs: NonNullable<ReturnType<typeof createJobsAdapter>>, name: string, run: (payload?: unknown) => Promise<unknown> | unknown): void {
  if (typeof jobs.register !== "function") return;
  try {
    jobs.register(name, async (payload) => {
      const result = await run(payload);
      if (result instanceof Response && !result.ok) {
        throw new Error(await result.clone().text());
      }
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already registered")) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function healthResponse(startedAt: number, checkers: Parameters<typeof runHealthChecks>[0]): Promise<Response> {
  const report = await runHealthChecks(checkers, { startedAt, version: "0.1.0" });
  return Response.json(report, { status: report.status === "ok" ? 200 : 503 });
}

function renderDocs(specPath: string): string {
  return [
    "<!doctype html><html><head><title>Hono CMS API</title></head><body>",
    `<script id="api-reference" data-url="${escapeHtmlAttribute(specPath)}"></script>`,
    "<script>",
    "document.getElementById('api-reference').dataset.configuration = JSON.stringify({",
    "  authentication: { preferredSecurityScheme: 'bearerAuth' }",
    "});",
    "</script>",
    "<script src=\"https://cdn.jsdelivr.net/npm/@scalar/api-reference\"></script>",
    "</body></html>"
  ].join("");
}

type OpenAPIResponseHolder = {
  specPath: string;
  docsPath?: string;
  json: string;
  etag: string;
  headers: Headers;
  cors?: boolean | CorsConfig;
  /**
   * Plan-12 U6: rebuild the served JSON/etag/headers once the `OpenAPIHono`
   * registry has been populated by the migrated `createRoute` declarations,
   * merging the hand-rolled spec with `app.getOpenAPI31Document(...)`.
   */
  finalize: (registrySpec: Record<string, unknown>) => void;
};

function buildOpenAPIResponse<Collections extends CMSCollections>(config: CMSConfig<Collections>): OpenAPIResponseHolder | null {
  if (config.openapi === false) return null;
  const options = normalizeOpenAPIConfig(config.openapi);
  const production = isProduction(config.env);
  const explicitSpecPath = options.path !== undefined || options.specPath !== undefined;
  const explicitDocsPath = options.docs !== undefined || options.docsPath !== undefined;
  if (production && !explicitSpecPath && !explicitDocsPath) return null;

  const specPath = options.path ?? options.specPath ?? "/cms/openapi.json";
  const docsPath = production && !explicitDocsPath ? undefined : options.docs ?? options.docsPath ?? "/cms/docs";
  const graphQLOptions = config.graphql === false ? false : normalizeGraphQLConfig(config.graphql);
  const handRolledSpec = createOpenAPISpec(config.collections, { ...options, graphql: graphQLOptions });
  const initialJson = JSON.stringify(handRolledSpec);
  const cors = options.cors ?? config.cors;
  const baseHeaders = (): Headers => {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": production ? "public, max-age=3600" : "no-store",
      "access-control-allow-methods": "GET, OPTIONS"
    });
    if (!cors) headers.set("access-control-allow-origin", "*");
    return headers;
  };
  const initialEtag = `"${hashText(initialJson)}"`;
  const headers = baseHeaders();
  headers.set("etag", initialEtag);

  const holder: OpenAPIResponseHolder = {
    specPath,
    json: initialJson,
    etag: initialEtag,
    headers,
    finalize(registrySpec) {
      const merged = mergeOpenAPISpec(handRolledSpec as Record<string, unknown>, registrySpec);
      const nextJson = JSON.stringify(merged);
      const nextEtag = `"${hashText(nextJson)}"`;
      holder.json = nextJson;
      holder.etag = nextEtag;
      const nextHeaders = baseHeaders();
      nextHeaders.set("etag", nextEtag);
      holder.headers = nextHeaders;
    }
  };
  if (docsPath) holder.docsPath = docsPath;
  if (cors) holder.cors = cors;
  return holder;
}

function buildGraphQLConfig<Collections extends CMSCollections>(config: CMSConfig<Collections>): {
  paths: string[];
  schemaPaths: string[];
  introspection: boolean;
} | null {
  if (config.graphql === false) return null;
  const options = normalizeGraphQLConfig(config.graphql);
  const path = options.path ?? "/graphql";
  const schemaPath = options.schemaPath ?? `${path.replace(/\/$/, "")}/schema`;
  return {
    paths: uniquePaths([path, "/cms/graphql"]),
    schemaPaths: uniquePaths([schemaPath, "/cms/graphql/schema"]),
    introspection: options.introspection ?? !isProduction(config.env)
  };
}

function normalizeGraphQLConfig(config: CMSConfig["graphql"]): GraphQLConfig {
  return config && typeof config === "object" ? config : {};
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.startsWith("/") ? path : `/${path}`))];
}

function openAPIHeaders(openAPI: { headers: Headers; cors?: boolean | CorsConfig }, request: Request): Headers {
  const headers = new Headers(openAPI.headers);
  applyOpenAPICorsHeaders(openAPI.cors, request, { headers });
  return headers;
}

function openAPIPreflightHeaders(openAPI: { headers: Headers; cors?: boolean | CorsConfig }, request: Request): Headers {
  const preflight = openAPIHeaders(openAPI, request);
  preflight.delete("content-type");
  preflight.delete("cache-control");
  preflight.delete("etag");
  preflight.set("access-control-allow-methods", "GET, OPTIONS");
  preflight.set("access-control-allow-headers", "authorization, content-type, if-none-match");
  const maxAge = openAPI.cors ? normalizeCors(openAPI.cors).maxAge : undefined;
  preflight.set("access-control-max-age", String(maxAge ?? 3600));
  return preflight;
}

function applyOpenAPICorsHeaders(config: boolean | CorsConfig | undefined, request: Request, response: Pick<Response, "headers">): void {
  if (config) {
    applyCorsHeaders(config, request, response);
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function normalizeOpenAPIConfig(config: CMSConfig["openapi"]): OpenAPIConfig {
  return config && typeof config === "object" ? config : {};
}

function isProduction(env: CMSConfig["env"]): boolean {
  const configured = typeof env?.NODE_ENV === "string" ? env.NODE_ENV : undefined;
  const runtime = (globalThis as unknown as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
  return (configured ?? runtime) === "production";
}

function hashText(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getRequestId(request: Request): string {
  return request.headers.get("x-request-id") ?? crypto.randomUUID();
}

function auditConfig(config: Pick<CMSConfig, "auditLog">): { excludeFields?: readonly string[]; maxFieldBytes?: number } {
  if (!config.auditLog || typeof config.auditLog !== "object") return {};
  const result: { excludeFields?: readonly string[]; maxFieldBytes?: number } = {};
  if (config.auditLog.excludeFields) result.excludeFields = config.auditLog.excludeFields;
  if (config.auditLog.maxFieldBytes) result.maxFieldBytes = config.auditLog.maxFieldBytes;
  return result;
}

function translationJobOptions(config: Pick<CMSConfig, "i18n">): { enabled?: boolean; translateOnPublish?: boolean } {
  const result: { enabled?: boolean; translateOnPublish?: boolean } = {};
  if (config.i18n?.autoTranslate !== undefined) result.enabled = config.i18n.autoTranslate;
  if (config.i18n?.translateOnPublish !== undefined) result.translateOnPublish = config.i18n.translateOnPublish;
  return result;
}

function parseAuditQuery(url: URL): { query: AuditLogQuery; issues: QueryValidationIssue[] } {
  const query: AuditLogQuery = {};
  const issues: QueryValidationIssue[] = [];
  const collection = url.searchParams.get("collection");
  const documentId = url.searchParams.get("documentId");
  const operation = url.searchParams.get("operation") as AuditLogQuery["operation"] | null;
  const actorId = url.searchParams.get("actorId");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const cursor = url.searchParams.get("cursor");
  const format = url.searchParams.get("format");
  if (collection) query.collection = collection;
  if (documentId) query.documentId = documentId;
  if (operation) {
    if (AUDIT_OPERATIONS.has(operation)) query.operation = operation;
    else issues.push({ path: ["operation"], message: "operation is not supported" });
  }
  if (actorId) query.actorId = actorId;
  if (from) {
    if (Number.isNaN(Date.parse(from))) issues.push({ path: ["from"], message: "from must be a valid date-time" });
    else query.from = from;
  }
  if (to) {
    if (Number.isNaN(Date.parse(to))) issues.push({ path: ["to"], message: "to must be a valid date-time" });
    else query.to = to;
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
    issues.push({ path: ["from", "to"], message: "from must be before to" });
  }
  if (cursor) query.cursor = cursor;
  if (format) {
    if (format === "csv" || format === "json") query.format = format;
    else issues.push({ path: ["format"], message: "format must be json or csv" });
  }
  const rawLimit = url.searchParams.get("limit");
  const limit = Number(rawLimit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    issues.push({ path: ["limit"], message: "limit must be an integer between 1 and 100" });
  } else {
    query.limit = limit;
  }
  return { query, issues };
}

function parseMediaListQuery(url: URL): MediaListQuery | Response {
  const issues: QueryValidationIssue[] = [];
  const rawLimit = url.searchParams.get("limit");
  const limit = Number(rawLimit ?? 50);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    issues.push({ path: ["limit"], message: "limit must be an integer between 1 and 100" });
  }
  if (from && Number.isNaN(Date.parse(from))) issues.push({ path: ["from"], message: "from must be a valid date-time" });
  if (to && Number.isNaN(Date.parse(to))) issues.push({ path: ["to"], message: "to must be a valid date-time" });
  if (from && to && !Number.isNaN(Date.parse(from)) && !Number.isNaN(Date.parse(to)) && Date.parse(from) > Date.parse(to)) {
    issues.push({ path: ["from", "to"], message: "from must be before to" });
  }
  if (issues.length) return Response.json({ error: "validation_error", issues }, { status: 422 });

  const query: MediaListQuery = { limit };
  const cursor = url.searchParams.get("cursor");
  const q = url.searchParams.get("q") ?? url.searchParams.get("search");
  const type = url.searchParams.get("type") ?? url.searchParams.get("mimeType");
  const folderId = url.searchParams.get("folderId");
  if (cursor) query.cursor = cursor;
  if (q?.trim()) query.q = q.trim();
  if (type?.trim()) query.type = type.trim();
  if (from) query.from = new Date(from).toISOString();
  if (to) query.to = new Date(to).toISOString();
  if (folderId !== null) {
    // `?folderId=` (empty string) or `?folderId=null` means "root only".
    query.folderId = folderId === "" || folderId === "null" ? null : folderId;
  }
  return query;
}

function parseWebhookDeliveryListQuery(url: URL, webhookId: string): { webhookId: string; cursor?: string; limit: number } | Response {
  const rawLimit = url.searchParams.get("limit");
  const limit = Number(rawLimit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return validationErrorResponse([{ path: ["limit"], message: "limit must be an integer between 1 and 100" }]);
  }

  const query: { webhookId: string; cursor?: string; limit: number } = { webhookId, limit };
  const cursor = url.searchParams.get("cursor");
  if (cursor) query.cursor = cursor;
  return query;
}

async function findMediaReferences<Collections extends CMSCollections>(
  db: DatabaseAdapter<Collections>,
  collections: Collections,
  mediaId: string
): Promise<Array<{ collection: string; field: string; id: string }>> {
  const references: Array<{ collection: string; field: string; id: string }> = [];
  for (const collection of Object.values(collections)) {
    const mediaFields = Object.entries(collection.fields).filter(([, field]) => field.kind === "media");
    if (!mediaFields.length) continue;
    let cursor: string | undefined;
    do {
      const result = await db.list(collection.name as keyof Collections & string, cursor ? { cursor, limit: 100 } : { limit: 100 });
      for (const record of result.items) {
        for (const [fieldName] of mediaFields) {
          if (recordReferencesMedia(record, fieldName, mediaId)) {
            references.push({ collection: collection.name, field: fieldName, id: record.id });
          }
        }
      }
      cursor = result.nextCursor;
    } while (cursor);
  }
  return references;
}

function recordReferencesMedia(record: ContentRecord, fieldName: string, mediaId: string): boolean {
  const value = record[`${fieldName}Id`] ?? record[fieldName];
  if (typeof value === "string") return value === mediaId;
  if (Array.isArray(value)) return value.some((item) => mediaReferenceId(item) === mediaId);
  return mediaReferenceId(value) === mediaId;
}

function mediaReferenceId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function mediaSecurityOptions<Collections extends CMSCollections>(config: CMSConfig<Collections>): { allowActiveContent?: boolean } {
  return config.media?.allowActiveContent === true ? { allowActiveContent: true } : {};
}

function corsPreflightResponse(config: CMSConfig["cors"], request: Request): Response | null {
  if (!config) return null;
  if (request.method !== "OPTIONS" || !request.headers.get("access-control-request-method")) return null;
  const response = new Response(null, { status: 204 });
  applyCorsHeaders(config, request, response);
  const normalized = normalizeCors(config);
  response.headers.set("access-control-allow-methods", normalized.methods.join(", "));
  response.headers.set("access-control-allow-headers", request.headers.get("access-control-request-headers") ?? normalized.allowedHeaders.join(", "));
  if (normalized.maxAge !== undefined) response.headers.set("access-control-max-age", String(normalized.maxAge));
  response.headers.append("vary", "Access-Control-Request-Method");
  response.headers.append("vary", "Access-Control-Request-Headers");
  return response;
}

function applyCorsHeaders(config: CMSConfig["cors"], request: Request, response: Pick<Response, "headers">): void {
  if (!config) return;
  const normalized = normalizeCors(config);
  const origin = resolveCorsOrigin(normalized, request);
  if (!origin) return;
  response.headers.set("access-control-allow-origin", origin);
  response.headers.append("vary", "Origin");
  if (normalized.credentials) response.headers.set("access-control-allow-credentials", "true");
  if (normalized.exposedHeaders.length) response.headers.set("access-control-expose-headers", normalized.exposedHeaders.join(", "));
}

function normalizeCors(config: Exclude<CMSConfig["cors"], false | undefined>): Required<Omit<CorsConfig, "maxAge">> & { maxAge?: number } {
  const options = config === true ? {} : config;
  const result: Required<Omit<CorsConfig, "maxAge">> & { maxAge?: number } = {
    origin: options.origin ?? "*",
    credentials: options.credentials ?? false,
    methods: options.methods ?? ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: options.allowedHeaders ?? ["authorization", "content-type", "x-request-id", "x-filename"],
    exposedHeaders: options.exposedHeaders ?? []
  };
  if (options.maxAge !== undefined) result.maxAge = options.maxAge;
  return result;
}

function resolveCorsOrigin(config: Required<Omit<CorsConfig, "maxAge">> & { maxAge?: number }, request: Request): string | null {
  const requestOrigin = request.headers.get("origin");
  if (typeof config.origin === "function") {
    const resolved = config.origin(requestOrigin, request);
    if (resolved === true) return requestOrigin ?? "*";
    if (resolved === false) return null;
    return resolved ?? null;
  }
  if (config.origin === true) return requestOrigin ?? (config.credentials ? null : "*");
  if (config.origin === false) return null;
  if (config.origin === "*") return config.credentials && requestOrigin ? requestOrigin : "*";
  if (typeof config.origin === "string") return requestOrigin === config.origin ? config.origin : null;
  if (Array.isArray(config.origin)) return requestOrigin && config.origin.includes(requestOrigin) ? requestOrigin : null;
  return null;
}
