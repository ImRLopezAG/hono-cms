import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysView } from "../components/AdminApp";

export const Route = createFileRoute("/settings/api-keys")({
  component: ApiKeysView
});
