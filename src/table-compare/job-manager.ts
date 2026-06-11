import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Express } from "express";

import { compareTwoDocuments } from "./workflow";
import type { CompareJobRecord } from "./types";

export interface JobManagerConfig {
  storageRoot: string;
  concurrency: number;
}

interface QueuedJob {
  record: CompareJobRecord;
  resolve: () => void;
}

export class TableCompareJobManager {
  private readonly jobs = new Map<string, CompareJobRecord>();
  private readonly queue: QueuedJob[] = [];
  private active = 0;

  constructor(private readonly config: JobManagerConfig) {}

  get concurrency(): number {
    return this.config.concurrency;
  }

  async submit(files: {
    documentA: Express.Multer.File;
    documentB: Express.Multer.File;
    baselineDocument?: "documentA" | "documentB";
  }): Promise<CompareJobRecord> {
    const id = randomUUID().replaceAll("-", "");
    const createdAt = new Date().toISOString();
    const inputDirectory = path.join(this.config.storageRoot, "table-compare", "input", id);
    await mkdir(inputDirectory, { recursive: true });

    const documentAPath = path.join(inputDirectory, safeName(files.documentA.originalname || "document-a"));
    const documentBPath = path.join(inputDirectory, safeName(files.documentB.originalname || "document-b"));
    await Promise.all([writeFile(documentAPath, files.documentA.buffer), writeFile(documentBPath, files.documentB.buffer)]);

    const record: CompareJobRecord = {
      id,
      status: "queued",
      files: {
        documentA: path.basename(documentAPath),
        documentB: path.basename(documentBPath),
      },
      inputPaths: {
        documentA: documentAPath,
        documentB: documentBPath,
      },
      baselineDocument: files.baselineDocument,
      createdAt,
      updatedAt: createdAt,
    };

    this.jobs.set(id, record);
    this.queue.push({ record, resolve: () => undefined });
    this.drain();
    return record;
  }

  get(id: string): CompareJobRecord | undefined {
    return this.jobs.get(id);
  }

  counts(): Record<CompareJobRecord["status"], number> {
    const counts = { queued: 0, processing: 0, completed: 0, failed: 0 };
    for (const job of this.jobs.values()) {
      counts[job.status] += 1;
    }
    return counts;
  }

  private drain(): void {
    while (this.active < this.config.concurrency && this.queue.length > 0) {
      const queued = this.queue.shift();
      if (!queued) {
        return;
      }
      this.active += 1;
      void this.run(queued.record).finally(() => {
        this.active -= 1;
        queued.resolve();
        this.drain();
      });
    }
  }

  private async run(record: CompareJobRecord): Promise<void> {
    record.status = "processing";
    record.startedAt = new Date().toISOString();
    record.updatedAt = record.startedAt;

    try {
      const outputDirectory = path.join(this.config.storageRoot, "table-compare", "results", record.id);
      await mkdir(outputDirectory, { recursive: true });
      record.result = await compareTwoDocuments({
        documentAPath: record.inputPaths.documentA,
        documentBPath: record.inputPaths.documentB,
        outputDirectory,
        baselineDocument: record.baselineDocument,
      });
      record.status = "completed";
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
    } finally {
      record.completedAt = new Date().toISOString();
      record.updatedAt = record.completedAt;
    }
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
