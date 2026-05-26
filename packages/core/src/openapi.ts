import { generateOpenAPISchemas, type CMSCollections } from "@hono-cms/schema";

type Operation = {
  tags: string[];
  summary: string;
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

type OpenAPISpec = {
  openapi?: string;
  info?: Record<string, unknown>;
  servers?: unknown;
  tags?: unknown;
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  [key: string]: unknown;
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const X_CMS_PREFIX = "x-cms-";

/**
 * Plan-12 U6: merge the hand-rolled OpenAPI spec with the registry-derived
 * spec produced by `app.getOpenAPI31Document()`. The registry covers the
 * routes migrated via Gap-F's `createRoute` declarations (per
 * `migratedContentRoutePaths`); the hand-rolled spec covers everything else
 * (auth, admin, media, GraphQL, locale, schedule, etc.).
 *
 * For paths present in BOTH specs, the registry entry is used as the base
 * (so the spec stays in lock-step with the route handlers) and the rich
 * `x-cms-*` extensions plus the longer hand-rolled `description` / `summary`
 * are merged in so test assertions and the admin UI continue to see filter,
 * sort, populate, and relation metadata that the registry does not yet
 * capture. Hand-rolled-only parameters (locale, fallback, populate, sort,
 * filters, pagination, etc.) are also appended, since the registry's
 * `createRoute` calls intentionally declare no query schema today.
 *
 * Components are unioned. The hand-rolled component schemas (produced by
 * `generateOpenAPISchemas`) carry the real shape of each collection; the
 * registry registers same-named stubs (`z.looseObject({})`) just to make
 * `$ref` resolution valid. Hand-rolled therefore wins on schema name
 * conflicts so callers keep seeing the real property definitions.
 */
export function mergeOpenAPISpec(handRolled: OpenAPISpec, registry: OpenAPISpec): OpenAPISpec {
  const handPaths = handRolled.paths ?? {};
  const registryPaths = registry.paths ?? {};
  const mergedPaths: Record<string, Record<string, unknown>> = {};

  const allPathKeys = new Set<string>([...Object.keys(handPaths), ...Object.keys(registryPaths)]);
  for (const pathKey of allPathKeys) {
    const handItem = handPaths[pathKey];
    const registryItem = registryPaths[pathKey];
    if (handItem && registryItem) {
      mergedPaths[pathKey] = mergePathItem(handItem, registryItem);
    } else if (registryItem) {
      mergedPaths[pathKey] = registryItem;
    } else if (handItem) {
      mergedPaths[pathKey] = handItem;
    }
  }

  const handSchemas = handRolled.components?.schemas ?? {};
  const registrySchemas = registry.components?.schemas ?? {};
  const mergedSchemas: Record<string, unknown> = { ...registrySchemas };
  // Hand-rolled wins on schema conflicts: the hand-rolled component schemas
  // from `generateOpenAPISchemas` carry the full property shape, while the
  // registry only registers loose-object placeholders for the same names.
  for (const [name, schema] of Object.entries(handSchemas)) {
    mergedSchemas[name] = schema;
  }

  const securitySchemes = {
    ...(registry.components?.securitySchemes ?? {}),
    ...(handRolled.components?.securitySchemes ?? {})
  };

  return {
    ...registry,
    ...handRolled,
    info: { ...(registry.info ?? {}), ...(handRolled.info ?? {}) },
    paths: mergedPaths,
    components: {
      ...(registry.components ?? {}),
      ...(handRolled.components ?? {}),
      schemas: mergedSchemas,
      securitySchemes
    }
  };
}

function mergePathItem(handItem: Record<string, unknown>, registryItem: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...handItem, ...registryItem };
  const allKeys = new Set<string>([...Object.keys(handItem), ...Object.keys(registryItem)]);
  for (const key of allKeys) {
    if (!HTTP_METHODS.has(key.toLowerCase())) continue;
    const handOp = handItem[key];
    const registryOp = registryItem[key];
    if (isRecord(handOp) && isRecord(registryOp)) {
      merged[key] = mergeOperation(handOp, registryOp);
    } else if (registryOp !== undefined) {
      merged[key] = registryOp;
    } else if (handOp !== undefined) {
      merged[key] = handOp;
    }
  }
  return merged;
}

function mergeOperation(handOp: Record<string, unknown>, registryOp: Record<string, unknown>): Record<string, unknown> {
  // Registry wins on parameters/responses/requestBody/operationId/tags/security.
  // Hand-rolled wins on description/summary so the richer copy survives.
  // Any x-cms-* extensions on the hand-rolled operation flow through.
  const merged: Record<string, unknown> = { ...registryOp };

  if (typeof handOp.summary === "string" && handOp.summary.length > 0) {
    merged.summary = handOp.summary;
  }
  if (typeof handOp.description === "string" && handOp.description.length > 0) {
    merged.description = handOp.description;
  }

  if (!merged.operationId && typeof handOp.operationId === "string") {
    merged.operationId = handOp.operationId;
  }

  for (const [key, value] of Object.entries(handOp)) {
    if (key.startsWith(X_CMS_PREFIX) && !(key in merged)) {
      merged[key] = value;
    }
  }

  merged.parameters = mergeParameters(handOp.parameters, registryOp.parameters);

  return merged;
}

function mergeParameters(handParams: unknown, registryParams: unknown): unknown[] | undefined {
  const handList = Array.isArray(handParams) ? handParams : [];
  const registryList = Array.isArray(registryParams) ? registryParams : [];
  if (handList.length === 0 && registryList.length === 0) return undefined;

  const keyFor = (param: unknown): string | null => {
    if (!isRecord(param)) return null;
    const name = typeof param.name === "string" ? param.name : null;
    const location = typeof param.in === "string" ? param.in : null;
    if (!name || !location) return null;
    return `${location}:${name}`;
  };

  // Start with registry parameters as the base. For each registry parameter
  // that has a matching hand-rolled parameter by `(in, name)`, layer the
  // hand-rolled `description` / `x-cms-*` extensions on top so the rich
  // filter/sort/relation metadata is preserved. Then append any hand-rolled
  // parameters the registry doesn't declare (the migrated `createRoute`
  // calls deliberately omit query schemas today; the hand-rolled list,
  // filter, sort, populate, locale, etc. parameters must still surface).
  const merged: unknown[] = [];
  const seen = new Set<string>();
  const handByKey = new Map<string, Record<string, unknown>>();
  for (const param of handList) {
    if (!isRecord(param)) continue;
    const key = keyFor(param);
    if (key) handByKey.set(key, param);
  }

  for (const param of registryList) {
    const key = keyFor(param);
    if (key && handByKey.has(key)) {
      const handMatch = handByKey.get(key)!;
      const registryRecord = isRecord(param) ? param : {};
      const layered: Record<string, unknown> = { ...registryRecord };
      if (typeof handMatch.description === "string" && handMatch.description.length > 0 && typeof layered.description !== "string") {
        layered.description = handMatch.description;
      }
      for (const [hk, hv] of Object.entries(handMatch)) {
        if (hk.startsWith(X_CMS_PREFIX) && !(hk in layered)) {
          layered[hk] = hv;
        }
      }
      merged.push(layered);
      seen.add(key);
    } else {
      merged.push(param);
      if (key) seen.add(key);
    }
  }

  for (const param of handList) {
    const key = keyFor(param);
    if (key && seen.has(key)) continue;
    merged.push(param);
  }

  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type OpenAPISpecOptions = {
  title?: string;
  version?: string;
  description?: string;
  graphql?: false | {
    path?: string;
    schemaPath?: string;
  };
  servers?: readonly {
    url: string;
    description?: string;
  }[];
};

export function createOpenAPISpec(collections: CMSCollections, options: OpenAPISpecOptions = {}): Record<string, unknown> {
  const schemas = {
    ...generateOpenAPISchemas(collections),
    Error: objectSchema({ error: { type: "string" }, issues: { type: "array", items: {} } }, ["error"]),
    PaginatedResponse: objectSchema({
      items: { type: "array", items: {} },
      nextCursor: { type: "string" },
      total: { type: "number" }
    }, ["items"]),
    LivenessReport: objectSchema({
      status: { type: "string", enum: ["ok"] },
      version: { type: "string" },
      uptime_seconds: { type: "number" }
    }, ["status", "version", "uptime_seconds"]),
    HealthCheck: objectSchema({
      status: { type: "string", enum: ["ok", "error"] },
      latency_ms: { type: "number" },
      error: { type: "string" },
      details: { type: "object", additionalProperties: true }
    }, ["status"]),
    HealthReport: objectSchema({
      status: { type: "string", enum: ["ok", "degraded"] },
      version: { type: "string" },
      uptime_seconds: { type: "number" },
      checks: { type: "object", additionalProperties: ref("HealthCheck") }
    }, ["status", "version", "uptime_seconds", "checks"]),
    SchemaFieldMetadata: objectSchema({
      kind: { type: "string", enum: ["string", "text", "richtext", "number", "boolean", "datetime", "date", "time", "json", "email", "url", "password", "uid", "enum", "media", "relation"] },
      required: { type: "boolean" },
      unique: { type: "boolean" },
      localized: { type: "boolean" },
      private: { type: "boolean" },
      min: { type: "number" },
      max: { type: "number" },
      int: { type: "boolean" },
      values: { type: "array", items: { type: "string" } },
      multiple: { type: "boolean" },
      target: { type: "string" },
      targetField: { type: "string" },
      cardinality: { type: "string", enum: ["one", "many", "one-to-one", "many-to-one", "one-to-many", "many-to-many"] },
      inverse: { type: "string" },
      onDelete: { type: "string", enum: ["cascade", "restrict", "set_null"] },
      permissions: {
        type: "object",
        properties: {
          read: { type: "array", items: { type: "string" } },
          write: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
      default: {}
    }, ["kind", "required", "unique", "localized", "private"]),
    SchemaI18nOptions: objectSchema({
      locales: { type: "array", items: { type: "string" } },
      defaultLocale: { type: "string" }
    }, ["locales", "defaultLocale"]),
    SchemaCollectionOptions: objectSchema({
      draftAndPublish: { type: "boolean" },
      timestamps: { type: "boolean" },
      i18n: ref("SchemaI18nOptions"),
      rbac: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } }
    }),
    SchemaCollectionMetadata: objectSchema({
      name: { type: "string" },
      fields: { type: "object", additionalProperties: ref("SchemaFieldMetadata") },
      options: ref("SchemaCollectionOptions")
    }, ["name", "fields", "options"]),
    SchemaMetadata: objectSchema({
      collections: { type: "object", additionalProperties: ref("SchemaCollectionMetadata") }
    }, ["collections"]),
    ContentTypeCapabilities: objectSchema({
      writable: { type: "boolean" },
      mode: { type: "string", enum: ["development", "read-only"] },
      endpoints: { type: "object", additionalProperties: { type: "string" } }
    }, ["writable", "mode"]),
    ContentTypeListResponse: objectSchema({
      collections: { type: "object", additionalProperties: ref("SchemaCollectionMetadata") },
      capabilities: ref("ContentTypeCapabilities")
    }, ["collections", "capabilities"]),
    ContentTypeInput: objectSchema({
      name: { type: "string" },
      fields: { type: "object", additionalProperties: ref("SchemaFieldMetadata") },
      options: ref("SchemaCollectionOptions")
    }, ["name", "fields"]),
    ContentTypeWriteResponse: objectSchema({
      collection: ref("SchemaCollectionMetadata"),
      source: { type: "string" },
      path: { type: "string" },
      artifacts: { type: "array", items: { type: "string" } },
      migrations: { type: "array", items: { type: "string" } },
      message: { type: "string" }
    }, ["collection"]),
    PreviewTokenRequest: objectSchema({
      collection: { type: "string" },
      documentId: { type: "string" }
    }, ["collection", "documentId"]),
    PreviewToken: objectSchema({
      token: { type: "string" },
      expiresAt: { type: "string", format: "date-time" },
      previewUrl: { type: "string" }
    }, ["token", "expiresAt", "previewUrl"]),
    ScheduleRequest: objectSchema({ publishAt: { type: "string", format: "date-time" } }, ["publishAt"]),
    AuditEntry: objectSchema({
      id: { type: "string" },
      operation: { type: "string", enum: ["create", "update", "delete", "publish", "unpublish", "media_upload", "media_delete", "schema_change"] },
      collection: { type: "string" },
      documentId: { type: "string" },
      actorId: { type: "string" },
      actorRoles: { type: "array", items: { type: "string" } },
      requestId: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      diff: objectSchema({
        before: { type: ["object", "null"], additionalProperties: true },
        after: { type: ["object", "null"], additionalProperties: true }
      }, ["before", "after"])
    }, ["id", "operation", "actorRoles", "requestId", "createdAt", "diff"]),
    Webhook: objectSchema({
      id: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      events: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
      secret: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }, ["id", "name", "url", "events", "enabled", "createdAt", "updatedAt"]),
    WebhookListItem: objectSchema({
      id: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      events: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      hasSecret: { type: "boolean" },
      lastDeliveryAt: { type: ["string", "null"], format: "date-time" },
      lastDeliveryStatus: { type: ["string", "null"], enum: ["pending", "success", "retrying", "failed", null] }
    }, ["id", "name", "url", "events", "enabled", "createdAt", "updatedAt", "hasSecret", "lastDeliveryAt", "lastDeliveryStatus"]),
    WebhookListResponse: objectSchema({
      items: { type: "array", items: ref("WebhookListItem") },
      meta: objectSchema({ total: { type: "number" } }, ["total"])
    }, ["items", "meta"]),
    WebhookInput: objectSchema({
      name: { type: "string" },
      url: { type: "string" },
      events: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
      secret: { type: "string" }
    }, ["name", "url", "events"]),
    WebhookUpdateInput: objectSchema({
      name: { type: "string" },
      url: { type: "string" },
      events: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
      secret: { type: ["string", "null"] }
    }),
    WebhookDelivery: objectSchema({
      id: { type: "string" },
      webhookId: { type: ["string", "null"] },
      eventType: { type: "string" },
      url: { type: "string" },
      attempt: { type: "number" },
      status: { type: "string", enum: ["pending", "success", "retrying", "failed"] },
      requestBody: { type: "string" },
      responseStatus: { type: "number" },
      responseBody: { type: "string" },
      error: { type: "string" },
      nextAttemptAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" }
    }, ["id", "webhookId", "eventType", "url", "attempt", "status", "requestBody", "createdAt"]),
    AuthUser: objectSchema({
      id: { type: "string" },
      roles: { type: "array", items: { type: "string" } }
    }, ["id", "roles"]),
    AuthLoginRequest: objectSchema({
      token: { type: "string" },
      apiKey: { type: "string" },
      key: { type: "string" }
    }),
    AuthLoginResponse: objectSchema({
      ok: { type: "boolean", enum: [true] },
      provider: { type: "string", enum: ["static-token", "api-key"] },
      token: { type: "string" },
      user: ref("AuthUser")
    }, ["ok", "provider", "token", "user"]),
    AuthSessionResponse: objectSchema({
      ok: { type: "boolean", enum: [true] },
      authenticated: { type: "boolean" },
      user: { oneOf: [ref("AuthUser"), { type: "null" }] }
    }, ["ok", "authenticated", "user"]),
    AuthProviderResponse: objectSchema({
      provider: { type: "string", enum: ["static-token", "api-key"] },
      headerName: { type: "string" }
    }, ["provider"]),
    ApiKey: objectSchema({
      id: { type: "string" },
      name: { type: "string" },
      userId: { type: "string" },
      roles: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
      prefix: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      lastUsedAt: { type: "string", format: "date-time" }
    }, ["id", "userId", "roles", "enabled"]),
    ApiKeyInput: objectSchema({
      name: { type: "string" },
      userId: { type: "string" },
      roles: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" }
    }, ["userId", "roles"]),
    ApiKeyUpdateInput: objectSchema({
      name: { type: "string" },
      roles: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" }
    }),
    ApiKeyCreateResponse: objectSchema({
      id: { type: "string" },
      name: { type: "string" },
      userId: { type: "string" },
      roles: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
      prefix: { type: "string" },
      secret: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }, ["id", "userId", "roles", "enabled", "secret"]),
    ApiKeyListResponse: objectSchema({
      items: { type: "array", items: ref("ApiKey") },
      meta: objectSchema({ total: { type: "number" } }, ["total"])
    }, ["items", "meta"]),
    Organization: objectSchema({
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      plan: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }, ["id", "name", "slug"]),
    OrganizationInput: objectSchema({
      name: { type: "string" },
      slug: { type: "string" },
      plan: { type: "string" }
    }, ["name", "slug"]),
    OrganizationMember: objectSchema({
      id: { type: "string" },
      email: { type: "string", format: "email" },
      name: { type: "string" },
      role: { type: "string" },
      status: { type: "string", enum: ["active", "pending", "disabled"] },
      joinedAt: { type: "string", format: "date-time" }
    }, ["id", "email", "role", "status"]),
    OrganizationMemberInput: objectSchema({
      role: { type: "string" },
      status: { type: "string", enum: ["active", "pending", "disabled"] }
    }, ["role", "status"]),
    OrganizationMemberListResponse: objectSchema({
      items: { type: "array", items: ref("OrganizationMember") },
      meta: objectSchema({ total: { type: "number" } }, ["total"])
    }, ["items", "meta"]),
    OrganizationInvitation: objectSchema({
      id: { type: "string" },
      email: { type: "string", format: "email" },
      role: { type: "string" },
      status: { type: "string", enum: ["pending", "accepted", "revoked", "expired"] },
      expiresAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" }
    }, ["id", "email", "role", "status"]),
    OrganizationInvitationInput: objectSchema({
      email: { type: "string", format: "email" },
      role: { type: "string" }
    }, ["email", "role"]),
    OrganizationInvitationListResponse: objectSchema({
      items: { type: "array", items: ref("OrganizationInvitation") },
      meta: objectSchema({ total: { type: "number" } }, ["total"])
    }, ["items", "meta"]),
    Media: objectSchema({
      id: { type: "string" },
      key: { type: "string" },
      url: { type: "string" },
      filename: { type: "string" },
      size: { type: "number" },
      contentType: { type: "string" },
      metadata: { type: "object", additionalProperties: { type: "string" } },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }, ["id", "key", "url", "filename", "size", "createdAt", "updatedAt"]),
    MediaPresignRequest: mediaUploadRequestSchema({
      filename: { type: "string" },
      contentType: { type: "string" },
      mimeType: { type: "string" },
      size: { type: "number" }
    }, ["filename", "size"]),
    MediaPresign: objectSchema({
      uploadId: { type: "string" },
      uploadUrl: { type: "string" },
      method: { type: "string", enum: ["PUT", "POST"] },
      key: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      expiresAt: { type: "string", format: "date-time" }
    }, ["uploadId", "uploadUrl", "method", "key", "expiresAt"]),
    MediaConfirmRequest: mediaUploadRequestSchema({
      uploadId: { type: "string" },
      key: { type: "string" },
      filename: { type: "string" },
      contentType: { type: "string" },
      mimeType: { type: "string" },
      size: { type: "number" },
      metadata: { type: "object", additionalProperties: { type: "string" } }
    }, ["uploadId", "key", "filename", "size"]),
    TranslateRequest: objectSchema({
      targetLocale: { type: "string" },
      sourceLocale: { type: "string" }
    }, ["targetLocale"]),
    LocaleReviewRequest: objectSchema({
      translatedBy: { type: "string", enum: ["human"] }
    }, ["translatedBy"]),
    LocaleVariantUpdateRequest: objectSchema({
      fields: { type: "object", additionalProperties: true }
    }, ["fields"]),
    I18nBackfillRequest: objectSchema({
      locale: { type: "string" },
      collection: { type: "string" }
    }, ["locale"]),
    I18nBackfillCollectionResult: objectSchema({
      collection: { type: "string" },
      total: { type: "number" },
      missing: { type: "number" },
      pending: { type: "number" },
      inProgress: { type: "number" },
      complete: { type: "number" },
      error: { type: "number" }
    }, ["collection", "total", "missing", "pending", "inProgress", "complete", "error"]),
    I18nBackfillResponse: objectSchema({
      status: { type: "string", enum: ["enqueued"] },
      locale: { type: "string" },
      collection: { type: "string" },
      jobCount: { type: "number" },
      collections: { type: "object", additionalProperties: { type: "number" } }
    }, ["status", "locale", "jobCount", "collections"]),
    I18nBackfillStatus: objectSchema({
      locale: { type: "string" },
      collection: { type: "string" },
      totals: ref("I18nBackfillCollectionResult"),
      collections: { type: "array", items: ref("I18nBackfillCollectionResult") }
    }, ["locale", "totals", "collections"]),
    LocaleState: objectSchema({
      locale: { type: "string" },
      status: { type: "string", enum: ["missing", "pending", "in_progress", "complete", "error"] },
      translatedBy: { type: "string", enum: ["ai", "human", "pending"] },
      translatedAt: { type: "string", format: "date-time" },
      error: { type: "string" }
    }, ["locale", "status", "translatedBy"]),
    LocaleStatus: objectSchema({
      defaultLocale: { type: "string" },
      locales: { type: "array", items: ref("LocaleState") }
    }, ["defaultLocale", "locales"]),
    TranslationVariant: objectSchema({
      id: { type: "string" },
      collection: { type: "string" },
      documentId: { type: "string" },
      locale: { type: "string" },
      fields: { type: "object", additionalProperties: true },
      status: { type: "string", enum: ["pending", "in_progress", "complete", "error"] },
      translatedBy: { type: "string", enum: ["ai", "human", "pending"] },
      sourceUpdatedAt: { type: "string", format: "date-time" },
      error: { type: "string" },
      provider: { type: "string" },
      translatedAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }, ["id", "collection", "documentId", "locale", "fields", "status", "translatedBy", "createdAt", "updatedAt"])
  };

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "Hono CMS API",
      version: options.version ?? "0.1.0",
      description: options.description ?? "Headless CMS API for content, media, schema metadata, and operator workflows.",
      "x-cms-filter-syntax": {
        style: "qs",
        description: "Strapi-compatible bracket query strings are parsed with qs. Use filters[field][operator]=value for simple filters and nested bracket paths for relation filters.",
        examples: {
          simple: "filters[title][$contains]=cms",
          nested: "filters[author][name][$startsWith]=Ada",
          multiValue: "filters[status][$in][]=draft&filters[status][$in][]=published",
          buildQuery: "qs.stringify({ filters: { title: { $contains: 'cms' } } }, { encodeValuesOnly: true, arrayFormat: 'brackets' })"
        }
      }
    },
    servers: normalizeServers(options.servers),
    tags: [
      { name: "auth" },
      { name: "health" },
      { name: "schema" },
      ...(options.graphql === false ? [] : [{ name: "graphql" }]),
      { name: "media" },
      { name: "preview" },
      { name: "audit" },
      { name: "content-types" },
      { name: "webhooks" },
      { name: "organization" },
      { name: "api-keys" },
      ...Object.values(collections).map((collection) => ({ name: collection.name }))
    ],
    paths: {
      ...contentPaths(collections),
      ...systemPaths({ graphql: options.graphql === false ? false : options.graphql ?? {} })
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" }
      },
      schemas
    }
  };
}

function contentPaths(collections: CMSCollections): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const collection of Object.values(collections)) {
    const schemaName = pascal(collection.name);
    const createSchemaName = `${schemaName}CreateInput`;
    const updateSchemaName = `${schemaName}UpdateInput`;
    paths[`/api/${collection.name}`] = {
      get: op(collection.name, `List ${collection.name}`, {
        parameters: queryParameters(collection),
        responses: {
          "200": jsonResponse("List content records", paginatedRef(schemaName)),
          "403": errorResponse("Forbidden")
        }
      }),
      post: op(collection.name, `Create ${collection.name}`, {
        security: bearerSecurity(),
        requestBody: jsonBody(ref(createSchemaName)),
        responses: {
          "201": jsonResponse("Create content record", ref(schemaName)),
          "403": errorResponse("Forbidden"),
          "422": errorResponse("Validation error")
        }
      })
    };
    paths[`/api/${collection.name}/{id}`] = {
      get: op(collection.name, `Get ${collection.name} record`, {
        parameters: [...idParameter(), ...readParameters(collection)],
        responses: {
          "200": jsonResponse("Get content record", ref(schemaName)),
          "404": errorResponse("Not found")
        }
      }),
      patch: op(collection.name, `Update ${collection.name} record`, {
        security: bearerSecurity(),
        parameters: idParameter(),
        requestBody: jsonBody(ref(updateSchemaName)),
        responses: {
          "200": jsonResponse("Update content record", ref(schemaName)),
          "403": errorResponse("Forbidden"),
          "422": errorResponse("Validation error")
        }
      }),
      delete: op(collection.name, `Delete ${collection.name} record`, {
        security: bearerSecurity(),
        parameters: idParameter(),
        responses: {
          "204": { description: "Delete content record" },
          "403": errorResponse("Forbidden")
        }
      })
    };
    if (collection.options.draftAndPublish) {
      paths[`/api/${collection.name}/{id}/publish`] = workflowPath(collection.name, schemaName, "Publish content record");
      paths[`/api/${collection.name}/{id}/unpublish`] = workflowPath(collection.name, schemaName, "Unpublish content record");
      paths[`/api/${collection.name}/{id}/schedule`] = {
        post: op(collection.name, "Schedule content record publication", {
          security: bearerSecurity(),
          parameters: idParameter(),
          requestBody: jsonBody(ref("ScheduleRequest")),
          responses: {
            "200": jsonResponse("Schedule content record publication", ref(schemaName)),
            "403": errorResponse("Forbidden"),
            "422": errorResponse("Validation error")
          }
        })
      };
      paths[`/api/${collection.name}/{id}/unschedule`] = workflowPath(collection.name, schemaName, "Remove scheduled publication");
    }
    if (collection.options.i18n) {
      paths[`/api/${collection.name}/{id}/locales`] = {
        get: op(collection.name, `List ${collection.name} locale status`, {
          security: bearerSecurity(),
          parameters: idParameter(),
          responses: {
            "200": jsonResponse("Locale status", ref("LocaleStatus")),
            "400": errorResponse("i18n is not enabled"),
            "403": errorResponse("Forbidden"),
            "404": errorResponse("Not found")
          }
        })
      };
      paths[`/api/${collection.name}/{id}/locales/{locale}`] = {
        patch: op(collection.name, `Review ${collection.name} locale variant`, {
          security: bearerSecurity(),
          parameters: [...idParameter(), { name: "locale", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody(ref("LocaleReviewRequest")),
          responses: {
            "200": jsonResponse("Translation variant", ref("TranslationVariant")),
            "400": errorResponse("i18n is not enabled"),
            "403": errorResponse("Forbidden"),
            "404": errorResponse("Not found"),
            "422": errorResponse("Validation error")
          }
        }),
        put: op(collection.name, `Update ${collection.name} locale variant`, {
          security: bearerSecurity(),
          parameters: [...idParameter(), { name: "locale", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody(ref("LocaleVariantUpdateRequest")),
          responses: {
            "200": jsonResponse("Translation variant", ref("TranslationVariant")),
            "400": errorResponse("i18n is not enabled"),
            "403": errorResponse("Forbidden"),
            "404": errorResponse("Not found"),
            "422": errorResponse("Validation error")
          }
        })
      };
      paths[`/api/${collection.name}/{id}/translate`] = {
        post: op(collection.name, `Translate ${collection.name} record`, {
          security: bearerSecurity(),
          parameters: idParameter(),
          requestBody: jsonBody(ref("TranslateRequest")),
          responses: {
            "200": jsonResponse("Translation variant", ref("TranslationVariant")),
            "400": errorResponse("i18n is not enabled"),
            "403": errorResponse("Forbidden"),
            "404": errorResponse("Not found"),
            "422": errorResponse("Validation error"),
            "503": errorResponse("Translation provider not configured")
          }
        })
      };
    }
  }
  return paths;
}

function systemPaths(options: { graphql: false | { path?: string; schemaPath?: string } }): Record<string, unknown> {
  return {
    "/api/auth/login": {
      post: op("auth", "Authenticate CMS session", {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                allOf: [ref("AuthLoginRequest")],
                description: "Static-token auth accepts token. API-key auth accepts token, apiKey, or key."
              }
            }
          }
        },
        responses: {
          "200": jsonResponse("Authenticated session", ref("AuthLoginResponse")),
          "401": errorResponse("Invalid credentials"),
          "429": errorResponse("Rate limit exceeded")
        }
      })
    },
    "/api/auth/session": {
      get: op("auth", "Get CMS auth session", {
        security: bearerSecurity(),
        responses: {
          "200": jsonResponse("Current auth session", ref("AuthSessionResponse")),
          "429": errorResponse("Rate limit exceeded")
        }
      })
    },
    "/api/auth/{action}": {
      get: op("auth", "Get CMS auth provider action", {
        parameters: authActionParameters(),
        responses: {
          "200": jsonResponse("Auth provider response", {
            oneOf: [ref("AuthSessionResponse"), ref("AuthProviderResponse")]
          }),
          "429": errorResponse("Rate limit exceeded")
        }
      }),
      post: op("auth", "Run CMS auth provider action", {
        parameters: authActionParameters(),
        requestBody: jsonBody(ref("AuthLoginRequest")),
        responses: {
          "200": jsonResponse("Auth provider response", {
            oneOf: [ref("AuthLoginResponse"), ref("AuthProviderResponse"), ref("AuthSessionResponse")]
          }),
          "401": errorResponse("Invalid credentials"),
          "429": errorResponse("Rate limit exceeded")
        }
      })
    },
    "/cms/health/live": {
      get: op("health", "Liveness check", { responses: { "200": jsonResponse("Live", ref("LivenessReport")) } })
    },
    "/cms/health": {
      get: op("health", "Dependency health check", { responses: { "200": jsonResponse("Healthy", ref("HealthReport")), "503": jsonResponse("Degraded", ref("HealthReport")) } })
    },
    "/cms/health/ready": {
      get: op("health", "Readiness check", { responses: { "200": jsonResponse("Ready", ref("HealthReport")), "503": jsonResponse("Not ready", ref("HealthReport")) } })
    },
    "/cms/schema": {
      get: op("schema", "Get CMS schema metadata", {
        security: bearerSecurity(),
        responses: {
          "200": jsonResponse("CMS schema metadata", ref("SchemaMetadata")),
          "403": errorResponse("Forbidden")
        }
      })
    },
    "/cms/content-types/capabilities": {
      get: op("content-types", "Get content type builder capabilities", {
        security: bearerSecurity(),
        responses: {
          "200": jsonResponse("Content type builder capabilities", ref("ContentTypeCapabilities")),
          "403": errorResponse("Forbidden")
        }
      })
    },
    "/cms/content-types": {
      get: op("content-types", "List content types", {
        security: bearerSecurity(),
        responses: {
          "200": jsonResponse("Content types", ref("ContentTypeListResponse")),
          "403": errorResponse("Forbidden")
        }
      }),
      post: op("content-types", "Create content type", {
        security: bearerSecurity(),
        requestBody: jsonBody(ref("ContentTypeInput")),
        responses: {
          "201": jsonResponse("Content type written", ref("ContentTypeWriteResponse")),
          "403": errorResponse("Forbidden or read-only"),
          "409": errorResponse("Collection exists"),
          "422": errorResponse("Validation error")
        }
      })
    },
    "/cms/content-types/{name}": {
      put: op("content-types", "Update content type", {
        security: bearerSecurity(),
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: jsonBody(ref("ContentTypeInput")),
        responses: {
          "200": jsonResponse("Content type written", ref("ContentTypeWriteResponse")),
          "403": errorResponse("Forbidden or read-only"),
          "404": errorResponse("Not found"),
          "409": errorResponse("Collection exists"),
          "422": errorResponse("Validation error")
        }
      }),
      delete: op("content-types", "Delete content type", {
        security: bearerSecurity(),
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": jsonResponse("Content type removed", ref("ContentTypeWriteResponse")),
          "403": errorResponse("Forbidden or read-only"),
          "404": errorResponse("Not found"),
          "501": errorResponse("Writer cannot remove collections")
        }
      })
    },
    ...graphQLPaths(options.graphql),
    "/api/media": {
      get: op("media", "List media objects", {
        security: bearerSecurity(),
        parameters: [
          query("q"),
          query("search"),
          query("type", { type: "string", enum: ["image", "video", "audio", "document", "other"] }),
          query("from", { type: "string", format: "date-time" }),
          query("to", { type: "string", format: "date-time" }),
          query("cursor"),
          query("limit", { type: "integer", minimum: 1, maximum: 100 })
        ],
        responses: { "200": jsonResponse("Media objects", paginatedRef("Media")), "403": errorResponse("Forbidden") }
      }),
      post: op("media", "Upload media object", {
        security: bearerSecurity(),
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } },
            "application/octet-stream": { schema: { type: "string", format: "binary" } }
          }
        },
        responses: {
          "201": jsonResponse("Media object", ref("Media")),
          "400": errorResponse("Upload failed"),
          "403": errorResponse("Forbidden"),
          "503": errorResponse("Storage not configured")
        }
      })
    },
    "/api/media/{id}": {
      get: op("media", "Get media metadata", {
        security: bearerSecurity(),
        parameters: idParameter(),
        responses: { "200": jsonResponse("Media object", ref("Media")), "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }
      }),
      delete: op("media", "Delete media object", {
        security: bearerSecurity(),
        parameters: idParameter(),
        responses: { "204": { description: "Media object deleted" }, "403": errorResponse("Forbidden") }
      })
    },
    "/api/media/presign": {
      post: op("media", "Create direct media upload URL", {
        security: bearerSecurity(),
        requestBody: jsonBody(ref("MediaPresignRequest")),
        responses: {
          "200": jsonResponse("Media presign session", ref("MediaPresign")),
          "400": errorResponse("Presign failed"),
          "403": errorResponse("Forbidden"),
          "503": errorResponse("Storage not configured")
        }
      })
    },
    "/api/media/confirm": {
      post: op("media", "Confirm direct media upload", {
        security: bearerSecurity(),
        requestBody: jsonBody(ref("MediaConfirmRequest")),
        responses: {
          "201": jsonResponse("Media object", ref("Media")),
          "400": errorResponse("Confirm failed"),
          "403": errorResponse("Forbidden"),
          "422": errorResponse("Validation error"),
          "503": errorResponse("Storage not configured")
        }
      })
    },
    "/api/media/{id}/file": {
      get: op("media", "Download media object", {
        security: bearerSecurity(),
        parameters: idParameter(),
        responses: { "200": { description: "Media object bytes" }, "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }
      })
    },
    "/api/preview-tokens": {
      post: op("preview", "Issue a draft preview token", {
        security: bearerSecurity(),
        requestBody: jsonBody(ref("PreviewTokenRequest")),
        responses: {
          "200": jsonResponse("Preview token", ref("PreviewToken")),
          "403": errorResponse("Forbidden"),
          "422": errorResponse("Validation error")
        }
      })
    },
    "/api/preview-tokens/{token}": {
      delete: op("preview", "Revoke a draft preview token", {
        security: bearerSecurity(),
        parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "Preview token revoked" },
          "403": errorResponse("Forbidden")
        }
      })
    },
    "/cms/admin/i18n/backfill": {
      post: op("i18n", "Backfill translated locale variants", {
        security: bearerSecurity(),
        requestBody: jsonBody(ref("I18nBackfillRequest")),
        responses: {
          "200": jsonResponse("Translation backfill jobs enqueued", ref("I18nBackfillResponse")),
          "400": errorResponse("i18n is not enabled"),
          "403": errorResponse("Forbidden"),
          "422": errorResponse("Validation error"),
          "503": errorResponse("Translation provider or jobs not configured")
        }
      })
    },
    "/cms/admin/i18n/backfill/status": {
      get: op("i18n", "Get i18n backfill status", {
        security: bearerSecurity(),
        parameters: [
          { name: "locale", in: "query", required: true, schema: { type: "string" } },
          query("collection")
        ],
        responses: {
          "200": jsonResponse("Translation backfill status", ref("I18nBackfillStatus")),
          "400": errorResponse("i18n is not enabled"),
          "403": errorResponse("Forbidden"),
          "422": errorResponse("Validation error")
        }
      })
    },
    "/cms/audit-log": {
      get: op("audit", "List audit log entries", {
        security: bearerSecurity(),
        parameters: [
          query("collection"),
          query("documentId"),
          query("operation"),
          query("actorId"),
          query("from", { type: "string", format: "date-time" }),
          query("to", { type: "string", format: "date-time" }),
          query("cursor"),
          query("format", { type: "string", enum: ["json", "csv"] }),
          query("limit", { type: "integer", minimum: 1, maximum: 100 })
        ],
        responses: {
          "200": {
            description: "Audit entries",
            content: {
              "application/json": { schema: paginatedRef("AuditEntry") },
              "text/csv": { schema: { type: "string" } }
            }
          },
          "403": errorResponse("Forbidden"),
          "422": errorResponse("Validation error")
        }
      })
    },
    "/cms/settings/webhooks": {
      get: op("webhooks", "List webhooks", { security: bearerSecurity(), responses: { "200": jsonResponse("Webhooks", ref("WebhookListResponse")), "403": errorResponse("Forbidden") } }),
      post: op("webhooks", "Create webhook", {
        security: bearerSecurity(),
        requestBody: jsonBody(ref("WebhookInput")),
        responses: { "201": jsonResponse("Webhook", ref("Webhook")), "403": errorResponse("Forbidden") }
      })
    },
    "/cms/settings/webhooks/{id}": {
      patch: op("webhooks", "Update webhook", {
        security: bearerSecurity(),
        parameters: idParameter(),
        requestBody: jsonBody(ref("WebhookUpdateInput")),
        responses: { "200": jsonResponse("Webhook", ref("Webhook")), "403": errorResponse("Forbidden") }
      }),
      put: op("webhooks", "Replace webhook settings", {
        security: bearerSecurity(),
        parameters: idParameter(),
        requestBody: jsonBody(ref("WebhookInput")),
        responses: { "200": jsonResponse("Webhook", ref("Webhook")), "403": errorResponse("Forbidden") }
      }),
      delete: op("webhooks", "Delete webhook", {
        security: bearerSecurity(),
        parameters: idParameter(),
        responses: { "204": { description: "Webhook deleted" }, "403": errorResponse("Forbidden") }
      })
    },
    "/cms/settings/webhooks/{id}/deliveries": {
      get: op("webhooks", "List webhook deliveries", {
        security: bearerSecurity(),
        parameters: [...idParameter(), query("cursor"), query("limit", { type: "integer", minimum: 1, maximum: 100 })],
        responses: { "200": jsonResponse("Webhook deliveries", paginatedRef("WebhookDelivery")), "403": errorResponse("Forbidden") }
      })
    },
    "/cms/settings/webhooks/{id}/deliveries/{deliveryId}/retry": {
      post: op("webhooks", "Retry failed webhook delivery", {
        security: bearerSecurity(),
        parameters: [...idParameter(), { name: "deliveryId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": jsonResponse("Webhook delivery", ref("WebhookDelivery")), "403": errorResponse("Forbidden"), "404": errorResponse("Not found"), "409": errorResponse("Delivery is not failed") }
      })
    },
    "/cms/settings/webhooks/{id}/test": {
      post: op("webhooks", "Send a webhook test delivery", {
        security: bearerSecurity(),
        parameters: idParameter(),
        responses: { "200": jsonResponse("Webhook delivery", ref("WebhookDelivery")), "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }
      })
    },
    "/cms/settings/api-keys": {
      get: op("api-keys", "List API keys", {
        security: bearerSecurity(),
        responses: { "200": jsonResponse("API keys", ref("ApiKeyListResponse")), "403": errorResponse("Forbidden") }
      }),
      post: op("api-keys", "Create API key", {
        security: bearerSecurity(),
        requestBody: jsonBody(ref("ApiKeyInput")),
        responses: { "201": jsonResponse("API key", ref("ApiKeyCreateResponse")), "400": errorResponse("Validation error"), "403": errorResponse("Forbidden"), "409": errorResponse("API key store not configured") }
      })
    },
    "/cms/settings/api-keys/{id}": {
      patch: op("api-keys", "Update API key", {
        security: bearerSecurity(),
        parameters: idParameter(),
        requestBody: jsonBody(ref("ApiKeyUpdateInput")),
        responses: { "200": jsonResponse("API key", ref("ApiKey")), "400": errorResponse("Validation error"), "403": errorResponse("Forbidden"), "404": errorResponse("Not found"), "409": errorResponse("API key store not configured") }
      }),
      delete: op("api-keys", "Delete API key", {
        security: bearerSecurity(),
        parameters: idParameter(),
        responses: { "204": { description: "API key deleted" }, "403": errorResponse("Forbidden"), "404": errorResponse("Not found"), "409": errorResponse("API key store not configured") }
      })
    },
    "/cms/settings/organization": {
      get: op("organization", "Get organization settings", {
        security: bearerSecurity(),
        responses: { "200": jsonResponse("Organization", ref("Organization")), "403": errorResponse("Forbidden") }
      }),
      put: op("organization", "Update organization settings", {
        security: bearerSecurity(),
        requestBody: jsonBody(ref("OrganizationInput")),
        responses: { "200": jsonResponse("Organization", ref("Organization")), "400": errorResponse("Validation error"), "403": errorResponse("Forbidden") }
      })
    },
    "/cms/settings/organization/members": {
      get: op("organization", "List organization members", {
        security: bearerSecurity(),
        responses: { "200": jsonResponse("Organization members", ref("OrganizationMemberListResponse")), "403": errorResponse("Forbidden") }
      })
    },
    "/cms/settings/organization/members/{id}": {
      patch: op("organization", "Update organization member", {
        security: bearerSecurity(),
        parameters: idParameter(),
        requestBody: jsonBody(ref("OrganizationMemberInput")),
        responses: { "200": jsonResponse("Organization member", ref("OrganizationMember")), "400": errorResponse("Validation error"), "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }
      }),
      delete: op("organization", "Remove organization member", {
        security: bearerSecurity(),
        parameters: idParameter(),
        responses: { "204": { description: "Organization member removed" }, "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }
      })
    },
    "/cms/settings/organization/invitations": {
      get: op("organization", "List organization invitations", {
        security: bearerSecurity(),
        responses: { "200": jsonResponse("Organization invitations", ref("OrganizationInvitationListResponse")), "403": errorResponse("Forbidden") }
      }),
      post: op("organization", "Create organization invitation", {
        security: bearerSecurity(),
        requestBody: jsonBody(ref("OrganizationInvitationInput")),
        responses: { "201": jsonResponse("Organization invitation", ref("OrganizationInvitation")), "400": errorResponse("Validation error"), "403": errorResponse("Forbidden") }
      })
    },
    "/cms/settings/organization/invitations/{id}/revoke": {
      post: op("organization", "Revoke organization invitation", {
        security: bearerSecurity(),
        parameters: idParameter(),
        responses: { "200": jsonResponse("Organization invitation", ref("OrganizationInvitation")), "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }
      })
    }
  };
}

function graphQLPaths(config: false | { path?: string; schemaPath?: string }): Record<string, unknown> {
  if (config === false) return {};
  const publicPath = config.path ?? "/graphql";
  const publicSchemaPath = config.schemaPath ?? `${publicPath.replace(/\/$/, "")}/schema`;
  const paths: Record<string, unknown> = {
    [publicPath]: graphQLOperations("executeGraphQLQuery"),
    [publicSchemaPath]: graphQLSchemaOperation("getGraphQLSDL")
  };
  if (!paths["/cms/graphql"]) paths["/cms/graphql"] = graphQLOperations("executeCMSGraphQLQuery");
  if (!paths["/cms/graphql/schema"]) paths["/cms/graphql/schema"] = graphQLSchemaOperation("getCMSGraphQLSDL");
  return paths;
}

function workflowPath(tag: string, schemaName: string, summary: string): Record<string, Operation> {
  return {
    post: op(tag, summary, {
      security: bearerSecurity(),
      parameters: idParameter(),
      responses: {
        "200": jsonResponse(summary, ref(schemaName)),
        "403": errorResponse("Forbidden"),
        "404": errorResponse("Not found")
      }
    })
  };
}

function graphQLOperations(operationPrefix: string): Record<string, unknown> {
  return {
    get: op("graphql", "Execute GraphQL query via GET", {
      operationId: `${operationPrefix}ViaGET`,
      parameters: [
        { name: "query", in: "query", schema: { type: "string" } },
        { name: "variables", in: "query", schema: { type: "string" } }
      ],
      responses: { "200": jsonResponse("GraphQL response", { type: "object" }), "400": errorResponse("Bad request") }
    }),
    post: op("graphql", "Execute GraphQL query via POST", {
      operationId: `${operationPrefix}ViaPOST`,
      requestBody: jsonBody(objectSchema({
        query: { type: "string" },
        variables: { type: "object", additionalProperties: true }
      }, ["query"])),
      responses: { "200": jsonResponse("GraphQL response", { type: "object" }), "400": errorResponse("Bad request") }
    })
  };
}

function graphQLSchemaOperation(operationIdValue: string): Record<string, unknown> {
  return {
    get: op("graphql", "Get GraphQL SDL", {
      operationId: operationIdValue,
      responses: { "200": { description: "GraphQL schema SDL", content: { "text/plain": { schema: { type: "string" } } } } }
    })
  };
}

function op(tag: string, summary: string, input: Omit<Operation, "tags" | "summary">): Operation {
  return { tags: [tag], summary, operationId: operationId(summary), ...input };
}

function idParameter(): unknown[] {
  return [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
}

function authActionParameters(): unknown[] {
  return [{
    name: "action",
    in: "path",
    required: true,
    description: "Provider-specific auth action mounted below /api/auth. Built-in providers support login and session; better-auth instances may expose additional actions.",
    schema: { type: "string", examples: ["login", "session", "get-session"] }
  }];
}

function queryParameters(collection: CMSCollections[string]): unknown[] {
  return [
    query("limit", { type: "integer", minimum: 1, maximum: 100 }),
    cursorParameter(),
    paginationParameter(),
    filtersParameter(collection),
    sortParameter(collection),
    query("status", { type: "string", enum: ["draft", "published", "archived"] }),
    localeParameter(collection),
    localeFallbackParameter(collection),
    populateParameter(collection),
    query("fields")
  ];
}

function cursorParameter(): unknown {
  return {
    name: "cursor",
    in: "query",
    required: false,
    description: "Opaque base64url cursor returned as nextCursor by the previous response.",
    schema: {
      type: "string",
      examples: ["eyJpZCI6ImFydGljbGVfMSIsImNyZWF0ZWRBdCI6IjIwMjYtMDUtMjJUMTA6MDA6MDAuMDAwWiJ9"]
    }
  };
}

function readParameters(collection: CMSCollections[string]): unknown[] {
  return [populateParameter(collection), query("fields"), localeParameter(collection), localeFallbackParameter(collection), query("preview")];
}

function query(name: string, schema: Record<string, unknown> = { type: "string" }): unknown {
  return { name, in: "query", required: false, schema };
}

function localeParameter(collection: CMSCollections[string]): unknown {
  const i18n = collection.options.i18n;
  return {
    name: "locale",
    in: "query",
    required: false,
    description: i18n
      ? `Locale code to read. Defaults to ${i18n.defaultLocale}.`
      : "Locale code to read. Ignored for collections without i18n enabled.",
    schema: i18n ? { type: "string", enum: i18n.locales, default: i18n.defaultLocale } : { type: "string" }
  };
}

function localeFallbackParameter(collection: CMSCollections[string]): unknown {
  const i18n = collection.options.i18n;
  return {
    name: "fallback",
    in: "query",
    required: false,
    description: i18n
      ? "Controls locale fallback. Set fallback=false to require the requested locale exactly instead of falling back through language and default locale variants."
      : "Controls locale fallback for i18n collections. Ignored for collections without i18n enabled.",
    schema: {
      type: "boolean",
      default: true
    },
    "x-cms-query-syntax": ["fallback=false", "locale=es-MX&fallback=false"]
  };
}

function paginationParameter(): unknown {
  return {
    name: "pagination",
    in: "query",
    required: false,
    description: "Cursor or offset pagination using bracket syntax. Cursor values are opaque base64url tokens returned as nextCursor by the previous response.",
    style: "deepObject",
    explode: true,
    schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    },
    "x-cms-query-syntax": ["pagination[limit]=25&pagination[cursor]=eyJpZCI6ImFydGljbGVfMSIsImNyZWF0ZWRBdCI6IjIwMjYtMDUtMjJUMTA6MDA6MDAuMDAwWiJ9", "pagination[page]=2&pagination[pageSize]=25"]
  };
}

function filtersParameter(collection: CMSCollections[string]): unknown {
  const filterFields = Object.entries(collection.fields)
    .filter(([, field]) => !field.private)
    .map(([name]) => name)
    .sort();
  return {
    name: "filters",
    in: "query",
    required: false,
    description: "Strapi-compatible filter object using bracket syntax, for example filters[title][$contains]=cms. Relation-nested filters can be sent with the same bracket style.",
    style: "deepObject",
    explode: true,
    schema: {
      type: "object",
      additionalProperties: {
        oneOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          {
            type: "object",
            additionalProperties: true
          }
        ]
      }
    },
    "x-cms-filter-fields": filterFields,
    "x-cms-filter-operators": ["$eq", "$ne", "$contains", "$notContains", "$startsWith", "$endsWith", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$null", "$notNull", "$between"],
    "x-cms-filter-examples": [
      `filters[${filterFields[0] ?? "title"}][$eq]=value`,
      `filters[${filterFields[0] ?? "title"}][$in]=draft,published`
    ]
  };
}

function sortParameter(collection: CMSCollections[string]): unknown {
  const sortFields = Object.entries(collection.fields)
    .filter(([, field]) => !field.private)
    .map(([name]) => name)
    .sort();
  const systemFields = ["id", "createdAt", "updatedAt", ...(collection.options.draftAndPublish ? ["status", "publishedAt"] : [])];
  const fields = [...sortFields, ...systemFields].sort();
  return {
    name: "sort",
    in: "query",
    required: false,
    description: "Comma-separated sort fields. Use field, -field, field:asc, or field:desc. Example: sort=createdAt:desc,title:asc.",
    style: "form",
    explode: false,
    schema: {
      type: "string",
      examples: ["createdAt:desc", "title:asc", "-updatedAt"]
    },
    "x-cms-sort-fields": fields,
    "x-cms-sort-directions": ["asc", "desc"],
    "x-cms-sort-examples": [
      `${fields[0] ?? "createdAt"}:asc`,
      `${fields[0] ?? "createdAt"}:desc`,
      `-${fields[0] ?? "createdAt"}`
    ]
  };
}

function populateParameter(collection: CMSCollections[string]): unknown {
  const relationKeys = Object.entries(collection.fields)
    .filter(([, field]) => field.kind === "relation" && !field.private)
    .map(([name]) => name)
    .sort();
  const values = ["*", ...relationKeys];
  return {
    name: "populate",
    in: "query",
    required: false,
    description: "Relations to populate. Supports comma-separated shorthand, repeated array syntax, and Strapi-compatible deep-object field selection such as populate[author][fields][0]=name.",
    style: "deepObject",
    explode: true,
    schema: {
      oneOf: [
        { type: "string", enum: values },
        { type: "array", items: { type: "string", enum: values }, uniqueItems: true },
        {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              fields: { type: "array", items: { type: "string" } },
              populate: { type: "object", additionalProperties: true }
            },
            additionalProperties: true
          }
        }
      ]
    },
    "x-cms-relations": relationKeys,
    "x-cms-query-syntax": [
      `populate=${relationKeys[0] ?? "*"}`,
      `populate[0]=${relationKeys[0] ?? "*"}`,
      `populate[${relationKeys[0] ?? "relation"}][fields][0]=name`
    ]
  };
}

function jsonBody(schema: unknown): unknown {
  return { required: true, content: { "application/json": { schema } } };
}

function jsonResponse(description: string, schema: unknown): unknown {
  return { description, content: { "application/json": { schema } } };
}

function errorResponse(description: string): unknown {
  return jsonResponse(description, ref("Error"));
}

function normalizeServers(servers: OpenAPISpecOptions["servers"]): Array<{ url: string; description?: string }> {
  return (servers?.length ? servers : [{ url: "/" }]).map((server) => {
    const normalized: { url: string; description?: string } = { url: server.url };
    if (server.description) normalized.description = server.description;
    return normalized;
  });
}

function ref(name: string): unknown {
  return { $ref: `#/components/schemas/${name}` };
}

function paginatedRef(name: string): unknown {
  return {
    allOf: [
      ref("PaginatedResponse"),
      { type: "object", properties: { items: { type: "array", items: ref(name) } } }
    ]
  };
}

function bearerSecurity(): Array<Record<string, string[]>> {
  return [{ bearerAuth: [] }];
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function mediaUploadRequestSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    ...objectSchema(properties, required),
    oneOf: [
      { required: ["contentType"] },
      { required: ["mimeType"] }
    ]
  };
}

function pascal(value: string): string {
  return value
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function operationId(summary: string): string {
  const words = summary
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const [first = "operation", ...rest] = words;
  return `${first.toLowerCase()}${rest.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join("")}`;
}
