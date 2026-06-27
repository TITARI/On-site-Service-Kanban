import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseConnection } from "../db/connection";
import { withDatabaseTransaction } from "../db/connection";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
};

export interface RateLimiter {
  checkAndIncrement(key: string, max: number, windowMs: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

type RateLimitRecord = {
  attempts: number;
  resetAt: number;
};

type RateLimitRecords = Record<string, RateLimitRecord>;

export type FileRateLimiterOptions = {
  filePath?: string;
  now?: () => number;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
};

type RateLimitDatabaseConnection = Pick<DatabaseConnection, "execute">;

export type RateLimitTransactionRunner = <T>(
  operation: (connection: RateLimitDatabaseConnection) => Promise<T>
) => Promise<T>;

export type MariaDbRateLimiterOptions = {
  now?: () => number;
  runTransaction?: RateLimitTransactionRunner;
};

const DEFAULT_FILE_PATH = path.join(process.cwd(), "data", "bootstrap-rate-limits.json");
const REPLACE_RETRY_DELAYS_MS = [20, 40, 80, 160, 320];

function isErrorCode(error: unknown, code: string) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function validateLimit(max: number, windowMs: number) {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error("Rate limit max must be a positive integer");
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("Rate limit window must be positive");
  }
}

function emptyRecords(): RateLimitRecords {
  return Object.create(null) as RateLimitRecords;
}

async function readRecords(filePath: string): Promise<RateLimitRecords> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return emptyRecords();
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Bootstrap rate-limit file is invalid");
  }
  return Object.assign(emptyRecords(), parsed);
}

async function replaceFile(tempFile: string, filePath: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const retryDelay = REPLACE_RETRY_DELAYS_MS[attempt];
      const retryable = ["EPERM", "EACCES", "EBUSY"].some((code) => isErrorCode(error, code));
      if (!retryable || retryDelay === undefined) throw error;
      await delay(retryDelay);
    }
  }
}

async function writeRecords(filePath: string, records: RateLimitRecords) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempFile = path.join(
    directory,
    `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  await writeFile(tempFile, JSON.stringify(records, null, 2), "utf-8");
  try {
    await replaceFile(tempFile, filePath);
  } finally {
    await unlink(tempFile).catch((error) => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
  }
}

async function acquireFileLock(
  lockPath: string,
  { retryMs, timeoutMs, staleMs }: { retryMs: number; timeoutMs: number; staleMs: number }
) {
  const startedAt = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          await unlink(lockPath);
          continue;
        }
      } catch (lockError) {
        if (!isErrorCode(lockError, "ENOENT")) throw lockError;
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Timed out acquiring bootstrap rate-limit lock");
      }
      await delay(retryMs);
    }
  }
}

async function withFileLock<T>(
  lockPath: string,
  options: { retryMs: number; timeoutMs: number; staleMs: number },
  operation: () => Promise<T>
) {
  const handle = await acquireFileLock(lockPath, options);
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
  }
}

export function createFileRateLimiter(options: FileRateLimiterOptions = {}): RateLimiter {
  const filePath = options.filePath ?? DEFAULT_FILE_PATH;
  const lockPath = `${filePath}.lock`;
  const now = options.now ?? Date.now;
  const lockOptions = {
    retryMs: options.lockRetryMs ?? 10,
    timeoutMs: options.lockTimeoutMs ?? 5000,
    staleMs: options.staleLockMs ?? 30000
  };

  return {
    checkAndIncrement: async (key, max, windowMs) => {
      validateLimit(max, windowMs);
      return withFileLock(lockPath, lockOptions, async () => {
        const currentTime = now();
        const records = await readRecords(filePath);
        for (const [recordKey, record] of Object.entries(records)) {
          if (record.resetAt <= currentTime) delete records[recordKey];
        }

        const current = records[key];
        const attempts = current ? current.attempts + 1 : 1;
        records[key] = {
          attempts,
          resetAt: current?.resetAt ?? currentTime + windowMs
        };
        await writeRecords(filePath, records);
        return {
          allowed: attempts <= max,
          remaining: Math.max(0, max - attempts)
        };
      });
    },
    reset: async (key) => {
      await withFileLock(lockPath, lockOptions, async () => {
        const records = await readRecords(filePath);
        delete records[key];
        await writeRecords(filePath, records);
      });
    }
  };
}

function defaultTransactionRunner<T>(
  operation: (connection: RateLimitDatabaseConnection) => Promise<T>
) {
  return withDatabaseTransaction((connection) => operation(connection));
}

export function createMariaDbRateLimiter(options: MariaDbRateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? Date.now;
  const runTransaction = options.runTransaction ?? defaultTransactionRunner;

  return {
    checkAndIncrement: async (key, max, windowMs) => {
      validateLimit(max, windowMs);
      return runTransaction(async (connection) => {
        const currentTime = new Date(now());
        const resetAt = new Date(currentTime.getTime() + windowMs);
        await connection.execute(
          `INSERT INTO bootstrap_rate_limits (ip_key, attempts, reset_at)
           VALUES (?, 1, ?)
           ON DUPLICATE KEY UPDATE
             attempts = IF(reset_at <= ?, 1, attempts + 1),
             reset_at = IF(reset_at <= ?, VALUES(reset_at), reset_at)`,
          [key, resetAt, currentTime, currentTime]
        );
        const [rows] = await connection.execute(
          "SELECT attempts FROM bootstrap_rate_limits WHERE ip_key = ? FOR UPDATE",
          [key]
        ) as unknown as [{ attempts: number }[], unknown];
        const attempts = Number(rows[0]?.attempts);
        if (!Number.isInteger(attempts) || attempts < 1) {
          throw new Error("Bootstrap rate-limit counter could not be read");
        }
        return {
          allowed: attempts <= max,
          remaining: Math.max(0, max - attempts)
        };
      });
    },
    reset: async (key) => {
      await runTransaction(async (connection) => {
        await connection.execute(
          "DELETE FROM bootstrap_rate_limits WHERE ip_key = ?",
          [key]
        );
      });
    }
  };
}
