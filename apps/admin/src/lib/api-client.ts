import qs from "qs";

export type AdminCollectionName = string;

export type AdminContentRecord = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  status?: "draft" | "published" | "archived";
  publishedAt?: string;
  scheduledAt?: string;
};

export class AdminApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, details?: unknown) {
    super(`Admin API request failed: ${status}`);
    this.name = "AdminApiError";
    this.status = status;
    this.details = details;
  }
}

export type PreviewToken = {
  token: string;
  url?: string;
  expiresAt?: string;
};

export type AdminHealthReport = {
  status: "ok" | "degraded";
  version: string;
  uptime_seconds: number;
  checks: Record<string, { status: "ok" | "error"; latency_ms?: number; error?: string }>;
};

export type AdminSchemaField = {
  kind: "string" | "text" | "richtext" | "number" | "boolean" | "datetime" | "date" | "time" | "json" | "email" | "url" | "password" | "uid" | "enum" | "media" | "relation" | "component" | "dynamiczone";
  required: boolean;
  unique: boolean;
  localized: boolean;
  private: boolean;
  min?: number;
  max?: number;
  int?: boolean;
  values?: readonly string[];
  multiple?: boolean;
  target?: string;
  targetField?: string;
  cardinality?: string;
  inverse?: string;
  onDelete?: string;
  permissions?: Record<string, readonly string[]>;
  default?: unknown;
  component?: string;
  repeatable?: boolean;
  components?: readonly string[];
};

export type AdminSchemaComponent = {
  name: string;
  fields: Record<string, AdminSchemaField>;
};

export type AdminSchemaCollection = {
  name: string;
  fields: Record<string, AdminSchemaField>;
  options: {
    draftAndPublish?: boolean;
    timestamps?: boolean;
    i18n?: { locales: readonly string[]; defaultLocale: string };
    rbac?: Record<string, readonly string[]>;
  };
};

export type AdminSchemaMetadata = {
  collections: Record<string, AdminSchemaCollection>;
  components?: Record<string, AdminSchemaComponent>;
};

export type RBACAction = "create" | "read" | "update" | "delete" | "publish";

export type RBACMatrixRule = {
  action: RBACAction;
  collection: string;
  roles: string[];
};

export type RBACMatrixCollection = {
  name: string;
  public: RBACAction[];
  authenticated: RBACAction[];
};

export type RBACMatrix = {
  roles: string[];
  rules: RBACMatrixRule[];
  collections: RBACMatrixCollection[];
  publicRead: boolean;
};

export type ContentTypeCapabilities = {
  writable: boolean;
  mode: "development" | "read-only" | string;
  endpoints?: Record<string, string>;
};

export type ContentTypeListResponse = AdminSchemaMetadata & {
  capabilities: ContentTypeCapabilities;
};

export type ContentTypeInput = {
  name: string;
  fields: Record<string, Partial<AdminSchemaField> & { kind: AdminSchemaField["kind"] }>;
  options?: AdminSchemaCollection["options"];
};

export type ContentTypeWriteResponse = {
  collection: AdminSchemaCollection;
  source?: string;
  path?: string;
  artifacts?: readonly string[];
  migrations?: readonly string[];
  message?: string;
};

export type AdminContentListOptions = {
  limit?: number;
  cursor?: string;
  status?: AdminContentRecord["status"];
  sort?: string;
  filters?: Record<string, AdminFilterValue>;
};

export type AdminFilterOperatorValue = string | number | boolean | readonly [string | number, string | number] | readonly (string | number)[];

export type AdminFilterValue =
  | string
  | number
  | boolean
  | {
      $eq?: string | number | boolean;
      $ne?: string | number | boolean;
      $contains?: string;
      $notContains?: string;
      $startsWith?: string;
      $endsWith?: string;
      $gt?: string | number;
      $gte?: string | number;
      $lt?: string | number;
      $lte?: string | number;
      $in?: readonly (string | number)[];
      $nin?: readonly (string | number)[];
      $null?: boolean;
      $notNull?: boolean;
      $between?: readonly [string | number, string | number];
      contains?: string;
    };

export type AdminContentListResult = {
  items: AdminContentRecord[];
  nextCursor?: string;
};

export type AuditEntry = {
  id: string;
  operation: string;
  collection?: string;
  documentId?: string;
  actorId?: string;
  actorRoles?: string[];
  requestId: string;
  diff?: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
  createdAt: string;
};

export type AuditLogOptions = {
  collection?: string;
  documentId?: string;
  operation?: string;
  actorId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
};

export type WebhookRecord = {
  id: string;
  name: string;
  url: string;
  events: readonly string[];
  enabled: boolean;
  secret?: "****" | string;
  createdAt?: string;
  updatedAt?: string;
  hasSecret?: boolean;
  lastDeliveryAt?: string | null;
  lastDeliveryStatus?: "pending" | "success" | "retrying" | "failed" | null;
};

export type WebhookInput = {
  name: string;
  url: string;
  events: string[];
  enabled?: boolean;
  secret?: string;
};

export type WebhookUpdateInput = Partial<Omit<WebhookInput, "secret">> & {
  secret?: string | null;
};

export type WebhookDelivery = {
  id: string;
  webhookId: string | null;
  eventType: string;
  url: string;
  attempt: number;
  status: "pending" | "success" | "retrying" | "failed";
  requestBody: string;
  responseStatus?: number;
  responseBody?: string;
  error?: string;
  nextAttemptAt?: string;
  createdAt: string;
};

export type ApiKeyRecord = {
  id: string;
  name?: string;
  userId: string;
  roles: readonly string[];
  enabled: boolean;
  prefix?: string;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
};

export type ApiKeyInput = {
  name?: string;
  userId: string;
  roles: string[];
  enabled?: boolean;
};

export type ApiKeyUpdateInput = Partial<Pick<ApiKeyInput, "name" | "roles" | "enabled">>;

export type ApiKeyCreateResponse = ApiKeyRecord & {
  secret: string;
};

export type AuthActionInput = {
  email?: string;
  password?: string;
  name?: string;
  token?: string;
  code?: string;
};

export type AuthActionResponse = {
  ok: boolean;
  token?: string;
  user?: Record<string, unknown>;
  message?: string;
};

export type AuthSessionRecord = {
  id: string;
  token?: string;
  device?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  current?: boolean;
};

export type OrganizationRecord = {
  id: string;
  name: string;
  slug: string;
  plan?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type OrganizationUpdateInput = {
  name: string;
  slug: string;
  plan?: string;
};

export type OrganizationMember = {
  id: string;
  email: string;
  name?: string;
  role: string;
  status: "active" | "pending" | "disabled";
  joinedAt?: string;
};

export type OrganizationInvitation = {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt?: string;
  createdAt?: string;
};

export type OrganizationInvitationInput = {
  email: string;
  role: string;
};

export type I18nBackfillInput = {
  locale: string;
  collection?: string;
};

export type I18nBackfillResponse = {
  status: "enqueued";
  locale: string;
  collection: string | null;
  jobCount: number;
  collections: Record<string, number>;
};

export type I18nBackfillCollectionStatus = {
  collection: string;
  total: number;
  missing: number;
  pending: number;
  inProgress: number;
  complete: number;
  error: number;
};

export type I18nBackfillStatus = {
  locale: string;
  collection: string | null;
  totals: Omit<I18nBackfillCollectionStatus, "collection">;
  collections: I18nBackfillCollectionStatus[];
};

/**
 * Per-record locale variant status as returned by
 * `GET /api/{collection}/{id}/locales`. The default locale always reports
 * `"complete"`; non-default locales reflect the translation job lifecycle
 * (`pending` → `in_progress` → `complete | error`) or `"missing"` when no
 * variant has been created yet.
 */
export type RecordLocaleStatus = "complete" | "pending" | "in_progress" | "error" | "missing";

export type RecordLocaleEntry = {
  locale: string;
  status: RecordLocaleStatus;
  translatedBy?: "human" | "pending" | string;
  translatedAt?: string;
  error?: string;
};

export type RecordLocalesResponse = {
  defaultLocale: string;
  locales: RecordLocaleEntry[];
};

export type TranslateRecordInput = {
  targetLocale: string;
  sourceLocale?: string;
};

export type MediaRecord = {
  id: string;
  key: string;
  url: string;
  filename: string;
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaFolder = {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type MediaListOptions = {
  q?: string;
  type?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
  /**
   * Filter results to a specific folder.
   * - Pass a folder id to scope the list to that folder.
   * - Pass `null` to return root-only records (no folder).
   * - Omit to return media across all folders.
   */
  folderId?: string | null;
};

export type MediaPresign = {
  uploadId: string;
  uploadUrl: string;
  method: "PUT" | "POST";
  key: string;
  headers?: Record<string, string>;
  expiresAt: string;
};

export class AdminApiClient {
  constructor(private readonly baseUrl: string, private readonly token: string | null = null) {}

  async listContent(collection: AdminCollectionName, options: AdminContentListOptions = {}): Promise<AdminContentListResult> {
    const query = qs.stringify(contentListQuery(options), {
      encodeValuesOnly: true,
      arrayFormat: "brackets",
      skipNulls: true
    });
    return this.request(`/api/${collection}${query ? `?${query}` : ""}`);
  }

  async saveContent(collection: AdminCollectionName, id: string | null, input: Record<string, unknown>): Promise<AdminContentRecord> {
    return this.request(id ? `/api/${collection}/${id}` : `/api/${collection}`, {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(input)
    });
  }

  async publishContent(collection: AdminCollectionName, id: string): Promise<AdminContentRecord> {
    return this.request(`/api/${collection}/${encodeURIComponent(id)}/publish`, { method: "POST" });
  }

  async unpublishContent(collection: AdminCollectionName, id: string): Promise<AdminContentRecord> {
    return this.request(`/api/${collection}/${encodeURIComponent(id)}/unpublish`, { method: "POST" });
  }

  async scheduleContent(collection: AdminCollectionName, id: string, publishAt: string): Promise<AdminContentRecord> {
    return this.request(`/api/${collection}/${encodeURIComponent(id)}/schedule`, {
      method: "POST",
      body: JSON.stringify({ publishAt })
    });
  }

  async unscheduleContent(collection: AdminCollectionName, id: string): Promise<AdminContentRecord> {
    return this.request(`/api/${collection}/${encodeURIComponent(id)}/unschedule`, { method: "POST" });
  }

  async deleteContent(collection: AdminCollectionName, id: string): Promise<void> {
    return this.request(`/api/${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async createPreviewToken(collection: AdminCollectionName, id: string): Promise<PreviewToken> {
    return this.request("/api/preview-tokens", {
      method: "POST",
      body: JSON.stringify({ collection, documentId: id })
    });
  }

  async health(): Promise<AdminHealthReport> {
    return this.request("/cms/health/ready");
  }

  async schema(): Promise<AdminSchemaMetadata> {
    return this.request("/cms/schema");
  }

  async rbacMatrix(): Promise<RBACMatrix> {
    return this.request("/cms/rbac/matrix");
  }

  async contentTypeCapabilities(): Promise<ContentTypeCapabilities> {
    return this.request("/cms/content-types/capabilities");
  }

  async contentTypes(): Promise<ContentTypeListResponse> {
    return this.request("/cms/content-types");
  }

  async createContentType(input: ContentTypeInput): Promise<ContentTypeWriteResponse> {
    return this.request("/cms/content-types", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async updateContentType(name: string, input: ContentTypeInput): Promise<ContentTypeWriteResponse> {
    return this.request(`/cms/content-types/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  }

  async deleteContentType(name: string): Promise<{ collection: { name: string; deletedAt: string } }> {
    return this.request(`/cms/content-types/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  async auditLog(options: AuditLogOptions = { limit: 25 }): Promise<{ items: AuditEntry[]; nextCursor?: string }> {
    const query = flatQuery({ limit: 25, ...options });
    return this.request(`/cms/audit-log${query ? `?${query}` : ""}`);
  }

  async auditCsv(options: AuditLogOptions = { limit: 500 }): Promise<string> {
    const query = flatQuery({ limit: 500, ...options, format: "csv" });
    return this.requestText(`/cms/audit-log${query ? `?${query}` : ""}`, {
      headers: { accept: "text/csv" }
    });
  }

  async webhooks(): Promise<{ items: WebhookRecord[]; meta?: { total: number } }> {
    return this.request("/cms/settings/webhooks");
  }

  async createWebhook(input: WebhookInput): Promise<WebhookRecord> {
    return this.request("/cms/settings/webhooks", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async updateWebhook(id: string, input: WebhookUpdateInput): Promise<WebhookRecord> {
    return this.request(`/cms/settings/webhooks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  async replaceWebhook(id: string, input: WebhookInput): Promise<WebhookRecord> {
    return this.request(`/cms/settings/webhooks/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  }

  async deleteWebhook(id: string): Promise<void> {
    return this.request(`/cms/settings/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async webhookDeliveries(id: string, options: { limit?: number; cursor?: string } = {}): Promise<{ items: WebhookDelivery[]; nextCursor?: string }> {
    const query = flatQuery(options);
    return this.request(`/cms/settings/webhooks/${encodeURIComponent(id)}/deliveries${query ? `?${query}` : ""}`);
  }

  async retryWebhookDelivery(id: string, deliveryId: string): Promise<WebhookDelivery> {
    return this.request(`/cms/settings/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/retry`, { method: "POST" });
  }

  async testWebhook(id: string): Promise<WebhookDelivery> {
    return this.request(`/cms/settings/webhooks/${encodeURIComponent(id)}/test`, { method: "POST" });
  }

  async apiKeys(): Promise<{ items: ApiKeyRecord[]; meta?: { total: number } }> {
    return this.request("/cms/settings/api-keys");
  }

  async createApiKey(input: ApiKeyInput): Promise<ApiKeyCreateResponse> {
    return this.request("/cms/settings/api-keys", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async updateApiKey(id: string, input: ApiKeyUpdateInput): Promise<ApiKeyRecord> {
    return this.request(`/cms/settings/api-keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  async deleteApiKey(id: string): Promise<void> {
    return this.request(`/cms/settings/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async authAction(action: string, input: AuthActionInput): Promise<AuthActionResponse> {
    return this.request(`/api/auth/${encodeURIComponent(action)}`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async authSessions(): Promise<{ items: AuthSessionRecord[] }> {
    const result = await this.request<unknown>("/api/auth/list-sessions");
    return { items: normalizeAuthSessions(result) };
  }

  async currentAuthSession(): Promise<AuthActionResponse & { authenticated?: boolean }> {
    return this.request("/api/auth/session");
  }

  async revokeAuthSession(token: string): Promise<void> {
    await this.request("/api/auth/revoke-session", {
      method: "POST",
      body: JSON.stringify({ token })
    });
  }

  async revokeOtherAuthSessions(): Promise<void> {
    await this.request("/api/auth/revoke-other-sessions", { method: "POST" });
  }

  async organization(): Promise<OrganizationRecord> {
    return this.request("/cms/settings/organization");
  }

  async updateOrganization(input: OrganizationUpdateInput): Promise<OrganizationRecord> {
    return this.request("/cms/settings/organization", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  }

  async organizationMembers(): Promise<{ items: OrganizationMember[] }> {
    return this.request("/cms/settings/organization/members");
  }

  async updateOrganizationMember(id: string, input: { role: string; status: OrganizationMember["status"] }): Promise<OrganizationMember> {
    return this.request(`/cms/settings/organization/members/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  async removeOrganizationMember(id: string): Promise<void> {
    return this.request(`/cms/settings/organization/members/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async organizationInvitations(): Promise<{ items: OrganizationInvitation[] }> {
    return this.request("/cms/settings/organization/invitations");
  }

  async createOrganizationInvitation(input: OrganizationInvitationInput): Promise<OrganizationInvitation> {
    return this.request("/cms/settings/organization/invitations", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async revokeOrganizationInvitation(id: string): Promise<OrganizationInvitation> {
    return this.request(`/cms/settings/organization/invitations/${encodeURIComponent(id)}/revoke`, { method: "POST" });
  }

  async i18nBackfillStatus(input: I18nBackfillInput): Promise<I18nBackfillStatus> {
    const query = flatQuery(input);
    return this.request(`/cms/admin/i18n/backfill/status${query ? `?${query}` : ""}`);
  }

  async enqueueI18nBackfill(input: I18nBackfillInput): Promise<I18nBackfillResponse> {
    return this.request("/cms/admin/i18n/backfill", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  /**
   * Per-record locale variant snapshot used by the LocalePanel in the
   * record-edit rail. Backed by `GET /api/{collection}/{id}/locales`.
   */
  async recordLocales(collection: AdminCollectionName, id: string): Promise<RecordLocalesResponse> {
    return this.request(`/api/${collection}/${encodeURIComponent(id)}/locales`);
  }

  /**
   * Trigger a single-record, single-locale translation via the existing
   * `POST /api/{collection}/{id}/translate` endpoint. Used both for the
   * initial "translate now" action and the retry path after an `error`
   * status. Returns the variant produced by the translation provider.
   */
  async translateRecord(
    collection: AdminCollectionName,
    id: string,
    input: TranslateRecordInput
  ): Promise<unknown> {
    return this.request(`/api/${collection}/${encodeURIComponent(id)}/translate`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async listMedia(options: MediaListOptions = {}): Promise<{ items: MediaRecord[]; nextCursor?: string }> {
    // qs `skipNulls` would drop `folderId: null` (root-only). We want the
    // server to receive the literal string `"null"` so it can distinguish
    // "all folders" from "root only" — see `parseMediaListQuery` in core.
    const params: Record<string, unknown> = {
      q: options.q,
      type: options.type,
      from: options.from,
      to: options.to,
      cursor: options.cursor,
      limit: options.limit ?? 50
    };
    if (options.folderId === null) params.folderId = "null";
    else if (options.folderId) params.folderId = options.folderId;
    const query = qs.stringify(params, {
      encodeValuesOnly: true,
      skipNulls: true
    });
    return this.request(`/api/media${query ? `?${query}` : ""}`);
  }

  /**
   * Lists every media folder as a flat array. The admin shell composes a
   * tree by walking `parentId` pointers; the server-side store stays flat so
   * future PATCHes never have to rewrite a denormalized children array.
   */
  async mediaFolders(): Promise<MediaFolder[]> {
    const response = await this.request<{ items: MediaFolder[] }>("/api/media/folders");
    return response.items;
  }

  async createMediaFolder(input: { name: string; parentId?: string | null }): Promise<MediaFolder> {
    return this.request("/api/media/folders", {
      method: "POST",
      body: JSON.stringify({ name: input.name, parentId: input.parentId ?? null })
    });
  }

  async renameMediaFolder(id: string, name: string): Promise<MediaFolder> {
    return this.request(`/api/media/folders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
  }

  async moveMediaFolder(id: string, parentId: string | null): Promise<MediaFolder> {
    return this.request(`/api/media/folders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ parentId })
    });
  }

  async deleteMediaFolder(id: string, options: { force?: boolean } = {}): Promise<void> {
    const suffix = options.force ? "?force=true" : "";
    return this.request(`/api/media/folders/${encodeURIComponent(id)}${suffix}`, { method: "DELETE" });
  }

  async uploadMedia(file: File): Promise<MediaRecord> {
    const body = new FormData();
    body.set("file", file);
    return this.request("/api/media", { method: "POST", body }, false);
  }

  async uploadMediaWithPresign(file: File, metadata?: Record<string, string>, folderId?: string | null): Promise<MediaRecord> {
    const contentType = file.type || "application/octet-stream";
    const presign = await this.presignMedia({ filename: file.name, contentType, size: file.size });
    const headers = new Headers(presign.headers);
    if (!headers.has("content-type")) headers.set("content-type", contentType);

    const uploadResponse = await fetch(presign.uploadUrl, {
      method: presign.method,
      headers,
      body: file
    });
    if (!uploadResponse.ok) throw new Error(`Media upload failed: ${uploadResponse.status}`);

    return this.confirmMedia({
      uploadId: presign.uploadId,
      key: presign.key,
      filename: file.name,
      contentType,
      size: file.size,
      metadata,
      folderId: folderId ?? null
    });
  }

  async presignMedia(input: { filename: string; contentType: string; size: number }): Promise<MediaPresign> {
    return this.request("/api/media/presign", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async confirmMedia(input: { uploadId: string; key: string; filename: string; contentType: string; size: number; metadata?: Record<string, string>; folderId?: string | null }): Promise<MediaRecord> {
    return this.request("/api/media/confirm", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async deleteMedia(id: string): Promise<void> {
    return this.request(`/api/media/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  private async request<T>(path: string, init: RequestInit = {}, json = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (json && init.body !== undefined) headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers
    });
    if (!response.ok) throw new AdminApiError(response.status, await readErrorDetails(response));
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async requestText(path: string, init: RequestInit = {}): Promise<string> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers
    });
    if (!response.ok) throw new AdminApiError(response.status, await readErrorDetails(response));
    return response.text();
  }
}

async function readErrorDetails(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) return await response.clone().json();
    const text = await response.clone().text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

export function resolveAdminApiBase(apiBase?: string | null, env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>): string {
  return apiBase ?? env.VITE_CMS_API_URL ?? "";
}

export function createAdminApiClient(apiBase?: string | null, token: string | null = null): AdminApiClient {
  return new AdminApiClient(resolveAdminApiBase(apiBase), token);
}

function normalizeFilterOperators(filter: Exclude<AdminFilterValue, string | number | boolean>): Record<string, AdminFilterOperatorValue | undefined> {
  const operators: Record<string, AdminFilterOperatorValue | undefined> = {};
  for (const [operator, value] of Object.entries(filter) as Array<[string, AdminFilterOperatorValue | undefined]>) {
    operators[operator === "contains" ? "$contains" : operator] = value;
  }
  return operators;
}

function contentListQuery(options: AdminContentListOptions): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  for (const [field, filter] of Object.entries(options.filters ?? {})) {
    if (filter && typeof filter === "object" && !Array.isArray(filter)) {
      const normalized: Record<string, AdminFilterOperatorValue> = {};
      for (const [operator, value] of Object.entries(normalizeFilterOperators(filter))) {
        if (value === undefined || value === "") continue;
        normalized[operator] = value;
      }
      if (Object.keys(normalized).length > 0) filters[field] = normalized;
    } else if (filter !== undefined && filter !== "") {
      filters[field] = String(filter);
    }
  }

  return {
    pagination: {
      limit: options.limit,
      cursor: options.cursor || undefined
    },
    status: options.status,
    sort: options.sort,
    filters: Object.keys(filters).length > 0 ? filters : undefined
  };
}

function flatQuery(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

function normalizeAuthSessions(result: unknown): AuthSessionRecord[] {
  const rows = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.sessions)
      ? result.sessions
      : isRecord(result) && Array.isArray(result.items)
        ? result.items
        : [];
  return rows.filter(isRecord).map((row, index) => {
    const token = stringValue(row.token) ?? stringValue(row.sessionToken);
    const id = stringValue(row.id) ?? token ?? `session_${index + 1}`;
    return {
      id,
      ...(token ? { token } : {}),
      ...(stringValue(row.device) ? { device: stringValue(row.device) } : {}),
      ...(stringValue(row.ipAddress) ? { ipAddress: stringValue(row.ipAddress) } : {}),
      ...(stringValue(row.userAgent) ? { userAgent: stringValue(row.userAgent) } : {}),
      ...(stringValue(row.createdAt) ? { createdAt: stringValue(row.createdAt) } : {}),
      ...(stringValue(row.updatedAt) ? { updatedAt: stringValue(row.updatedAt) } : {}),
      ...(stringValue(row.expiresAt) ? { expiresAt: stringValue(row.expiresAt) } : {}),
      ...(typeof row.current === "boolean" ? { current: row.current } : {})
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
