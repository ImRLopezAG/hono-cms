import type { JobsAdapter } from "@hono-cms/core";

/**
 * Verify and dispatch an incoming `/cms/jobs/<name>` request through the
 * configured {@link JobsAdapter}.
 *
 * Mirrors the legacy `runVerifiedJob` helper from `packages/core/src/create-cms.ts`
 * but operates on a request-handler closure so plugins can register arbitrary
 * job names and let the runtime own verification + error shaping.
 *
 * @param adapter The jobs adapter the runtime is wired to. When `adapter.verify`
 *   is provided, requests without a valid signature are rejected with `401`.
 * @param request The raw `Request` (e.g. `c.req.raw`).
 * @param run Closure that performs the actual job work. May return any value;
 *   plain values are JSON-encoded, while `Response` objects are passed through.
 */
export async function runVerifiedJob(
  adapter: JobsAdapter,
  request: Request,
  run: () => Promise<unknown> | unknown
): Promise<Response> {
  try {
    if (typeof adapter.verify === "function" && !(await adapter.verify(request.clone()))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const result = await run();
    if (result instanceof Response) return result;
    return Response.json(result ?? { ok: true });
  } catch (error) {
    console.error("[hono-cms/jobs-runtime]", error);
    return Response.json(
      {
        error: "job_failed",
        message: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
