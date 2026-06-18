import { createPlugin, type CacheAdapter, type Plugin } from "@hono-cms/core";
import { mountPreviewRoutes } from "./routes";
import type { PreviewConfig } from "./types";

/** Plugin id under which the preview plugin self-registers. */
export const PREVIEW_PLUGIN_ID = "preview";

/** Default TTL for preview tokens (15 minutes). */
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 15;

/**
 * Build the `Plugin` manifest for the preview-token feature.
 *
 * Declares `requires: ["cache"]` so the kernel rejects installs where the
 * cache plugin is missing or installed *after* `preview()` — without a cache
 * adapter the plugin has nowhere to store the issued tokens.
 *
 * Reaches the adapter at install time through
 * `ctx.plugins.get<CacheAdapter>("cache")`, mounts the three `/api/preview-
 * tokens/*` routes via `mountPreviewRoutes`, and is otherwise stateless.
 *
 * ```ts
 * createCMS({
 *   plugins: [
 *     memoryCache({}),                          // U11
 *     preview({ url: "https://site.example/preview", tokenTtlSeconds: 900 })
 *   ]
 * });
 * ```
 */
export function preview(opts: PreviewConfig = {}): Plugin {
  const config: Required<PreviewConfig> = {
    url: opts.url ?? "",
    tokenTtlSeconds: opts.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS
  };

  return createPlugin({
    id: PREVIEW_PLUGIN_ID,
    requires: ["cache"],
    app: (app, ctx) => {
      const cache = ctx.plugins.get("cache");
      mountPreviewRoutes(app, { cache, config });
    }
  });
}
