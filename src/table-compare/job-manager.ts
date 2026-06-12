import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Job, Queue } from "bullmq";
import type { Express } from "express";

import { queueName, redisConnectionOptions } from "./queue";
import type { CompareJobRecord, JobStatus, TableComparisonResult } from "./types";

export interface JobManagerConfig {
  storageRoot: string;
}

export interface TableCompareJobData {
  id: string;
  files: {
    documentA: string;
    documentB: string;
  };
  inputPaths: {
    documentA: string;
    documentB: string;
  };
  outputDirectory: string;
  baselineDocument?: "documentA" | "documentB";
  createdAt: string;
}

type TableCompareQueue = Queue<TableCompareJobData, TableComparisonResult, "compare">;
type TableCompareBullJob = Job<TableCompareJobData, TableComparisonResult, "compare">;

export class TableCompareJobManager {
  private readonly queue: TableCompareQueue;

  constructor(private readonly config: JobManagerConfig) {
    this.queue = new Queue<TableCompareJobData, TableComparisonResult, "compare">(queueName(), {
      connection: redisConnectionOptions(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
  }

  async submit(files: {
    documentA: Express.Multer.File;
    documentB: Express.Multer.File;
    baselineDocument?: "documentA" | "documentB";
  }): Promise<CompareJobRecord> {
    const id = randomUUID().replaceAll("-", "");
    const createdAt = new Date().toISOString();
    const inputDirectory = path.join(this.config.storageRoot, "table-compare", "jobs", id, "input");
    const outputDirectory = path.join(this.config.storageRoot, "table-compare", "jobs", id, "output");
    await Promise.all([mkdir(inputDirectory, { recursive: true }), mkdir(outputDirectory, { recursive: true })]);

    const documentAPath = path.join(inputDirectory, safeName(files.documentA.originalname || "document-a"));
    const documentBPath = path.join(inputDirectory, safeName(files.documentB.originalname || "document-b"));
    await Promise.all([writeFile(documentAPath, files.documentA.buffer), writeFile(documentBPath, files.documentB.buffer)]);

    const data: TableCompareJobData = {
      id,
      files: {
        documentA: path.basename(documentAPath),
        documentB: path.basename(documentBPath),
      },
      inputPaths: {
        documentA: documentAPath,
        documentB: documentBPath,
      },
      outputDirectory,
      baselineDocument: files.baselineDocument,
      createdAt,
    };

    const job = await this.queue.add("compare", data, { jobId: id });
    return recordFromJob(job, "queued");
  }

  async get(id: string): Promise<CompareJobRecord | undefined> {
    const job = await Job.fromId<TableCompareJobData, TableComparisonResult, "compare">(this.queue, id);
    if (!job) {
      return undefined;
    }
    return recordFromJob(job);
  }

  async counts(): Promise<Record<CompareJobRecord["status"], number>> {
    const counts = await this.queue.getJobCounts("waiting", "delayed", "prioritized", "paused", "active", "completed", "failed");
    return {
      queued: (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0),
      processing: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

async function recordFromJob(job: TableCompareBullJob, forcedStatus?: JobStatus): Promise<CompareJobRecord>;
function recordFromJob(job: TableCompareBullJob, forcedStatus: JobStatus): CompareJobRecord;
function recordFromJob(
  job: TableCompareBullJob,
  forcedStatus?: JobStatus,
): CompareJobRecord | Promise<CompareJobRecord> {
  if (forcedStatus) {
    return buildRecord(job, forcedStatus);
  }

  return job.getState().then((state) => buildRecord(job, mapBullState(state)));
}

function buildRecord(job: TableCompareBullJob, status: JobStatus): CompareJobRecord {
  const updatedAtMs = job.finishedOn ?? job.processedOn ?? job.timestamp;
  return {
    id: job.data.id,
    status,
    files: job.data.files,
    inputPaths: job.data.inputPaths,
    baselineDocument: job.data.baselineDocument,
    createdAt: job.data.createdAt,
    updatedAt: new Date(updatedAtMs).toISOString(),
    startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
    completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
    error: job.failedReason,
    result: status === "completed" ? job.returnvalue : undefined,
  };
}

function mapBullState(state: string): JobStatus {
  if (state === "completed") {
    return "completed";
  }
  if (state === "failed") {
    return "failed";
  }
  if (state === "active") {
    return "processing";
  }
  return "queued";
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
