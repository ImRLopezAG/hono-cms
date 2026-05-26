import { createFileRoute } from "@tanstack/react-router";
import { WebhooksView } from "../components/AdminApp";

export const Route = createFileRoute("/settings/webhooks")({
  component: WebhooksView
});
