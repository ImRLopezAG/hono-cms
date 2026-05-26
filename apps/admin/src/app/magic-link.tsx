import { createFileRoute } from "@tanstack/react-router";
import { AuthView } from "../components/AdminApp";

export const Route = createFileRoute("/magic-link")({
  component: () => <AuthView kind="magic-link" />
});
