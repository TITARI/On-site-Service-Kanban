import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import type { OutboundMessage } from "@/lib/domain/types";

export const OUTBOUND_QUEUE_NAME = "outbound-messages";
export const OUTBOUND_DLQ_NAME = "outbound-messages-dlq";

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: 100,
  removeOnFail: 1_000
};

type OutboundQueue = Queue<unknown, unknown, string>;
type OutboundHandler = (message: OutboundMessage, job: Job<OutboundMessage>) => Promise<void>;

let producerConnection: IORedis | undefined;
let producerQueue: OutboundQueue | undefined;

function configuredRedisUrl() {
  const url = process.env.REDIS_URL?.trim();
  if (!url) throw new Error("REDIS_URL is required for outbound message delivery");
  return url;
}

export function createOutboundConnection(
  url = configuredRedisUrl(),
  mode: "producer" | "worker" = "producer"
) {
  return new IORedis(url, {
    maxRetriesPerRequest: mode === "worker" ? null : 1
  });
}

export function createOutboundQueue(
  connection: IORedis,
  name = OUTBOUND_QUEUE_NAME
): OutboundQueue {
  return new Queue<unknown, unknown, string>(name, {
    connection,
    ...(name === OUTBOUND_QUEUE_NAME ? { defaultJobOptions } : {})
  });
}

function getOutboundQueue() {
  if (!producerQueue) {
    producerConnection = createOutboundConnection();
    producerQueue = createOutboundQueue(producerConnection);
  }
  return producerQueue;
}

export async function enqueueOutboundMessages(
  messages: OutboundMessage[],
  queue?: OutboundQueue
) {
  if (messages.length === 0) return 0;
  const targetQueue = queue ?? getOutboundQueue();
  await targetQueue.addBulk(messages.map((message) => ({
    name: "send",
    data: message,
    opts: { jobId: message.id }
  })));
  return messages.length;
}

function exhausted(job: Job<OutboundMessage>, error: Error) {
  const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
  return job.attemptsMade >= attempts || /stalled more than allowable limit/i.test(error.message);
}

export function createOutboundWorker(
  handler: OutboundHandler,
  options: {
    connection?: IORedis;
    deadLetterQueue?: OutboundQueue;
  } = {}
) {
  const connection = options.connection ?? createOutboundConnection(configuredRedisUrl(), "worker");
  const deadLetterQueue = options.deadLetterQueue
    ?? createOutboundQueue(createOutboundConnection(configuredRedisUrl(), "producer"), OUTBOUND_DLQ_NAME);
  const worker = new Worker<OutboundMessage, void, string>(
    OUTBOUND_QUEUE_NAME,
    (job) => handler(job.data, job),
    {
      connection,
      concurrency: 5,
      stalledInterval: 30_000,
      maxStalledCount: 1
    }
  );

  worker.on("failed", (job, error) => {
    if (!job || !exhausted(job, error)) return;
    void deadLetterQueue.add("dead-letter", {
      message: job.data,
      failedReason: error.message,
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString()
    }, {
      jobId: job.id
    }).catch((dlqError) => {
      console.error("[outbound-queue] failed to persist dead-letter job", dlqError);
    });
  });
  worker.on("error", (error) => {
    console.error("[outbound-queue] worker error", error);
  });

  return worker;
}

export async function closeOutboundQueue() {
  const queue = producerQueue;
  const connection = producerConnection;
  producerQueue = undefined;
  producerConnection = undefined;
  await queue?.close();
  await connection?.quit();
}
