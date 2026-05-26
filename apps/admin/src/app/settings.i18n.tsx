import { createFileRoute } from "@tanstack/react-router";
import { I18nView } from "../components/AdminApp";

export const Route = createFileRoute("/settings/i18n")({
  component: I18nView
});
