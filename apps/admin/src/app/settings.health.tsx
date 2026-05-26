import { createFileRoute } from "@tanstack/react-router";
import { HealthView } from "../components/AdminApp";

export const Route = createFileRoute("/settings/health")({
  component: HealthView
});
