import { QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "./api-request";

export function shouldRetryQuery(failureCount: number, error: unknown) {
  if (failureCount >= 1) return false;
  return !(error instanceof ApiRequestError) || error.status >= 500;
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 0,
        retry: shouldRetryQuery,
        refetchOnWindowFocus: false
      },
      mutations: {
        retry: 0
      }
    }
  });
}
