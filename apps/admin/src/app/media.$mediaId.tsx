import { createFileRoute } from "@tanstack/react-router";
import { MediaView } from "../components/AdminApp";
import { validateMediaSearch } from "../lib/route-search";

export const Route = createFileRoute("/media/$mediaId")({
  validateSearch: validateMediaSearch,
  component: MediaDetailRoute
});

function MediaDetailRoute() {
  const { mediaId } = Route.useParams();
  return <MediaView mediaId={mediaId} />;
}
