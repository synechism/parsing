import type { ConnectionOptions } from "bullmq";

export function queueName(): string {
  return process.env.TABLE_COMPARE_QUEUE_NAME ?? "table-comparisons";
}

export function redisConnectionOptions(): ConnectionOptions {
  return {
    url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}
