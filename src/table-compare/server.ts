import express from "express";
import multer from "multer";

import { MinerUClient } from "./mineru-client";
import { TableCompareJobManager } from "./job-manager";

const port = Number(process.env.TABLE_COMPARE_PORT ?? 8090);
const storageRoot = process.env.TABLE_COMPARE_STORAGE_ROOT ?? process.env.STORAGE_ROOT ?? "/data";
const mineruBaseUrl = process.env.MINERU_BASE_URL ?? "http://127.0.0.1:8000";
const concurrency = Number(process.env.TABLE_COMPARE_WORKER_CONCURRENCY ?? process.env.WORKER_CONCURRENCY ?? 2);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 536_870_912) } });

const mineru = new MinerUClient({
  baseUrl: mineruBaseUrl,
  resultTimeoutMs: Number(process.env.JOB_RESULT_TIMEOUT_SECONDS ?? 7200) * 1000,
});
const jobs = new TableCompareJobManager({ storageRoot, concurrency });
const app = express();

app.get("/health", async (_request, response) => {
  const mineruHealth = await mineru.health().catch((error) => ({
    status: "unhealthy",
    error: error instanceof Error ? error.message : String(error),
  }));
  response.json({
    status: "healthy",
    mineru: mineruHealth,
    jobs: jobs.counts(),
    workerConcurrency: jobs.concurrency,
  });
});

app.post(
  "/v1/table-comparisons",
  upload.fields([
    { name: "documentA", maxCount: 1 },
    { name: "documentB", maxCount: 1 },
  ]),
  async (request, response, next) => {
    try {
      const files = request.files as Record<string, Express.Multer.File[]> | undefined;
      const documentA = files?.documentA?.[0];
      const documentB = files?.documentB?.[0];
      if (!documentA || !documentB) {
        response.status(400).json({ detail: "Upload documentA and documentB multipart fields" });
        return;
      }

      const job = await jobs.submit({ documentA, documentB });
      response.status(202).json({
        jobId: job.id,
        status: job.status,
        statusUrl: `/v1/table-comparisons/${job.id}`,
        resultUrl: `/v1/table-comparisons/${job.id}/result`,
        redlinePdfUrl: `/v1/table-comparisons/${job.id}/redline.pdf`,
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/v1/table-comparisons/:jobId", (request, response) => {
  const job = jobs.get(request.params.jobId);
  if (!job) {
    response.status(404).json({ detail: "Job not found" });
    return;
  }
  response.json(serializeJob(job));
});

app.get("/v1/table-comparisons/:jobId/result", (request, response) => {
  const job = jobs.get(request.params.jobId);
  if (!job) {
    response.status(404).json({ detail: "Job not found" });
    return;
  }
  if (job.status === "queued" || job.status === "processing") {
    response.status(202).json({ ...serializeJob(job), message: "Result not ready" });
    return;
  }
  if (job.status === "failed") {
    response.status(409).json({ ...serializeJob(job), message: "Job failed" });
    return;
  }
  response.json(job.result);
});

app.get("/v1/table-comparisons/:jobId/redline.pdf", (request, response) => {
  const job = jobs.get(request.params.jobId);
  if (!job) {
    response.status(404).json({ detail: "Job not found" });
    return;
  }
  if (job.status !== "completed" || !job.result?.redlinePdfPath) {
    response.status(job.status === "failed" ? 409 : 202).json({ ...serializeJob(job), message: "Redline PDF not ready" });
    return;
  }
  response.sendFile(job.result.redlinePdfPath);
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(500).json({ detail: error instanceof Error ? error.message : String(error) });
});

app.listen(port, () => {
  console.log(`table comparison API listening on :${port}`);
});

function serializeJob(job: ReturnType<TableCompareJobManager["get"]>) {
  if (!job) {
    return undefined;
  }
  return {
    jobId: job.id,
    status: job.status,
    files: job.files,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    resultUrl: `/v1/table-comparisons/${job.id}/result`,
    redlinePdfUrl: `/v1/table-comparisons/${job.id}/redline.pdf`,
  };
}
