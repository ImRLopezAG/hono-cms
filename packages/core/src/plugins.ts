/**
 * Backwards-compat re-exports for the legacy `CMSPlugin` function shape.
 *
 * Kept only because plan documents and a few external scripts still
 * reference `CMSPluginCapabilities`. New code should import the
 * manifest types directly from `@hono-cms/core/plugins/types`:
 *
 *   import type { Plugin, AuthPlugin, PluginContext } from "@hono-cms/core";
 */
export { CMSPluginError } from "./plugins/types";
export type {
  CMSPluginCapabilities,
  PluginContext as CMSPluginContext
} from "./plugins/types";
