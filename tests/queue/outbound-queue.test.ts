import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundMessage } from "@/lib/domain/types";

const bullMocks = vi.hoisted(() => ({
  queues: [] as Array<{
    name: string;
    options: unknown;
    add: ReturnType<typeof vi.fn>;
    addBulk: ReturnType<typeof vi.fn>;
  }>,
  workers: [] as Array<{
    name: string;
    processor: (job: unknown) => Promise<unknown>;
    options: unknown;
    listeners: Record<string, (...args: unknown[]) => unknown>;
  }>,
  redis: [] as Array<{ url: string; options: unknown }>
}));

vi.mock("bullmq", () => ({
  Queue: class Queue {
    add = vi.fn(async () => ({ id: "dlq-job" }));
    addBulk = vi.fn(async () => []);
    close = vi.fn(async () => undefined);

    constructor(public name: string, public options: unknown) {
      bullMocks.queues.push(this);
    }
  },
  Worker: class Worker {
    listeners: Record<string, (...args: unknown[]) => unknown> = {};
    close = vi.fn(async () => undefined);

    constructor(
      public name: string,
      public processor: (job: unknown) => Promise<unknown>,
      public options: unknown
    ) {
      bullMocks.workers.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => unknown) {
      this.listeners[event] = listener;
      return this;
    }
  }
}));

vi.mock("ioredis", () => ({
  default: class IORedis {
    quit = vi.fn(async () => "OK");

    constructor(public url: string, public options: unknown) {
      bullMocks.redis.push(this);
    }
  }
}));

const {
  createOutboundConnection,
  createOutboundQueue,
  createOutboundWorker,
  enqueueOutboundMessages
} = await import("@/lib/queue/outbound-queue");

function message(id = "outbound-1"): OutboundMessage {
  return {
    id,
    channel: "wechat",
    targetName: "现场群",
    text: "工单已创建",
    status: "sending",
    retryCount: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
}

beforeEach(() => {
  bullMocks.queues.length = 0;
  bullMocks.workers.length = 0;
  bullMocks.redis.length = 0;
});

describe("outbound BullMQ transport", () => {
  it("does not connect to Redis when there is nothing to enqueue", async () => {
    await expect(enqueueOutboundMessages([])).resolves.toBe(0);
    expect(bullMocks.redis).toHaveLength(0);
    expect(bullMocks.queues).toHaveLength(0);
  });

  it("enqueues idempotent jobs with retry and retention defaults", async () => {
    const queue = createOutboundQueue({} as never);
    await enqueueOutboundMessages([message()], queue);

    expect(bullMocks.queues[0]).toMatchObject({
      name: "outbound-messages",
      options: {
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 1000
        }
      }
    });
    expect(bullMocks.queues[0].addBulk).toHaveBeenCalledWith([
      {
        name: "send",
        data: message(),
        opts: { jobId: "outbound-1" }
      }
    ]);
  });

  it("uses fail-fast producers and BullMQ-compatible worker connections", () => {
    createOutboundConnection("redis://127.0.0.1:6379", "producer");
    createOutboundConnection("redis://127.0.0.1:6379", "worker");

    expect(bullMocks.redis).toEqual([
      expect.objectContaining({ options: expect.objectContaining({ maxRetriesPerRequest: 1 }) }),
      expect.objectContaining({ options: expect.objectContaining({ maxRetriesPerRequest: null }) })
    ]);
  });

  it("moves exhausted jobs to an explicit dead-letter queue", async () => {
    const deadLetterQueue = createOutboundQueue({} as never, "outbound-messages-dlq");
    createOutboundWorker(vi.fn(async () => undefined), {
      connection: {} as never,
      deadLetterQueue
    });

    const worker = bullMocks.workers[0];
    expect(worker.options).toMatchObject({
      concurrency: 5,
      stalledInterval: 30000,
      maxStalledCount: 1
    });

    const exhaustedJob = {
      id: "outbound-1",
      name: "send",
      data: message(),
      attemptsMade: 3,
      opts: { attempts: 3 }
    };
    await worker.listeners.failed(exhaustedJob, new Error("wxauto unavailable"));

    expect(bullMocks.queues[0].add).toHaveBeenCalledWith(
      "dead-letter",
      expect.objectContaining({
        message: message(),
        failedReason: "wxauto unavailable",
        attemptsMade: 3
      }),
      { jobId: "outbound-1" }
    );
  });

  it("does not dead-letter a job while BullMQ still has retries", async () => {
    const deadLetterQueue = createOutboundQueue({} as never, "outbound-messages-dlq");
    createOutboundWorker(vi.fn(async () => undefined), {
      connection: {} as never,
      deadLetterQueue
    });

    await bullMocks.workers[0].listeners.failed({
      id: "outbound-1",
      data: message(),
      attemptsMade: 1,
      opts: { attempts: 3 }
    }, new Error("temporary failure"));

    expect(bullMocks.queues[0].add).not.toHaveBeenCalled();
  });
});
