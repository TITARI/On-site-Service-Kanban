import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/client/api-request";
import { createQueryClient } from "@/lib/client/query-client";

describe("createQueryClient", () => {
  it("uses the approved cache and focus defaults", () => {
    const client = createQueryClient();

    expect(client.getDefaultOptions().queries).toMatchObject({
      staleTime: 0,
      refetchOnWindowFocus: false
    });
    expect(client.getDefaultOptions().mutations).toMatchObject({ retry: 0 });
  });

  it("retries network and server failures once but never retries client failures", () => {
    const client = createQueryClient();
    const retry = client.getDefaultOptions().queries?.retry as (failureCount: number, error: unknown) => boolean;

    expect(retry(0, new TypeError("network"))).toBe(true);
    expect(retry(1, new TypeError("network"))).toBe(false);
    expect(retry(0, new ApiRequestError(503, "down"))).toBe(true);
    expect(retry(1, new ApiRequestError(503, "down"))).toBe(false);
    expect(retry(0, new ApiRequestError(401, "unauthorized"))).toBe(false);
    expect(retry(0, new ApiRequestError(400, "bad request"))).toBe(false);
  });
});
