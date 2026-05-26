export { cors, CORS_PLUGIN_ID } from "./plugin";
export {
  applyCorsHeaders,
  corsMiddleware,
  corsPreflightResponse,
  normalizeCors,
  resolveCorsOrigin
} from "./middleware";
export type { CorsConfig, CorsOrigin, NormalizedCorsConfig } from "./types";
