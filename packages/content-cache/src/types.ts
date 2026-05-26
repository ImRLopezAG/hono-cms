/**
 * Public configuration shape for the content-cache plugin.
 *
 * The plugin caches GET responses for content list (`/api/<collection>`) and
 * content get (`/api/<collection>/:id`) routes. Mutations on the same
 * collection (`content:after-{create,update,delete,publish,unpublish}` events)
 * invalidate the cache by bumping a per-collection version counter.
 */
export type ContentCacheConfig = {
  /**
   * Time-to-live in seconds for cached content responses. Defaults to 30 s,
   * which mirrors the conservative default the kernel used to bake in. Set
   * higher for read-heavy public CDNs; set lower (or to 0 → disabled) for
   * "always fresh" admin surfaces.
   */
  ttlSeconds?: number;

  /**
   * Prefix applied to every cache key the plugin writes. Defaults to
   * `"content-cache"`. Override when running multiple CMS instances against
   * the same shared cache (e.g. Upstash Redis) so that one instance's cache
   * does not collide with another's.
   */
  keyPrefix?: string;
};
