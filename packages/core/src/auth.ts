import type { AuthAdapter, AuthSession, HealthStatus } from "./types/providers";

export type StaticTokenAuthConfig = {
  provider?: "static-token";
  tokens?: Record<string, { userId: string; roles: string[] }>;
};

export type ApiKeyAuthConfig = {
  provider: "api-key";
  keys?: readonly ApiKeyRecord[];
  store?: ApiKeyStore;
  headerName?: string;
};

export type ApiKeyRecord = {
  id: string;
  name?: string;
  hash: string;
  userId: string;
  roles: readonly string[];
  enabled?: boolean;
  prefix?: string;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
};

export type ApiKeyListItem = Omit<ApiKeyRecord, "hash">;

export type ApiKeyCreateInput = {
  name?: string;
  userId: string;
  roles: readonly string[];
  enabled?: boolean;
};

export type ApiKeyUpdateInput = Partial<Pick<ApiKeyRecord, "name" | "roles" | "enabled">>;

export type ApiKeyCreateResult = ApiKeyListItem & {
  secret: string;
};

export type ApiKeyStore = {
  list(): Promise<ApiKeyRecord[]>;
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
  create(input: Omit<ApiKeyRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<ApiKeyRecord>;
  update(id: string, patch: ApiKeyUpdateInput): Promise<ApiKeyRecord>;
  delete(id: string): Promise<ApiKeyRecord | null>;
  touch?(id: string): Promise<void>;
  health?(): Promise<HealthStatus>;
};

export type BuiltInAuthConfig = StaticTokenAuthConfig | ApiKeyAuthConfig;

export function createStaticTokenAuth(config: StaticTokenAuthConfig = {}): AuthAdapter {
  const tokens = config.tokens ?? {};
  return {
    provider: "static-token",
    async sessionFromRequest(request: Request): Promise<AuthSession | null> {
      const token = readBearerToken(request);
      return token ? tokens[token] ?? null : null;
    },
    async handleAuth(request: Request): Promise<Response> {
      const action = authAction(request);
      if (action === "login") {
        const token = await tokenFromRequestBody(request);
        const session = token ? tokens[token] ?? null : null;
        if (!token || !session) return authUnauthorized();
        return authSuccess("static-token", token, session);
      }
      if (action === "session") return authSessionResponse(await this.sessionFromRequest(request));
      return Response.json({ provider: "static-token" });
    },
    async health() {
      return { ok: true };
    }
  };
}

export function createApiKeyAuth(config: ApiKeyAuthConfig): AuthAdapter {
  const headerName = config.headerName ?? "x-cms-api-key";
  const store = config.store ?? new MemoryApiKeyStore(config.keys ?? []);
  return {
    provider: "api-key",
    async sessionFromRequest(request: Request): Promise<AuthSession | null> {
      const key = request.headers.get(headerName) ?? readBearerToken(request);
      if (!key) return null;
      // Legacy fast path: stored as unsalted SHA-256 hex -> direct hash lookup.
      const legacyHash = await sha256Hex(key);
      const legacyMatch = await store.findByHash(legacyHash);
      if (legacyMatch && legacyMatch.enabled !== false) {
        await store.touch?.(legacyMatch.id);
        return { userId: legacyMatch.userId, roles: [...legacyMatch.roles] };
      }
      // PBKDF2 path: iterate stored keys, verify against per-key salt.
      const candidates = await store.list();
      for (const candidate of candidates) {
        if (candidate.enabled === false) continue;
        if (!candidate.hash.startsWith(`${API_KEY_HASH_VERSION}:`)) continue;
        if (await verifyApiKey(key, candidate.hash)) {
          await store.touch?.(candidate.id);
          return { userId: candidate.userId, roles: [...candidate.roles] };
        }
      }
      return null;
    },
    async handleAuth(request: Request): Promise<Response> {
      const action = authAction(request);
      if (action === "login") {
        const key = await tokenFromRequestBody(request);
        if (!key) return authUnauthorized();
        const session = await this.sessionFromRequest(new Request(request.url, { headers: { [headerName]: key } }));
        if (!session) return authUnauthorized();
        return authSuccess("api-key", key, session);
      }
      if (action === "session") return authSessionResponse(await this.sessionFromRequest(request));
      return Response.json({ provider: "api-key", headerName });
    },
    async health() {
      if (store.health) return store.health();
      const records = await store.list();
      return { ok: true, details: { keys: records.filter((record) => record.enabled !== false).length } };
    }
  };
}

export class MemoryApiKeyStore implements ApiKeyStore {
  private readonly records = new Map<string, ApiKeyRecord>();

  constructor(records: readonly ApiKeyRecord[] = []) {
    for (const record of records) {
      this.records.set(record.id, cloneApiKeyRecord(record));
    }
  }

  async list(): Promise<ApiKeyRecord[]> {
    return [...this.records.values()].map(cloneApiKeyRecord);
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const record = [...this.records.values()].find((candidate) => constantTimeEqual(candidate.hash, hash));
    return record ? cloneApiKeyRecord(record) : null;
  }

  async create(input: Omit<ApiKeyRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<ApiKeyRecord> {
    const now = new Date().toISOString();
    const record: ApiKeyRecord = {
      id: input.id ?? `api_key_${crypto.randomUUID()}`,
      hash: input.hash,
      userId: input.userId,
      roles: [...input.roles],
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      ...(input.name ? { name: input.name } : {}),
      ...(input.prefix ? { prefix: input.prefix } : {}),
      ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {})
    };
    this.records.set(record.id, record);
    return cloneApiKeyRecord(record);
  }

  async update(id: string, patch: ApiKeyUpdateInput): Promise<ApiKeyRecord> {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`api key not found: ${id}`);
    const next: ApiKeyRecord = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.roles !== undefined ? { roles: [...patch.roles] } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date().toISOString()
    };
    this.records.set(id, next);
    return cloneApiKeyRecord(next);
  }

  async delete(id: string): Promise<ApiKeyRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    this.records.delete(id);
    return cloneApiKeyRecord(existing);
  }

  async touch(id: string): Promise<void> {
    const existing = this.records.get(id);
    if (!existing) return;
    this.records.set(id, { ...existing, lastUsedAt: new Date().toISOString() });
  }

  async health(): Promise<HealthStatus> {
    return { ok: true, details: { keys: [...this.records.values()].filter((record) => record.enabled !== false).length } };
  }
}

const API_KEY_HASH_ITERATIONS = 100_000;
const API_KEY_HASH_VERSION = "pbkdf2-sha256-v1";
const API_KEY_SALT_BYTES = 16;
const API_KEY_DERIVED_BITS = 256;

/**
 * Hashes an API key secret using PBKDF2-SHA256 with a per-key random salt.
 *
 * Storage format: `pbkdf2-sha256-v1:<iterations>:<salt-hex>:<derived-hex>`. The
 * legacy unsalted SHA-256 hex digest is still accepted by `verifyApiKey` for
 * backward compat — old stored hashes continue to validate, new writes upgrade.
 *
 * Web Crypto's PBKDF2 is available on Node, Cloudflare Workers, Bun, Deno,
 * Vercel Edge — same runtime contract as the rest of `createCMS`.
 */
export async function hashApiKey(secret: string, options: { salt?: Uint8Array; iterations?: number } = {}): Promise<string> {
  const iterations = options.iterations ?? API_KEY_HASH_ITERATIONS;
  const salt = options.salt ?? randomBytes(API_KEY_SALT_BYTES);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derivedBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    keyMaterial,
    API_KEY_DERIVED_BITS
  );
  const saltHex = bytesToHex(salt);
  const derivedHex = bytesToHex(new Uint8Array(derivedBuffer));
  return `${API_KEY_HASH_VERSION}:${iterations}:${saltHex}:${derivedHex}`;
}

/**
 * Verifies a candidate secret against a stored hash. Accepts both the new
 * PBKDF2 format and the legacy raw SHA-256 hex digest for backward compatibility.
 *
 * Uses constant-time comparison.
 */
export async function verifyApiKey(secret: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith(`${API_KEY_HASH_VERSION}:`)) {
    const [, iterationStr, saltHex, derivedHex] = storedHash.split(":");
    if (!iterationStr || !saltHex || !derivedHex) return false;
    const iterations = Number.parseInt(iterationStr, 10);
    if (!Number.isFinite(iterations) || iterations < 1) return false;
    const salt = hexToBytes(saltHex);
    if (!salt) return false;
    const candidate = await hashApiKey(secret, { salt, iterations });
    return constantTimeEquals(candidate, storedHash);
  }
  // Legacy unsalted SHA-256 — accept for migration only.
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const candidateLegacy = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return constantTimeEquals(candidateLegacy, storedHash);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const parsed = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(parsed)) return null;
    out[i] = parsed;
  }
  return out;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

export function generateApiKeySecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `cms_live_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function apiKeyPrefix(secret: string): string {
  return `${secret.slice(0, 14)}...`;
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

function authAction(request: Request): string {
  const path = new URL(request.url).pathname;
  const marker = "/api/auth/";
  const index = path.indexOf(marker);
  return index === -1 ? "" : path.slice(index + marker.length).replace(/^\/+|\/+$/g, "");
}

async function tokenFromRequestBody(request: Request): Promise<string | null> {
  if (request.method !== "POST") return null;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return null;
  const value = (body as { token?: unknown; apiKey?: unknown; key?: unknown }).token
    ?? (body as { token?: unknown; apiKey?: unknown; key?: unknown }).apiKey
    ?? (body as { token?: unknown; apiKey?: unknown; key?: unknown }).key;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function authUnauthorized(): Response {
  return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
}

function authSuccess(provider: BuiltInAuthConfig["provider"], token: string, session: AuthSession): Response {
  return Response.json({
    ok: true,
    provider,
    token,
    user: authUser(session)
  });
}

function authSessionResponse(session: AuthSession | null): Response {
  return Response.json({
    ok: true,
    authenticated: Boolean(session),
    user: session ? authUser(session) : null
  });
}

function authUser(session: AuthSession): { id: string; roles: string[] } {
  return { id: session.userId, roles: [...session.roles] };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

function cloneApiKeyRecord(record: ApiKeyRecord): ApiKeyRecord {
  return {
    ...record,
    roles: [...record.roles]
  };
}
