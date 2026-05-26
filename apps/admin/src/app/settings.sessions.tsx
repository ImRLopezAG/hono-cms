import { createFileRoute } from "@tanstack/react-router";
import { SessionsView } from "../components/AdminApp";

export const Route = createFileRoute("/settings/sessions")({
  component: SessionsView
});
