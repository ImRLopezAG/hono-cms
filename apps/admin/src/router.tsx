import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import type { AdminRouterContext } from "./lib/query-client";

export function createAdminRouter(context: AdminRouterContext) {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    context
  });
}

export type AdminRouter = ReturnType<typeof createAdminRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AdminRouter;
  }
}
