import { createFileRoute } from "@tanstack/react-router";
import { AuthView } from "../components/AdminApp";

export const Route = createFileRoute("/verify-email")({
  component: () => <AuthView kind="verify-email" />
});
