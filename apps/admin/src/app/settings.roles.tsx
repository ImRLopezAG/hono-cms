import { createFileRoute } from "@tanstack/react-router";
import { RolesView } from "../components/AdminApp";

export const Route = createFileRoute("/settings/roles")({
  component: RolesView
});
