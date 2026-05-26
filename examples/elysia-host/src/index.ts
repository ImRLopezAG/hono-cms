import { Elysia } from "elysia";
import { createElysiaExampleCMS, type ElysiaCMSOptions } from "./cms";

const BASE_PATH = "/api/cms";

/**
 * Rewrite the incoming Request URL so the CMS sees its canonical paths
 * (`/cms/...` and `/api/...`) regardless of where Elysia mounts it.
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

export async function createElysiaApp(opts: ElysiaCMSOptions = {}) {
  const cms = await createElysiaExampleCMS(opts);
  return new Elysia()
    .get("/", () => "Hono CMS via Elysia host")
    .all("/api/cms/*", ({ request }) => cms.fetch(stripPrefix(request, BASE_PATH)));
}

if (import.meta.main) {
  const app = await createElysiaApp();
  app.listen(8792, ({ hostname, port }: { hostname: string; port: number }) => {
    // eslint-disable-next-line no-console
    console.log(`Elysia host with Hono CMS listening at http://${hostname}:${port}`);
  });
}

export { stripPrefix };
