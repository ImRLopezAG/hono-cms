import { createFileRoute } from "@tanstack/react-router";
import { cms } from "../../../cms";

const BASE_PATH = "/api/cms";

function forward(request: Request): Response | Promise<Response> {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith(BASE_PATH)) {
    return cms.fetch(request);
  }
  const rewritten = new URL(incoming);
  rewritten.pathname = incoming.pathname.slice(BASE_PATH.length) || "/";
  return cms.fetch(new Request(rewritten, request));
}

const handler = async ({ request }: { request: Request }) => forward(request);

// TanStack Start file-based server route. The path `/api/cms/$` matches all
// requests under `/api/cms/*`. Every method delegates to `cms.fetch` after
// stripping the `/api/cms` base path so the CMS sees canonical `/cms/*`
// and `/api/*` paths.
export const Route = createFileRoute("/api/cms/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
      PUT: handler,
      PATCH: handler,
      DELETE: handler,
      OPTIONS: handler,
      HEAD: handler
    }
  }
});
