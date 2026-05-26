import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { ContentWorkspace } from "../components/AdminApp";
import { validateContentSearch } from "../lib/route-search";

export const Route = createFileRoute("/content")({
  validateSearch: validateContentSearch,
  component: ContentRoute
});

function ContentRoute() {
  const search = Route.useSearch();
  const childMatches = useChildMatches();
  if (childMatches.length > 0) {
    return <Outlet />;
  }
  return <ContentWorkspace routeSearch={search} />;
}
