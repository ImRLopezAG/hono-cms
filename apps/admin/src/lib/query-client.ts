import { QueryClient } from "@tanstack/react-query";

export function createAdminQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: 1
      }
    }
  });
}

export type AdminRouterContext = {
  queryClient: QueryClient;
};
