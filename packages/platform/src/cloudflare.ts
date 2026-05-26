import type { CMSInstance } from "@hono-cms/core";

type CMSFetchEnv = Parameters<CMSInstance["fetch"]>[1];
type CMSFetchContext = Parameters<CMSInstance["fetch"]>[2];

export type CloudflareExport<Env = unknown, Context = unknown> = {
  fetch(request: Request, env: Env, ctx: Context): Response | Promise<Response>;
  scheduled?(event: unknown, env: Env, ctx: Context): Promise<void>;
};

export function createCloudflareExport<Env = unknown, Context = unknown>(
  cms: Pick<CMSInstance, "fetch" | "scheduled">
): CloudflareExport<Env, Context> {
  return {
    fetch(request, env, ctx) {
      return cms.fetch(request, env as CMSFetchEnv, ctx as CMSFetchContext);
    },
    scheduled(event, env, ctx) {
      return cms.scheduled(event, env, ctx);
    }
  };
}
