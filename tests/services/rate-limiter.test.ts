import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFileRateLimiter,
  createMariaDbRateLimiter
} from "@/lib/services/rate-limiter";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function tempRateLimitFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bootstrap-rate-limit-"));
  tempDirectories.push(directory);
  return path.join(directory, "bootstrap-rate-limits.json");
}

describe("rate limiter", () => {
  it("shares file-backed attempts across concurrent worker instances", async () => {
    const filePath = await tempRateLimitFile();
    const firstWorker = createFileRateLimiter({ filePath, lockRetryMs: 1 });
    const secondWorker = createFileRateLimiter({ filePath, lockRetryMs: 1 });

    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => (
      (index % 2 === 0 ? firstWorker : secondWorker)
        .checkAndIncrement("203.0.113.10", 5, 15 * 60 * 1000)
    )));

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    const persisted = JSON.parse(await readFile(filePath, "utf-8"));
    expect(persisted["203.0.113.10"].attempts).toBe(6);
  });

  it("resets file-backed attempts and starts a fresh window", async () => {
    const filePath = await tempRateLimitFile();
    let currentTime = Date.parse("2026-06-27T10:00:00.000Z");
    const firstWorker = createFileRateLimiter({
      filePath,
      lockRetryMs: 1,
      now: () => currentTime
    });
    const secondWorker = createFileRateLimiter({
      filePath,
      lockRetryMs: 1,
      now: () => currentTime
    });

    await firstWorker.checkAndIncrement("203.0.113.11", 2, 1000);
    await secondWorker.checkAndIncrement("203.0.113.11", 2, 1000);
    expect((await firstWorker.checkAndIncrement("203.0.113.11", 2, 1000)).allowed).toBe(false);

    await secondWorker.reset("203.0.113.11");
    expect(await firstWorker.checkAndIncrement("203.0.113.11", 2, 1000)).toEqual({
      allowed: true,
      remaining: 1
    });

    currentTime += 1001;
    expect(await secondWorker.checkAndIncrement("203.0.113.11", 2, 1000)).toEqual({
      allowed: true,
      remaining: 1
    });
  });

  it("uses one atomic MariaDB record across limiter instances", async () => {
    const records = new Map<string, { attempts: number; resetAt: number }>();
    const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO bootstrap_rate_limits")) {
        const key = String(params[0]);
        const nextResetAt = new Date(params[1] as Date).getTime();
        const currentTime = new Date(params[2] as Date).getTime();
        const current = records.get(key);
        if (!current || current.resetAt <= currentTime) {
          records.set(key, { attempts: 1, resetAt: nextResetAt });
        } else {
          current.attempts += 1;
        }
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SELECT attempts")) {
        const current = records.get(String(params[0]));
        return [current ? [{ attempts: current.attempts }] : []];
      }
      if (sql.includes("DELETE FROM bootstrap_rate_limits")) {
        records.delete(String(params[0]));
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const connection = { execute };
    let queue = Promise.resolve<unknown>(undefined);
    const runTransaction = <T>(operation: (connection: typeof connection) => Promise<T>) => {
      const result = queue.then(() => operation(connection));
      queue = result.then(() => undefined, () => undefined);
      return result;
    };
    const options = {
      runTransaction,
      now: () => Date.parse("2026-06-27T10:00:00.000Z")
    };
    const firstWorker = createMariaDbRateLimiter(options);
    const secondWorker = createMariaDbRateLimiter(options);

    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => (
      (index % 2 === 0 ? firstWorker : secondWorker)
        .checkAndIncrement("203.0.113.12", 5, 15 * 60 * 1000)
    )));

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    expect(execute.mock.calls[0][0]).toContain("ON DUPLICATE KEY UPDATE");
  });
});
