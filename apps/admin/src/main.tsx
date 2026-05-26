import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AdminApp } from "./components/AdminApp";
import "./styles/tokens.css";
import "./index.css";
import { installContentTypeSmokeHarness } from "./lib/content-type-smoke";
import { createAdminQueryClient } from "./lib/query-client";
import { createAdminRouter } from "./router";
import "./styles/admin.css";

export type AdminBootState = {
  apiBase: string;
};

export function createAdminBootState(apiBase = "/api"): AdminBootState {
  return { apiBase };
}

const root = document.getElementById("root");
if (root) {
  if (import.meta.env.DEV) installContentTypeSmokeHarness();
  const queryClient = createAdminQueryClient();
  const router = createAdminRouter({ queryClient });
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <AdminApp router={router} />
      <Toaster
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{ classNames: { toast: "font-[ui-sans-serif] text-sm" } }}
      />
    </QueryClientProvider>
  );
}
