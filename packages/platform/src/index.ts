import type { CMSInstance } from "@hono-cms/core";

export type WebRequestHandler<Env = unknown, Context = unknown> = (request: Request, env?: Env, ctx?: Context) => Response | Promise<Response>;

export function createFetchHandler<Env = unknown, Context = unknown>(
  cms: Pick<CMSInstance, "fetch">
): WebRequestHandler<Env, Context> {
  return (request, env, ctx) => (cms.fetch as WebRequestHandler<Env, Context>)(request, env, ctx);
}

export const toWebHandler = createFetchHandler;

export { createCloudflareExport } from "./cloudflare";
export type { CloudflareExport } from "./cloudflare";
export { createNodeHandler } from "./node";
export type { NodeHandler, NodeHandlerOptions } from "./node";
export { createNextRouteHandlers, nextRouteMethods } from "./next";
export type { NextRouteHandler, NextRouteHandlers, NextRouteMethod } from "./next";
export { createVercelHandler, generateVercelJson } from "./vercel";
export type { VercelCron, VercelJson, VercelRouteHandler } from "./vercel";
