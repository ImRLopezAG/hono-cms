export type {
  ContentRecord,
  ContentStatus,
  DatabaseAdapter,
  HealthStatus,
  ID,
  PaginatedResult as ListResult,
  QueryParams as ListQuery
} from "@hono-cms/schema";

import type { ContentRecord, HealthStatus } from "@hono-cms/schema";

export type StoragePutOptions = {
  contentType?: string;
  metadata?: Record<string, string>;
};

export type StorageSignedUploadOptions = {
  key: string;
  contentType: string;
  size: number;
  expiresInSeconds: number;
  metadata?: Record<string, string>;
};

export type StorageSignedUpload = {
  uploadUrl: string;
  method?: "PUT" | "POST";
  headers?: Record<string, string>;
};

export type StoredObject = {
  key: string;
  url: string;
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
};

export type MediaRecord = StoredObject & {
  id: string;
  filename: string;
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaListQuery = {
  cursor?: string;
  limit?: number;
  q?: string;
  type?: "image" | "video" | "audio" | "document" | "other" | string;
  from?: string;
  to?: string;
  /**
   * Filter media records by folder.
   * - A string folder id returns only records inside that folder.
   * - `null` returns only records at the root (no folder).
   * - `undefined` (default) returns records across all folders.
   */
  folderId?: string | null;
};

export type MediaFolder = {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type MediaFolderStore = {
  list(): Promise<MediaFolder[]>;
  get(id: string): Promise<MediaFolder | null>;
  create(input: { name: string; parentId?: string | null }): Promise<MediaFolder>;
  update(id: string, patch: { name?: string; parentId?: string | null }): Promise<MediaFolder | null>;
  delete(id: string, options?: { force?: boolean }): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_empty" }>;
};

export type MediaStore = {
  list(query?: MediaListQuery): Promise<{ items: MediaRecord[]; nextCursor?: string }>;
  get(id: string): Promise<MediaRecord | null>;
  create(input: Omit<MediaRecord, "id" | "createdAt" | "updatedAt">): Promise<MediaRecord>;
  update?(id: string, patch: Partial<Pick<MediaRecord, "folderId" | "filename" | "metadata">>): Promise<MediaRecord | null>;
  delete(id: string): Promise<MediaRecord | null>;
  health?(): Promise<HealthStatus>;
  folders?: MediaFolderStore;
};

export type StorageAdapter = {
  readonly provider: string;
  put(key: string, body: Blob | ArrayBuffer | Uint8Array | string, options?: StoragePutOptions): Promise<StoredObject>;
  createSignedUploadUrl?(options: StorageSignedUploadOptions): Promise<StorageSignedUpload>;
  publicUrl?(key: string): string;
  head?(key: string): Promise<StoredObject | null>;
  get(key: string): Promise<Response | null>;
  delete(key: string): Promise<void>;
  health?(): Promise<HealthStatus>;
};

export type CacheAdapter = {
  readonly provider: string;
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  deletePattern?(pattern: string): Promise<void>;
  sweep?(): Promise<{ swept: number }>;
  checkRateLimit?(identifier: string, options: RateLimitOptions): Promise<RateLimitResult>;
  health?(): Promise<HealthStatus>;
};

export type RateLimitOptions = {
  limit: number;
  window: string;
  prefix?: string;
};

export type RateLimitResult = {
  success: boolean;
  remaining: number;
  resetAt?: string;
};

export type JobHandler = (payload: unknown, context: JobContext) => Promise<void> | void;

export type JobEnqueueOptions = {
  delay?: number;
};

export type JobContext = {
  cms: unknown;
  now: Date;
};

export type JobsAdapter = {
  readonly provider: string;
  register(name: string, handler: JobHandler): void;
  dispatch(name: string, payload?: unknown): Promise<void>;
  enqueue?(endpoint: string, body?: unknown, options?: JobEnqueueOptions): Promise<void>;
  verify?(request: Request): Promise<boolean>;
  scheduledHandler?(cron: string, env?: unknown, ctx?: unknown): Promise<void>;
  scheduled?(event: unknown, env?: unknown, ctx?: unknown): Promise<void>;
  health?(): Promise<HealthStatus>;
};

export type TranslationProvider = {
  readonly provider: string;
  translate(input: {
    collection: string;
    documentId: string;
    sourceLocale: string;
    targetLocale: string;
    fields: Record<string, string>;
  }): Promise<Record<string, string>>;
  health?(): Promise<HealthStatus>;
};

export type LocaleVariantStatus = "pending" | "in_progress" | "complete" | "error";
export type LocaleVariantTranslatedBy = "ai" | "human" | "pending";

export type LocaleVariant = {
  id: string;
  collection: string;
  documentId: string;
  locale: string;
  fields: Record<string, unknown>;
  status: LocaleVariantStatus;
  translatedBy: LocaleVariantTranslatedBy;
  sourceUpdatedAt?: string | undefined;
  error?: string | undefined;
  provider?: string | undefined;
  translatedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type TranslationStore = {
  getVariant(collection: string, documentId: string, locale: string): Promise<LocaleVariant | null>;
  listVariants(collection: string, documentId: string): Promise<LocaleVariant[]>;
  upsertVariant(input: {
    collection: string;
    documentId: string;
    locale: string;
    fields?: Record<string, unknown>;
    status: LocaleVariantStatus;
    translatedBy: LocaleVariantTranslatedBy;
    sourceUpdatedAt?: string;
    error?: string;
    provider?: string;
    translatedAt?: string;
  }): Promise<LocaleVariant>;
  health?(): Promise<HealthStatus>;
};

export type AuthSession = {
  userId: string;
  roles: string[];
  email?: string;
};

export type AuthAdapter = {
  readonly provider: string;
  sessionFromRequest(request: Request): Promise<AuthSession | null>;
  handleAuth?(request: Request): Promise<Response>;
  health?(): Promise<HealthStatus>;
};

export type WebhookEvent = {
  type: string;
  collection?: string;
  record?: ContentRecord;
  previous?: ContentRecord | null;
  timestamp: string;
  requestId?: string;
};

export type WebhookTarget = {
  id?: string;
  name?: string;
  url: string;
  secret?: string;
  events?: readonly string[];
  enabled?: boolean;
};

export type AuditOperation = "create" | "update" | "delete" | "publish" | "unpublish" | "media_upload" | "media_delete" | "schema_change";

export type AuditDiff = {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type AuditLogEntry = {
  id: string;
  operation: AuditOperation;
  collection?: string;
  documentId?: string;
  actorId?: string;
  actorEmail?: string;
  actorRoles: string[];
  requestId: string;
  diff: AuditDiff;
  createdAt: string;
};

export type AuditLogQuery = {
  collection?: string;
  documentId?: string;
  operation?: AuditOperation;
  actorId?: string;
  actorEmail?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
  format?: "json" | "csv";
};

export type AuditStore = {
  append(entry: AuditLogEntry): Promise<void>;
  list(query?: AuditLogQuery): Promise<{ items: AuditLogEntry[]; nextCursor?: string }>;
  cleanup?(olderThan: Date): Promise<number>;
  health?(): Promise<HealthStatus>;
};

export type WebhookDeliveryStatus = "pending" | "success" | "retrying" | "failed";

export type WebhookDelivery = {
  id: string;
  webhookId: string | null;
  eventType: string;
  url: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  requestBody: string;
  responseStatus?: number | undefined;
  responseBody?: string | undefined;
  error?: string | undefined;
  nextAttemptAt?: string | undefined;
  createdAt: string;
};

export type WebhookRecord = Required<Pick<WebhookTarget, "id" | "name" | "url">> & {
  secret?: string;
  events: readonly string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WebhookRecordAttemptInput = {
  ok: boolean;
  status?: number | undefined;
  responseBody?: string | undefined;
  error?: string | undefined;
  nextAttemptAt?: Date | string | undefined;
  finalFailure?: boolean | undefined;
};

export type WebhookStore = {
  listWebhooks(): Promise<WebhookRecord[]>;
  createWebhook(input: Omit<WebhookRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<WebhookRecord>;
  updateWebhook(id: string, patch: Partial<Omit<WebhookRecord, "id" | "createdAt" | "updatedAt" | "secret">> & { secret?: string | undefined }): Promise<WebhookRecord>;
  deleteWebhook(id: string): Promise<void>;
  appendDelivery(delivery: WebhookDelivery): Promise<void>;
  getDelivery?(id: string): Promise<WebhookDelivery | null>;
  updateDelivery?(id: string, patch: Partial<Omit<WebhookDelivery, "id" | "createdAt">>): Promise<WebhookDelivery | null>;
  listDeliveries(query?: { webhookId?: string; cursor?: string; limit?: number }): Promise<{ items: WebhookDelivery[]; nextCursor?: string }>;
  /**
   * List deliveries whose `nextAttemptAt <= now` and status is `retrying`.
   * Used by the `webhook-retry-sweep` cron job to drive retries on
   * deployments without an on-demand queue (Vercel cron-only,
   * Cloudflare without Queue binding, etc.).
   */
  listPendingRetries?(now: Date): Promise<WebhookDelivery[]>;
  /**
   * Record the outcome of a delivery attempt:
   * - `ok: true` → marks delivery as success
   * - `finalFailure: true` → marks delivery as failed permanently
   * - otherwise → marks as `retrying` with the supplied `nextAttemptAt`
   */
  recordAttempt?(deliveryId: string, input: WebhookRecordAttemptInput): Promise<WebhookDelivery | null>;
  /**
   * Delete delivery rows older than `olderThan`. Mirrors `AuditStore.cleanup`.
   */
  cleanup?(olderThan: Date): Promise<number>;
};
