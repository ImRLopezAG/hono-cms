import { createFileRoute } from "@tanstack/react-router";
import { OrganizationInvitationsView } from "../components/AdminApp";

export const Route = createFileRoute("/organization/invitations")({
  component: OrganizationInvitationsView
});
