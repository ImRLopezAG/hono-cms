import { createNextRouteHandlers } from "@hono-cms/platform/next";
import { cms } from "../../../../src/cms";

export const dynamic = "force-dynamic";

const handlers = createNextRouteHandlers(cms, { basePath: "/api/cms" });

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
export const OPTIONS = handlers.OPTIONS;
export const HEAD = handlers.HEAD;
