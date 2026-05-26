import type { CMSInstance } from "@hono-cms/core";

export const nextRouteMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

export type NextRouteMethod = typeof nextRouteMethods[number];
export type NextRouteHandler = (request: Request) => Response | Promise<Response>;
export type NextRouteHandlers<Methods extends readonly NextRouteMethod[] = typeof nextRouteMethods> = {
  [Method in Methods[number]]: NextRouteHandler;
};

export type CreateNextRouteHandlersOptions = {
  /**
   * If the catch-all route lives at a sub-path (e.g. `app/api/cms/[...route]`),
   * pass that prefix here so the CMS sees the canonical `/cms/*` and `/api/*`
   * paths it routes on.
   *
   * Example: `basePath: "/api/cms"` rewrites `/api/cms/cms/health/live` -> `/cms/health/live`.
   */
  basePath?: string;
  /** Restrict to a subset of HTTP methods. */
  methods?: readonly NextRouteMethod[];
};

export function createNextRouteHandlers(cms: Pick<CMSInstance, "fetch">): NextRouteHandlers;
export function createNextRouteHandlers(
  cms: Pick<CMSInstance, "fetch">,
  options: CreateNextRouteHandlersOptions
): NextRouteHandlers;
export function createNextRouteHandlers<const Methods extends readonly NextRouteMethod[]>(
  cms: Pick<CMSInstance, "fetch">,
  methods: Methods
): NextRouteHandlers<Methods>;
export function createNextRouteHandlers(
  cms: Pick<CMSInstance, "fetch">,
  optionsOrMethods?: CreateNextRouteHandlersOptions | readonly NextRouteMethod[]
): NextRouteHandlers {
  let options: CreateNextRouteHandlersOptions;
  if (Array.isArray(optionsOrMethods)) {
    options = { methods: optionsOrMethods as readonly NextRouteMethod[] };
  } else if (optionsOrMethods) {
    options = optionsOrMethods as CreateNextRouteHandlersOptions;
  } else {
    options = {};
  }
  const basePath = normalizeBasePath(options.basePath);
  const methods = options.methods ?? nextRouteMethods;

  const handler = (request: Request): Response | Promise<Response> => {
    if (!basePath) return cms.fetch(request);
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith(basePath)) return cms.fetch(request);
    const rewritten = new URL(incoming);
    rewritten.pathname = incoming.pathname.slice(basePath.length) || "/";
    return cms.fetch(new Request(rewritten, request));
  };

  return Object.fromEntries(methods.map((method) => [method, handler])) as NextRouteHandlers;
}

function normalizeBasePath(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
