/**
 * Result of {@link TokenService.validate}.
 *
 * On success carries the namespace, optional metadata, and the token id; on
 * failure carries a reason code. The discriminated `ok` field lets callers
 * branch with a single check.
 */
export type ValidateTokenResult =
  | {
      ok: true;
      namespace: string;
      metadata: unknown;
      tokenId: string;
    }
  | {
      ok: false;
      reason: "expired" | "idle_timeout" | "revoked" | "invalid";
      namespace?: string | undefined;
    };

/**
 * Result of {@link TokenService.refresh}.
 *
 * On success carries the *new* raw token (shown to the caller exactly once),
 * its prefix, and the id of the newly-inserted row. The old row is revoked
 * and its `replacedBy` column set to point at the new id.
 */
export type RefreshTokenResult =
  | {
      ok: true;
      token: string;
      tokenPrefix: string;
      tokenId: string;
    }
  | { ok: false; reason: "invalid" | "revoked" };

export type CreateTokenInput = {
  namespace: unknown;
  name?: string;
  metadata?: unknown;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** Max milliseconds between uses before the token is rejected. `0`/omit means no idle timeout. */
  maxIdleMs?: number;
};

export type CreateTokenResult = {
  token: string;
  tokenPrefix: string;
  tokenId: string;
};

export type ListTokensInput = {
  namespace: unknown;
  includeRevoked?: boolean;
};

export type InvalidateAllInput = {
  namespace?: unknown;
  /** Epoch ms — only invalidate tokens whose `createdAt` is before this value. */
  before?: number;
  /** Epoch ms — only invalidate tokens whose `createdAt` is after this value. */
  after?: number;
};

/**
 * Plain row shape stored in the `api_keys` table.
 *
 * Mirrored on the DatabaseAdapter; date fields are serialised as ISO strings
 * so the adapter contract stays portable across drivers (memory, PG, D1,
 * Convex, etc.).
 */
export type ApiKeyRow = {
  id: string;
  tokenHash: string;
  tokenPrefix: string;
  namespace: string;
  name: string;
  metadata: unknown;
  /** ISO-8601 date string. */
  expiresAt: string;
  maxIdleMs: number;
  /** ISO-8601 date string. */
  lastUsedAt: string;
  revoked: boolean;
  replacedBy: string | null;
  createdAt: string;
  updatedAt: string;
};
