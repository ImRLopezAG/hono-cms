import { createAuthPlugin, type AuthPlugin } from "@hono-cms/core";
import { runBootstrap, type BootstrapOptions, type BootstrapResult, type BootstrapHooks } from "./bootstrap";
import { createAuthorize, createIdentityScope, type IdentityScope } from "./authorize";
import { createProtectedMiddleware } from "./protected";
import { mountApiKeyRoutes } from "./routes/api-keys";
import { mountRoleRoutes } from "./routes/roles";
import { createTokenService, type TokenService } from "./service/tokens";
import { apiKeysTable } from "./tables/api-keys";
import { rolesTable } from "./tables/roles";

/** Plugin id under which the auth-tokens service self-registers on the plugin registry. */
export const TOKENS_AUTH_ID = "auth-tokens";

export type TokensAuthOptions = {
  /** Token prefix used for newly-minted keys. Defaults to `"sk_"`. */
  prefix?: string;
  /**
   * Default expiry for newly-issued tokens (ISO duration, ms number, or
   * Date.parse-able string). Reserved for future ergonomic sugar — the v1
   * service stores `expiresAt` directly so callers can use precise epoch ms.
   */
  expiry?: string | number;
  /**
   * Default idle window in milliseconds. When set, tokens whose `lastUsedAt`
   * is older than `idle` are rejected as `idle_timeout` even if `expiresAt`
   * is still in the future. Defaults to `0` (no idle timeout).
   */
  idle?: string | number;
  /** First-run bootstrap configuration. See {@link BootstrapOptions}. */
  bootstrap?: BootstrapOptions;
  /**
   * Optional callback invoked once with the raw bootstrap key after first-run
   * persistence. When supplied, the plugin does *not* write the
   * `.cms-bootstrap-key` file — lets users wire delivery through their own
   * secret manager.
   */
  onBootstrapKey?: (key: string) => void | Promise<void>;
  /**
   * Cryptographic secret reserved for the (future) encrypted-key vault. The
   * v1 service does not consume it; the option is accepted now so installing
   * the plugin with this knob set doesn't trip a type error after the vault
   * lands in a follow-up.
   */
  secret?: string;
};

/**
 * Service exposed on the plugin registry (`ctx.plugins.get("auth-tokens")`).
 *
 * Other plugins (admin UI, CLI, custom CRUD) can reach the token service via
 * this handle without importing the package directly.
 */
export type TokensAuthService = {
  service: TokenService;
  scope: IdentityScope;
};

/**
 * Build the default `AuthPlugin` for hono-cms.
 *
 * Wraps the api-keys + roles tables, the token service, the bootstrap
 * routine, the `/api/api-keys` + `/api/roles` CRUD routes, the `protected`
 * middleware, and the role-driven `installAuthorize` into a single manifest
 * for `plugins: [tokensAuth({...}) ]`.
 *
 * Boot order inside `app(app, ctx)`:
 *
 *   1. Build the token service and identity scope.
 *   2. Run bootstrap (no-op if `api_keys` is non-empty).
 *   3. Register the service on `ctx.plugins` so downstream plugins can reach
 *      it.
 *   4. Mount api-keys and roles routes; both gate themselves through the
 *      `authorize` closure the kernel hands us via {@link installAuthorize}.
 */
export function tokensAuth(opts: TokensAuthOptions = {}): AuthPlugin {
  const scope = createIdentityScope();

  // Forward-reference: `authorize` is the function the kernel will resolve
  // by calling `installAuthorize`. The routes need it eagerly when mounted —
  // we capture the closure once and share it.
  let resolvedAuthorize: ReturnType<typeof createAuthorize> | null = null;
  function authorizeProxy(
    action: Parameters<NonNullable<ReturnType<typeof createAuthorize>>>[0],
    collection: Parameters<NonNullable<ReturnType<typeof createAuthorize>>>[1]
  ): Promise<boolean> {
    if (!resolvedAuthorize) {
      throw new Error("@hono-cms/auth-tokens: authorize() invoked before installAuthorize ran.");
    }
    return Promise.resolve(resolvedAuthorize(action, collection));
  }

  // The token service is constructed inside `app(app, ctx)` once we have the
  // database adapter; the protected middleware needs a stable handle so we
  // build it through a forwarding closure too.
  let serviceRef: TokenService | null = null;

  const plugin = createAuthPlugin({
    id: TOKENS_AUTH_ID,

    schema: {
      api_keys: apiKeysTable,
      roles: rolesTable
    },

    protected: createProtectedMiddleware({
      // Forward to the real service once it's built; the middleware is not
      // invoked until a request lands, by which time `app(app, ctx)` has run.
      service: new Proxy({} as TokenService, {
        get(_target, prop) {
          if (!serviceRef) {
            throw new Error(
              "@hono-cms/auth-tokens: protected middleware fired before plugin install completed."
            );
          }
          return Reflect.get(serviceRef, prop) as unknown;
        }
      }),
      scope
    }),

    installAuthorize(ctx) {
      resolvedAuthorize = createAuthorize({ ctx, scope });
      return resolvedAuthorize;
    },

    async app(app, ctx) {
      // Construct the token service with the supplied database adapter.
      const serviceOpts: { db: typeof ctx.db; prefix?: string } = { db: ctx.db };
      if (opts.prefix !== undefined) serviceOpts.prefix = opts.prefix;
      serviceRef = createTokenService(serviceOpts);

      // Run first-run bootstrap. Skips when keys already exist.
      const hooks: BootstrapHooks = {};
      if (opts.onBootstrapKey !== undefined) hooks.onBootstrapKey = opts.onBootstrapKey;
      const bootstrapInput: Parameters<typeof runBootstrap>[0] = {
        db: ctx.db,
        env: ctx.env,
        hooks
      };
      if (opts.bootstrap !== undefined) bootstrapInput.options = opts.bootstrap;
      const bootstrapResult = await runBootstrap(bootstrapInput);

      // Register the service on the plugin registry. Stash the bootstrap
      // result so admin tooling can surface "first run! here's your key"
      // exactly once on cold boots.
      ctx.plugins.register(TOKENS_AUTH_ID, {
        service: serviceRef,
        scope,
        bootstrap: bootstrapResult
      } satisfies TokensAuthService & { bootstrap: BootstrapResult });

      // installAuthorize runs *after* `app(app, ctx)` in the kernel pipeline,
      // so wire a fallback that resolves on the first call.
      if (!resolvedAuthorize) {
        resolvedAuthorize = createAuthorize({ ctx, scope });
      }

      // Mount the `protected` middleware on the routes this plugin owns. The
      // kernel will *also* compose `protected` with content routes when it
      // mounts them (because the AuthPlugin's top-level `protected` field is
      // the documented hook for that), but our admin routes need protection
      // independent of the kernel pipeline so they work even when the kernel
      // doesn't auto-wire it.
      const protectedMw = createProtectedMiddleware({ service: serviceRef, scope });
      app.use("/api/api-keys", protectedMw);
      app.use("/api/api-keys/*", protectedMw);
      app.use("/api/roles", protectedMw);
      app.use("/api/roles/*", protectedMw);

      mountApiKeyRoutes({
        app,
        db: ctx.db,
        service: serviceRef,
        authorize: authorizeProxy
      });

      mountRoleRoutes({
        app,
        db: ctx.db,
        authorize: authorizeProxy
      });
    }
  });

  return plugin;
}

// Helper: pass through for tests that want to use the same scope handle that
// the plugin uses internally. Not exported from the package index because the
// scope is wired automatically by the plugin's `app()` install pass.
export function createIdentityScopeForTests(): IdentityScope {
  return createIdentityScope();
}

export type { BootstrapResult } from "./bootstrap";
export type { TokensIdentity } from "./protected";
