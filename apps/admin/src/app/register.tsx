import { createFileRoute } from "@tanstack/react-router";
import { AuthView } from "../components/AdminApp";

export const Route = createFileRoute("/register")({
  component: () => <AuthView kind="register" />
});
