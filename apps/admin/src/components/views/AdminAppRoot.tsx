import { RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { Provider } from "jotai";
import { type ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MediaPickerModal } from "./shared";

export function AdminApp({ router }: { router: AnyRouter }): ReactElement {
  return (
    <Provider>
        <TooltipProvider>
          <RouterProvider router={router} />
          <MediaPickerModal />
        </TooltipProvider>
    </Provider>
  );
}
