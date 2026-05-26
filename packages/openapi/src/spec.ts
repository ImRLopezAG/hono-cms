import { createOpenAPISpec } from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";
import type { OpenAPIConfig, OpenAPIPathItem, OpenAPISpec } from "./types";

/**
 * Input for the spec assembler.
 *
 * - `collections`: current schema (re-read on every rebuild so collection
 *   add/remove invalidates the cached output).
 * - `config`: title/version/description/servers/graphql forwarded to
 *   `createOpenAPISpec`.
 * - `extraPaths`: paths injected by other plugins via the `addPath()` service.
 *   Keyed by path string so a plugin can call `addPath()` multiple times for
 *   the same path and the latest call wins.
 */
export type AssembleOpenAPISpecInput = {
  collections: CMSCollections;
  config: OpenAPIConfig;
  extraPaths: ReadonlyMap<string, OpenAPIPathItem>;
};

/**
 * Build the served OpenAPI document from the kernel's hand-rolled spec plus
 * whatever paths other plugins have injected. The kernel-side
 * `createOpenAPISpec` still owns the per-collection content paths and the
 * legacy `/api/*` system paths; this assembler layers extra plugin paths on
 * top.
 *
 * Extra paths are merged shallowly: if a plugin registers `/api/foo` and the
 * kernel spec also describes `/api/foo`, the plugin entry replaces the kernel
 * entry. This intentionally lets plugins refine kernel-known routes
 * (`auth-tokens` does this for `/api/api-keys/*`).
 */
export function assembleOpenAPISpec(input: AssembleOpenAPISpecInput): OpenAPISpec {
  const handRolled = createOpenAPISpec(input.collections, {
    ...(input.config.title !== undefined ? { title: input.config.title } : {}),
    ...(input.config.version !== undefined ? { version: input.config.version } : {}),
    ...(input.config.description !== undefined ? { description: input.config.description } : {}),
    ...(input.config.servers !== undefined ? { servers: input.config.servers } : {}),
    ...(input.config.graphql !== undefined ? { graphql: input.config.graphql } : { graphql: false })
  }) as OpenAPISpec;

  if (input.extraPaths.size === 0) return handRolled;

  const mergedPaths: Record<string, OpenAPIPathItem> = { ...handRolled.paths };
  for (const [path, methods] of input.extraPaths) {
    const existing = mergedPaths[path];
    mergedPaths[path] = existing ? { ...existing, ...methods } : methods;
  }
  return { ...handRolled, paths: mergedPaths };
}

/**
 * Tiny djb2 hash, ported verbatim from
 * `packages/core/src/create-cms.ts:hashText`. Produces a stable 8-char hex
 * string for use as an ETag.
 */
export function hashText(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
