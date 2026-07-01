import { describe, expect, it, vi } from "vitest";
import {
  createMariaDbRateLimiter,
  createMemoryRateLimiter,
  createRateLimiterAdapter
} from "@/lib/services/rate-limiter";

describe("rate limiter", () => {
  it("limits and resets attempts with the in-memory backend", async () => {
    const limiter = createMemoryRateLimiter();

    await expect(limiter.checkAndIncrement("203.0.113.10", 2, 1000)).resolves.toEqual({
      allowed: true,
      remaining: 1
    });
    await expect(limiter.checkAndIncrement("203.0.113.10", 2, 1000)).resolves.toEqual({
      allowed: true,
      remaining: 0
    });
    await expect(limiter.checkAndIncrement("203.0.113.10", 2, 1000)).resolves.toEqual({
      allowed: false,
      remaining: 0
    });

    await limiter.reset("203.0.113.10");
    await expect(limiter.checkAndIncrement("203.0.113.10", 2, 1000)).resolves.toEqual({
      allowed: true,
      remaining: 1
    });
  });

  it("treats limiter responses as blocked but propagates store errors", async () => {
    const consume = vi
      .fn()
      .mockResolvedValueOnce({ remainingPoints: 4 })
      .mockRejectedValueOnce({
        remainingPoints: 0,
        consumedPoints: 6,
        msBeforeNext: 1000
      })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const deleteKey = vi.fn(async () => true);
    const createBackend = vi.fn(() => ({ consume, delete: deleteKey }));
    const limiter = createRateLimiterAdapter(createBackend);

    await expect(limiter.checkAndIncrement("203.0.113.11", 5, 1500)).resolves.toEqual({
      allowed: true,
      remaining: 4
    });
    await expect(limiter.checkAndIncrement("203.0.113.11", 5, 1500)).resolves.toEqual({
      allowed: false,
      remaining: 0
    });
    await expect(limiter.checkAndIncrement("203.0.113.11", 5, 1500)).rejects.toThrow(
      "database unavailable"
    );

    expect(createBackend).toHaveBeenCalledOnce();
    expect(createBackend).toHaveBeenCalledWith({
      points: 5,
      duration: 2
    });

    await limiter.reset("203.0.113.11");
    expect(deleteKey).toHaveBeenCalledWith("203.0.113.11");
  });

  it("configures the MySQL backend for the migrated shared table", async () => {
    const backend = {
      consume: vi.fn(async () => ({ remainingPoints: 4 })),
      delete: vi.fn(async () => true)
    };
    const createBackend = vi.fn(() => backend);
    const storeClient = { getConnection: vi.fn() };
    const limiter = createMariaDbRateLimiter({
      storeClient,
      databaseName: "collaboration_board",
      createBackend
    });

    await limiter.checkAndIncrement("203.0.113.12", 5, 15 * 60 * 1000);

    expect(createBackend).toHaveBeenCalledWith(expect.objectContaining({
      storeClient,
      storeType: "pool",
      dbName: "collaboration_board",
      tableName: "bootstrap_rate_limits",
      keyPrefix: "bootstrap",
      points: 5,
      duration: 15 * 60,
      tableCreated: true,
      clearExpiredByTimeout: true
    }));
  });
});
