import type { Hono } from "hono";
import type { JobsAdapter, HonoCMSEnv } from "@hono-cms/core";
import { runVerifiedJob } from "./dispatcher";

/**
 * Mount a verified `POST /cms/jobs/<name>` (and `GET` for cron-style probes)
 * endpoint that dispatches through the configured {@link JobsAdapter}.
 *
 * The handler closure produced by the plugin's `registerJob()` API runs
 * after verification — the runtime owns both the route surface and the
 * 401/500 envelope so individual job authors only deal with payload + result.
 */
export function mountJobRoute(
  app: Hono<HonoCMSEnv>,
  adapter: JobsAdapter,
  name: string,
  run: (payload: unknown) => Promise<unknown> | unknown,
  options: { allowGet?: boolean } = {}
): void {
  const path = `/cms/jobs/${name}`;
  const allowGet = options.allowGet ?? true;
  if (allowGet) {
    app.get(path, async (context) =>
      runVerifiedJob(adapter, context.req.raw, async () => run(undefined))
    );
  }
  app.post(path, async (context) =>
    runVerifiedJob(adapter, context.req.raw, async () => {
      const payload = await readJsonSafe(context.req.raw);
      return run(payload);
    })
  );
}

async function readJsonSafe(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}
