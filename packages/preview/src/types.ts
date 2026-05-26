/**
 * Public configuration for the `@hono-cms/preview` plugin.
 *
 * Both fields are optional so `preview()` can be called with no arguments to
 * pick sensible defaults (empty `previewUrl`, 15-minute TTL).
 */
export type PreviewConfig = {
  /**
   * Public preview URL pattern. When set, the response from
   * `POST /api/preview-tokens` includes `previewUrl` built from this pattern:
   *
   *  - if the URL contains the literal `{{token}}` placeholder, that
   *    placeholder is substituted with the generated token;
   *  - otherwise the token is appended as a `?token=<token>` query parameter
   *    (replacing any existing `token` param).
   *
   * Leaving this unset (`undefined`) yields an empty `previewUrl` in the
   * response, which is appropriate for callers that build the URL themselves.
   */
  url?: string;
  /**
   * Time-to-live for issued preview tokens, in seconds. Defaults to `900`
   * (15 minutes) — short by design because preview tokens grant draft-content
   * access without authentication.
   */
  tokenTtlSeconds?: number;
};

/**
 * Payload stored in the cache under `preview:<token>`. Used to round-trip the
 * collection + document the token grants preview access to.
 */
export type PreviewTokenPayload = {
  collection: string;
  documentId: string;
  createdAt: string;
};

/**
 * Shape of the JSON response returned by `POST /api/preview-tokens`.
 */
export type PreviewTokenResult = {
  token: string;
  expiresAt: string;
  previewUrl: string;
};
