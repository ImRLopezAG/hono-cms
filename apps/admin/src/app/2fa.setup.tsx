import { createFileRoute } from "@tanstack/react-router";
import { AuthView } from "../components/AdminApp";

export const Route = createFileRoute("/2fa/setup")({
  component: () => <AuthView kind="2fa-setup" />
});
