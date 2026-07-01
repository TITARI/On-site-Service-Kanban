import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, apiJson } from "@/lib/client/api-request";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectRequestError(response: Response, fallback = "默认失败") {
  vi.stubGlobal("fetch", vi.fn(async () => response));
  try {
    await apiJson("/api/example", undefined, fallback);
    throw new Error("expected request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError);
    return error as ApiRequestError;
  }
}

describe("api request errors", () => {
  it("prefers a JSON message", async () => {
    const error = await expectRequestError(new Response(JSON.stringify({ message: "消息失败", error: "错误失败" }), { status: 400 }));
    expect(error).toMatchObject({ status: 400, message: "消息失败" });
  });

  it("uses a JSON error when message is absent", async () => {
    const error = await expectRequestError(new Response(JSON.stringify({ error: "错误失败" }), { status: 422 }));
    expect(error).toMatchObject({ status: 422, message: "错误失败" });
  });

  it("uses response text when the body is not JSON", async () => {
    const error = await expectRequestError(new Response("文本失败", { status: 500 }));
    expect(error).toMatchObject({ status: 500, message: "文本失败" });
  });

  it("uses the fallback when the response body is empty", async () => {
    const error = await expectRequestError(new Response(null, { status: 503 }), "服务暂不可用");
    expect(error).toMatchObject({ status: 503, message: "服务暂不可用" });
  });

  it("preserves status and passes AbortSignal to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiJson("/api/example", { signal: controller.signal }, "服务失败"))
      .rejects.toMatchObject({ name: "ApiRequestError", status: 503, message: "服务失败" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
