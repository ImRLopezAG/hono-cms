import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettingsView } from "../components/AdminApp";

export const Route = createFileRoute("/organization/settings")({
  component: OrganizationSettingsView
});
