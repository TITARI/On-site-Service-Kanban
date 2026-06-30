import { describe, expect, it, vi } from "vitest";

describe("database connection", () => {
  it("shares one utf8mb4 callback pool with the promise API", async () => {
    const promisePool = { end: vi.fn(async () => undefined) };
    const callbackPool = { promise: vi.fn(() => promisePool) };
    const createPool = vi.fn(() => callbackPool);
    vi.doMock("mysql2", () => ({
      createPool
    }));
    vi.resetModules();

    const {
      closeDatabasePool,
      getDatabaseCallbackPool,
      getDatabasePool
    } = await import("@/lib/db/connection");
    const callback = getDatabaseCallbackPool();
    const promise = getDatabasePool();

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      charset: "utf8mb4_unicode_ci"
    }));
    expect(createPool).toHaveBeenCalledOnce();
    expect(callback).toBe(callbackPool);
    expect(promise).toBe(promisePool);

    await closeDatabasePool();
    expect(promisePool.end).toHaveBeenCalledOnce();
  });
});
