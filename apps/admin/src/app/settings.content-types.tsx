import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { ContentTypesView } from "../components/views/ContentTypesView";

/**
 * Content-Types Builder landing.
 *
 * The form view (Strapi-pixel-parity) is the default surface. The
 * visualizer ships as a sibling child route (`/visualizer`) that the
 * Form/Visualizer tab strip inside `ContentTypesView` links to. When a
 * child route is mounted, we render the `<Outlet />` instead so the
 * canvas takes over the workspace.
 */
export const Route = createFileRoute("/settings/content-types")({
  component: ContentTypesRoute
});

function ContentTypesRoute() {
  const childMatches = useChildMatches();
  if (childMatches.length > 0) return <Outlet />;
  return <ContentTypesView />;
}
