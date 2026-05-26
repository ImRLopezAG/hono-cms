import { createFileRoute } from "@tanstack/react-router";
import { AuditView } from "../components/AdminApp";

export const Route = createFileRoute("/settings/audit-log")({
  component: AuditView
});
