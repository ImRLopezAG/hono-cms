import { createRootRouteWithContext, redirect } from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { AppFrame, authRedirectForStoredToken } from "../components/AdminApp";
import type { AdminRouterContext } from "../lib/query-client";

export const Route = createRootRouteWithContext<AdminRouterContext>()({
  beforeLoad: ({ location }) => {
    const to = authRedirectForStoredToken(location.pathname);
    if (to) throw redirect({ to });
  },
  component: () => (
    <NuqsAdapter>
      <AppFrame />
    </NuqsAdapter>
  )
});
