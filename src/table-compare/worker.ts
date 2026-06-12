import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Worker } from "bullmq";

import type { TableCompareJobData } from "./job-manager";
import { queueName, redisConnectionOptions } from "./queue";
import type { TableComparisonResult } from "./types";
import { compareTwoDocuments } from "./workflow";

const concurrency = Number(process.env.TABLE_COMPARE_WORKER_CONCURRENCY ?? process.env.WORKER_CONCURRENCY ?? 2);

const worker = new Worker<TableCompareJobData, TableComparisonResult, "compare">(
  queueName(),
  async (job) => {
    await job.updateProgress({ stage: "running-workflow" });
    await mkdir(job.data.outputDirectory, { recursive: true });

    const result = await compareTwoDocuments({
      documentAPath: job.data.inputPaths.documentA,
      documentBPath: job.data.inputPaths.documentB,
      outputDirectory: job.data.outputDirectory,
      baselineDocument: job.data.baselineDocument,
    });

    await writeFile(path.join(job.data.outputDirectory, "result.json"), JSON.stringify(result, null, 2));
    return result;
  },
  {
    connection: redisConnectionOptions(),
    concurrency,
  },
);

worker.on("completed", (job) => {
  console.log(`table comparison job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`table comparison job ${job?.id ?? "unknown"} failed`, error);
});

worker.on("error", (error) => {
  console.error("table comparison worker error", error);
});

console.log(`table comparison worker listening on queue ${queueName()} with concurrency ${concurrency}`);

async function shutdown(): Promise<void> {
  await worker.close();
}

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
