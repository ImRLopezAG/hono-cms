import { createFileRoute } from "@tanstack/react-router";
import { AuthView } from "../components/AdminApp";

export const Route = createFileRoute("/2fa/verify")({
  component: () => <AuthView kind="2fa-verify" />
});
