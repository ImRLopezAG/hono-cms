import { drizzleAdapter, type DrizzleAdapterConfig } from "@better-auth/drizzle-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { AuthAdapter, AuthSession, DatabaseAdapter } from "../types/providers";

export type BetterAuthDatabaseProvider = "sqlite" | "pg" | "mysql";
export type CMSAuthDatabaseProvider = "sqlite" | "d1" | "turso" | "postgres" | "mysql";

export type AuthConfig = Omit<BetterAuthOptions, "database">;

export type CreateBetterAuthOptions = {
  drizzle?: Omit<DrizzleAdapterConfig, "provider">;
};

export type BetterAuthSessionResult = {
  user?: Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
} | null;

export type BetterAuthLike = {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(context: { headers: Headers; query?: { disableCookieCache?: boolean; disableRefresh?: boolean } }): Promise<BetterAuthSessionResult>;
  };
};

export function createBetterAuth(config: AuthConfig | undefined, db: DatabaseAdapter, options: CreateBetterAuthOptions = {}) {
  if (!isCMSAuthDatabaseProvider(db.provider)) {
    throw new Error(`better-auth does not support the ${db.provider} database provider`);
  }
  if (!db.client) {
    throw new Error(`better-auth requires a Drizzle-compatible client for the ${db.provider} database provider`);
  }

  return betterAuth({
    ...config,
    database: drizzleAdapter(db.client as Record<string, unknown>, {
      ...options.drizzle,
      provider: toBetterAuthDatabaseProvider(db.provider)
    })
  });
}

export function createBetterAuthAdapter(auth: BetterAuthLike): AuthAdapter {
  return {
    provider: "better-auth",
    async sessionFromRequest(request) {
      const result = await auth.api.getSession({
        headers: request.headers,
        query: { disableCookieCache: true }
      });
      if (!result?.user) return null;
      const session: AuthSession = {
        userId: String(result.user.id ?? ""),
        roles: rolesFromBetterAuthSession(result)
      };
      const emailRaw = result.user.email;
      if (typeof emailRaw === "string" && emailRaw.length > 0) session.email = emailRaw;
      return session;
    },
    handleAuth(request) {
      return auth.handler(request);
    },
    async health() {
      return { ok: true };
    }
  };
}

export function isAuthConfig(value: unknown): value is AuthConfig {
  return typeof value === "object"
    && value !== null
    && !("sessionFromRequest" in value)
    && !("tokens" in value)
    && !("provider" in value);
}

export function toBetterAuthDatabaseProvider(provider: CMSAuthDatabaseProvider): BetterAuthDatabaseProvider {
  switch (provider) {
    case "postgres":
      return "pg";
    case "mysql":
      return "mysql";
    case "sqlite":
    case "d1":
    case "turso":
      return "sqlite";
  }
}

function isCMSAuthDatabaseProvider(provider: string): provider is CMSAuthDatabaseProvider {
  return provider === "sqlite" || provider === "d1" || provider === "turso" || provider === "postgres" || provider === "mysql";
}

function rolesFromBetterAuthSession(result: NonNullable<BetterAuthSessionResult>): string[] {
  const userRoles = rolesFromUnknown(result.user?.roles) ?? rolesFromUnknown(result.user?.role);
  const sessionRoles = rolesFromUnknown(result.session?.roles) ?? rolesFromUnknown(result.session?.role);
  return userRoles ?? sessionRoles ?? [];
}

function rolesFromUnknown(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map((role) => role.trim()).filter(Boolean);
  return null;
}
