import type { DatabaseAdapter } from "@hono-cms/schema";
import { generateToken, getTokenPrefix, hashToken } from "./hashing";
import type {
  ApiKeyRow,
  CreateTokenInput,
  CreateTokenResult,
  InvalidateAllInput,
  ListTokensInput,
  RefreshTokenResult,
  ValidateTokenResult
} from "./types";

/** Sentinel used when a token has no practical expiry. */
const NEVER_EXPIRES_AT_ISO = "2100-01-01T00:00:00.000Z";

export const API_KEYS_TABLE = "api_keys";

/**
 * Construct the token service.
 *
 * The service is a thin functional facade over the {@link DatabaseAdapter}
 * — every method either reads or writes the `api_keys` table through `db`,
 * keeping the auth-tokens plugin portable across every database provider
 * the kernel ships (memory, PostgreSQL, D1, Convex, Turso).
 */
export function createTokenService(opts: {
  db: DatabaseAdapter;
  prefix?: string;
}) {
  const { db, prefix = "sk_" } = opts;
  const table = API_KEYS_TABLE as keyof typeof db.collections & string;

  async function findByHash(tokenHash: string): Promise<ApiKeyRow | null> {
    const result = await db.list(table, { filters: { tokenHash }, limit: 1 });
    const row = result.items[0];
    return (row as ApiKeyRow | undefined) ?? null;
  }

  return {
    /**
     * Mint a fresh API key for the supplied namespace.
     *
     * Returns the *raw* token to the caller (the only time it is ever visible)
     * along with the safe-to-display prefix and the new row id.
     */
    async createToken(args: CreateTokenInput): Promise<CreateTokenResult> {
      const token = generateToken(prefix);
      const tokenHash = await hashToken(token);
      const tokenPrefix = getTokenPrefix(token);
      const now = new Date().toISOString();
      const expiresAt =
        args.expiresAt != null ? new Date(args.expiresAt).toISOString() : NEVER_EXPIRES_AT_ISO;

      const created = (await db.create(table, {
        tokenHash,
        tokenPrefix,
        namespace: normalizeNamespace(args.namespace),
        name: args.name ?? "",
        metadata: args.metadata ?? {},
        expiresAt,
        maxIdleMs: args.maxIdleMs ?? 0,
        lastUsedAt: now,
        revoked: false,
        replacedBy: null
      })) as ApiKeyRow;

      return { token, tokenPrefix, tokenId: created.id };
    },

    /**
     * Validate a raw token and, on success, touch `lastUsedAt`.
     *
     * Returns a discriminated result so callers can branch on `ok` without
     * try/catch. Failure modes — invalid, revoked, expired, idle_timeout — are
     * all surfaced as `{ ok: false, reason }` for parity with tiny-auth.
     */
    async validate(token: string): Promise<ValidateTokenResult> {
      const tokenHash = await hashToken(token);
      const record = await findByHash(tokenHash);

      if (!record) {
        return { ok: false, reason: "invalid" };
      }

      if (record.revoked) {
        return { ok: false, reason: "revoked", namespace: record.namespace };
      }

      const nowMs = Date.now();
      const expiresMs = new Date(record.expiresAt).getTime();
      if (nowMs > expiresMs) {
        return { ok: false, reason: "expired", namespace: record.namespace };
      }

      const lastUsedMs = new Date(record.lastUsedAt).getTime();
      if (record.maxIdleMs && nowMs - lastUsedMs > record.maxIdleMs) {
        return { ok: false, reason: "idle_timeout", namespace: record.namespace };
      }

      const touchAt = new Date().toISOString();
      await db.update(table, record.id, { lastUsedAt: touchAt });

      return {
        ok: true,
        namespace: record.namespace,
        metadata: record.metadata,
        tokenId: record.id
      };
    },

    /**
     * Bump `lastUsedAt` on the row backing the supplied token without doing
     * any expiry / idle checks. Returns `false` when the token is unknown or
     * already revoked.
     */
    async touch(token: string): Promise<boolean> {
      const tokenHash = await hashToken(token);
      const record = await findByHash(tokenHash);
      if (!record || record.revoked) return false;
      await db.update(table, record.id, { lastUsedAt: new Date().toISOString() });
      return true;
    },

    /**
     * Issue a fresh token that inherits the supplied token's namespace,
     * metadata, expiry, and idle policy. The supplied token is revoked and
     * its `replacedBy` column is set to the new row id so admins can audit
     * the rotation chain.
     */
    async refresh(token: string): Promise<RefreshTokenResult> {
      const tokenHash = await hashToken(token);
      const record = await findByHash(tokenHash);

      if (!record) return { ok: false, reason: "invalid" };
      if (record.revoked) return { ok: false, reason: "revoked" };

      const now = new Date().toISOString();
      const newToken = generateToken(prefix);
      const newTokenHash = await hashToken(newToken);
      const newTokenPrefix = getTokenPrefix(newToken);

      const inserted = (await db.create(table, {
        tokenHash: newTokenHash,
        tokenPrefix: newTokenPrefix,
        namespace: record.namespace,
        name: record.name,
        metadata: record.metadata,
        expiresAt: record.expiresAt,
        maxIdleMs: record.maxIdleMs,
        lastUsedAt: now,
        revoked: false,
        replacedBy: null
      })) as ApiKeyRow;

      await db.update(table, record.id, {
        revoked: true,
        replacedBy: inserted.id
      });

      return {
        ok: true,
        token: newToken,
        tokenPrefix: newTokenPrefix,
        tokenId: inserted.id
      };
    },

    /** Revoke (soft-delete) the row backing the supplied token. */
    async invalidate(token: string): Promise<boolean> {
      const tokenHash = await hashToken(token);
      const record = await findByHash(tokenHash);
      if (!record) return false;
      await db.update(table, record.id, { revoked: true });
      return true;
    },

    /** Revoke the row by id. */
    async invalidateById(tokenId: string): Promise<boolean> {
      const record = (await db.get(table, tokenId)) as ApiKeyRow | null;
      if (!record) return false;
      await db.update(table, record.id, { revoked: true });
      return true;
    },

    /**
     * Revoke every live token matching the supplied filter. Returns the
     * number of rows revoked. The optional `before`/`after` bounds clamp the
     * sweep to a `createdAt` window — useful when rotating leaked keys issued
     * during a specific incident window.
     */
    async invalidateAll(args: InvalidateAllInput): Promise<number> {
      const ns = args.namespace !== undefined ? normalizeNamespace(args.namespace) : undefined;
      const filters: Record<string, unknown> = { revoked: false };
      if (ns !== undefined) filters.namespace = ns;

      // Fetch in a wide page; api_keys is bounded by realistic admin usage,
      // and adapters that support cursoring can iterate in follow-ups.
      const result = await db.list(table, { filters, limit: 100 });
      const rows = result.items as ApiKeyRow[];

      let count = 0;
      for (const token of rows) {
        if (token.revoked) continue;
        const createdMs = new Date(token.createdAt).getTime();
        if (args.before !== undefined && createdMs >= args.before) continue;
        if (args.after !== undefined && createdMs <= args.after) continue;
        await db.update(table, token.id, { revoked: true });
        count += 1;
      }
      return count;
    },

    /**
     * List tokens for the supplied namespace.
     *
     * Live tokens by default; pass `includeRevoked: true` to include revoked
     * rows. The full row shape is returned — callers (e.g. the API route) are
     * responsible for stripping `tokenHash` before sending data to clients.
     */
    async list(args: ListTokensInput): Promise<ApiKeyRow[]> {
      const ns = normalizeNamespace(args.namespace);
      const filters: Record<string, unknown> = { namespace: ns };
      if (args.includeRevoked !== true) filters.revoked = false;
      const result = await db.list(table, { filters, limit: 100 });
      return result.items as ApiKeyRow[];
    },

    /**
     * Hard-delete stale rows. A row is "stale" when it is revoked and older
     * than the threshold, or when its `expiresAt` is past the threshold. The
     * default threshold is 30 days — anything older than that is unlikely to
     * be useful for forensic queries.
     */
    async cleanup(olderThanMs?: number): Promise<number> {
      const threshold = olderThanMs ?? 30 * 24 * 60 * 60 * 1000;
      const cutoffMs = Date.now() - threshold;

      const all = await db.list(table, { limit: 1000 });
      const rows = all.items as ApiKeyRow[];
      let deleted = 0;

      for (const token of rows) {
        const createdMs = new Date(token.createdAt).getTime();
        const expiresMs = new Date(token.expiresAt).getTime();
        const shouldDelete =
          (token.revoked && createdMs < cutoffMs) || expiresMs < cutoffMs;
        if (shouldDelete) {
          await db.delete(table, token.id);
          deleted += 1;
        }
      }
      return deleted;
    }
  };
}

export type TokenService = ReturnType<typeof createTokenService>;

/**
 * Namespaces are persisted as plain strings; non-string keys are stable-JSON
 * encoded so they round-trip safely through GET-friendly transports (URLs,
 * header values, logs).
 */
function normalizeNamespace(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
