import { createFileRoute } from "@tanstack/react-router";
import { ContentWorkspace } from "../components/AdminApp";

export const Route = createFileRoute("/")({
  component: () => <ContentWorkspace />
});
