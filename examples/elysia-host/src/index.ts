import { Elysia } from "elysia";
import { cms } from "./cms";

const BASE_PATH = "/api/cms";

/**
 * Rewrite the incoming Request URL so the CMS sees its canonical paths
 * (`/cms/...` and `/api/...`) regardless of where Elysia mounts it.
 *
 * Mirrors the Next adapter helper in `@hono-cms/platform/next`.
 */
function stripPrefix(request: Request, basePath: string): Request {
  const normalized = normalizeBasePath(basePath);
  if (!normalized) return request;
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith(normalized)) return request;
  const rewritten = new URL(incoming);
  rewritten.pathname = incoming.pathname.slice(normalized.length) || "/";
  return new Request(rewritten, request);
}

function normalizeBasePath(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function createElysiaApp() {
  return new Elysia()
    .get("/", () => "Hono CMS via Elysia host")
    .all("/api/cms/*", ({ request }) => cms.fetch(stripPrefix(request, BASE_PATH)));
}

export const app = createElysiaApp();

// Only boot the listener when executed directly (`bun src/index.ts`).
// Tests import `createElysiaApp` and call `.listen(0)` themselves.
if (import.meta.main) {
  app.listen(8792, ({ hostname, port }) => {
    // eslint-disable-next-line no-console
    console.log(`Elysia host with Hono CMS listening at http://${hostname}:${port}`);
  });
}

export { stripPrefix };
