import { createFileRoute } from "@tanstack/react-router";
import { ContentWorkspace } from "../components/AdminApp";
import { validateContentSearch } from "../lib/route-search";

export const Route = createFileRoute("/content/$collectionName/$recordId")({
  validateSearch: validateContentSearch,
  component: ContentRecordRoute
});

function ContentRecordRoute() {
  const { collectionName, recordId } = Route.useParams();
  const search = Route.useSearch();
  return <ContentWorkspace collectionName={collectionName} recordId={recordId} routeSearch={search} />;
}
