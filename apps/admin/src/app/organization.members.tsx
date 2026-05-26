import { createFileRoute } from "@tanstack/react-router";
import { OrganizationMembersView } from "../components/AdminApp";

export const Route = createFileRoute("/organization/members")({
  component: OrganizationMembersView
});
