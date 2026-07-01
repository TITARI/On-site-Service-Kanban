import {
  RateLimiterMemory,
  RateLimiterMySQL
} from "rate-limiter-flexible";
import {
  databaseUrl,
  getDatabaseCallbackPool
} from "../db/connection";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
};

export interface RateLimiter {
  checkAndIncrement(key: string, max: number, windowMs: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

type FlexibleRateLimiterResponse = {
  remainingPoints: number;
};

export type FlexibleRateLimiterBackend = {
  consume(key: string, points?: number): Promise<FlexibleRateLimiterResponse>;
  delete(key: string): Promise<boolean>;
};

export type FlexibleRateLimiterBackendOptions = {
  points: number;
  duration: number;
};

export type FlexibleRateLimiterBackendFactory = (
  options: FlexibleRateLimiterBackendOptions
) => FlexibleRateLimiterBackend;

export type MariaDbBackendOptions = FlexibleRateLimiterBackendOptions & {
  storeClient: unknown;
  storeType: "pool";
  dbName: string;
  tableName: string;
  keyPrefix: string;
  tableCreated: true;
  clearExpiredByTimeout: true;
};

export type MariaDbRateLimiterOptions = {
  storeClient?: unknown;
  databaseName?: string;
  createBackend?: (options: MariaDbBackendOptions) => FlexibleRateLimiterBackend;
};

function validateLimit(max: number, windowMs: number) {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error("Rate limit max must be a positive integer");
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("Rate limit window must be positive");
  }
}

function isRateLimiterRejection(error: unknown): error is {
  remainingPoints: number;
  consumedPoints: number;
  msBeforeNext: number;
} {
  return typeof error === "object"
    && error !== null
    && "remainingPoints" in error
    && typeof error.remainingPoints === "number"
    && "consumedPoints" in error
    && typeof error.consumedPoints === "number"
    && "msBeforeNext" in error
    && typeof error.msBeforeNext === "number";
}

export function createRateLimiterAdapter(
  createBackend: FlexibleRateLimiterBackendFactory
): RateLimiter {
  const backends = new Map<string, FlexibleRateLimiterBackend>();

  function backend(max: number, windowMs: number) {
    validateLimit(max, windowMs);
    const duration = Math.max(1, Math.ceil(windowMs / 1000));
    const cacheKey = `${max}:${duration}`;
    let limiter = backends.get(cacheKey);
    if (!limiter) {
      limiter = createBackend({ points: max, duration });
      backends.set(cacheKey, limiter);
    }
    return limiter;
  }

  return {
    async checkAndIncrement(key, max, windowMs) {
      try {
        const result = await backend(max, windowMs).consume(key, 1);
        return {
          allowed: true,
          remaining: Math.max(0, result.remainingPoints)
        };
      } catch (error) {
        if (isRateLimiterRejection(error)) {
          return { allowed: false, remaining: 0 };
        }
        throw error;
      }
    },
    async reset(key) {
      await Promise.all([...backends.values()].map((limiter) => limiter.delete(key)));
    }
  };
}

export function createMemoryRateLimiter(): RateLimiter {
  return createRateLimiterAdapter((options) => new RateLimiterMemory({
    ...options,
    keyPrefix: "bootstrap"
  }));
}

function databaseName(url: string) {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
  if (!name) throw new Error("DATABASE_URL must include a database name");
  return name;
}

export function createMariaDbRateLimiter(
  options: MariaDbRateLimiterOptions = {}
): RateLimiter {
  const storeClient = options.storeClient ?? getDatabaseCallbackPool();
  const dbName = options.databaseName ?? databaseName(databaseUrl());
  const createBackend = options.createBackend
    ?? ((backendOptions: MariaDbBackendOptions) => new RateLimiterMySQL(backendOptions));

  return createRateLimiterAdapter(({ points, duration }) => createBackend({
    storeClient,
    storeType: "pool",
    dbName,
    tableName: "bootstrap_rate_limits",
    keyPrefix: "bootstrap",
    points,
    duration,
    tableCreated: true,
    clearExpiredByTimeout: true
  }));
}
