import { createFileRoute } from "@tanstack/react-router";
import { MediaView } from "../components/AdminApp";
import { validateMediaSearch } from "../lib/route-search";

export const Route = createFileRoute("/media")({
  validateSearch: validateMediaSearch,
  component: MediaView
});
