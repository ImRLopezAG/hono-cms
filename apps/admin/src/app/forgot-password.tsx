import { createFileRoute } from "@tanstack/react-router";
import { AuthView } from "../components/AdminApp";

export const Route = createFileRoute("/forgot-password")({
  component: () => <AuthView kind="forgot-password" />
});
