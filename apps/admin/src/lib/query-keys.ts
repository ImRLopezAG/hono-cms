/**
 * Centralised TanStack Query keys for the admin SPA.
 *
 * Each factory returns a typed tuple so call sites stay terse and
 * invalidations / partial matches stay consistent.
 */

export const adminQueryKeys = {
  schema: () => ["schema"] as const,
  contentTypes: () => ["content-types"] as const,
  capabilities: () => ["content-type-capabilities"] as const,

  content: () => ["content"] as const,
  contentList: (collection: string, search: string, status: string, sort: string) =>
    ["content", collection, search, status, sort] as const,
  contentRecord: (collection: string, id: string) =>
    ["content", collection, id] as const,

  health: () => ["health"] as const,
  audit: (filters?: Record<string, unknown>) =>
    filters && Object.keys(filters).length > 0
      ? (["audit", filters] as const)
      : (["audit"] as const),
  webhooks: () => ["webhooks"] as const,
  webhookDeliveries: (webhookId: string) => ["webhooks", webhookId, "deliveries"] as const,
  apiKeys: () => ["api-keys"] as const,
  sessions: () => ["sessions"] as const,
  media: (filter?: Record<string, unknown>) =>
    filter && Object.keys(filter).length > 0
      ? (["media", filter] as const)
      : (["media"] as const),
  organization: () => ["organization"] as const,
  members: () => ["organization", "members"] as const,
  invitations: () => ["organization", "invitations"] as const,
  i18nBackfill: (selection: string) => ["i18n-backfill", selection] as const
};

export type AdminQueryKey =
  | ReturnType<(typeof adminQueryKeys)[keyof typeof adminQueryKeys]>;
