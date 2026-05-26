import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { ContentWorkspace } from "../components/AdminApp";
import { validateContentSearch } from "../lib/route-search";

export const Route = createFileRoute("/content/$collectionName")({
  validateSearch: validateContentSearch,
  component: ContentCollectionRoute
});

function ContentCollectionRoute() {
  const { collectionName } = Route.useParams();
  const search = Route.useSearch();
  // Child routes (`/new`, `/$recordId`) need an Outlet to mount into.
  // Without this, navigating directly to `/content/articles/<id>` would
  // stop at this route's component and never render the record editor.
  const childMatches = useChildMatches();
  if (childMatches.length > 0) return <Outlet />;
  return <ContentWorkspace collectionName={collectionName} routeSearch={search} />;
}
