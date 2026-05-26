/**
 * `@hono-cms/auth-tokens` — the default AuthPlugin for hono-cms.
 *
 * Exposes a single factory, {@link tokensAuth}, that wraps:
 *
 *  - Hashed API-key service (`sk_<48-hex>` tokens; SHA-256 at rest)
 *  - First-run bootstrap (`.cms-bootstrap-key` + env-fallback for serverless)
 *  - Strapi-style roles + permission-matrix authorize
 *  - `/api/api-keys/*` and `/api/roles/*` CRUD routes
 *  - `protected` middleware that stamps `c.var.identity`
 *
 * Add to your CMS config:
 *
 *     import { createCMS } from "@hono-cms/core";
 *     import { tokensAuth } from "@hono-cms/auth-tokens";
 *
 *     const cms = createCMS({
 *       db,
 *       collections,
 *       plugins: [tokensAuth({})]
 *     });
 */
export { tokensAuth, TOKENS_AUTH_ID } from "./plugin";
export type { TokensAuthOptions, TokensAuthService } from "./plugin";
export type { TokensIdentity } from "./protected";
export type { BootstrapOptions, BootstrapHooks, BootstrapResult } from "./bootstrap";
export type {
  ApiKeyRow,
  CreateTokenInput,
  CreateTokenResult,
  ValidateTokenResult,
  RefreshTokenResult,
  ListTokensInput,
  InvalidateAllInput
} from "./service/types";
export type { TokenService } from "./service/tokens";
export type { RoleRow, PermissionMatrix } from "./tables/roles";

export { createTokenService, API_KEYS_TABLE } from "./service/tokens";
export { runBootstrap } from "./bootstrap";
export { permissionLookup } from "./authorize";
export { ROLES_TABLE } from "./tables/roles";
export { readToken } from "./protected";
export { generateToken, hashToken, getTokenPrefix } from "./service/hashing";
