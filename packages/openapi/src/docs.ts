/**
 * Render the HTML page mounted at `/docs`. Ported from
 * `packages/core/src/create-cms.ts:renderDocs(...)` — uses Scalar's CDN
 * scaffold and points the `data-url` at the configured spec path.
 */
export function renderDocs(specPath: string, options: RenderDocsOptions = {}): string {
  const title = escapeHtmlText(options.title ?? "Hono CMS API");
  return [
    "<!doctype html><html><head><title>",
    title,
    "</title></head><body>",
    `<script id="api-reference" data-url="${escapeHtmlAttribute(specPath)}"></script>`,
    "<script>",
    "document.getElementById('api-reference').dataset.configuration = JSON.stringify({",
    "  authentication: { preferredSecurityScheme: 'bearerAuth' }",
    "});",
    "</script>",
    "<script src=\"https://cdn.jsdelivr.net/npm/@scalar/api-reference\"></script>",
    "</body></html>"
  ].join("");
}

export type RenderDocsOptions = {
  title?: string;
};

/**
 * Escape a string for safe use inside an HTML attribute value.
 * Ported verbatim from `packages/core/src/create-cms.ts:escapeHtmlAttribute`.
 */
export function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
