import { createFileRoute } from "@tanstack/react-router";
import { ContentWorkspace } from "../components/AdminApp";
import { validateContentSearch } from "../lib/route-search";

export const Route = createFileRoute("/content/$collectionName/new")({
  validateSearch: validateContentSearch,
  component: ContentNewRoute
});

function ContentNewRoute() {
  const { collectionName } = Route.useParams();
  const search = Route.useSearch();
  return <ContentWorkspace collectionName={collectionName} createNew routeSearch={search} />;
}
