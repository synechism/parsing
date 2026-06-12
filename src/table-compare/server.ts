import express from "express";
import multer from "multer";
import swaggerUi from "swagger-ui-express";

import { MinerUClient } from "./mineru-client";
import { TableCompareJobManager } from "./job-manager";
import { openApiDocument } from "./openapi";
import type { CompareJobRecord } from "./types";

const port = Number(process.env.TABLE_COMPARE_PORT ?? 8090);
const storageRoot = process.env.TABLE_COMPARE_STORAGE_ROOT ?? process.env.STORAGE_ROOT ?? "/data";
const mineruBaseUrl = process.env.MINERU_BASE_URL ?? "http://127.0.0.1:8000";
const workerConcurrency = Number(process.env.TABLE_COMPARE_WORKER_CONCURRENCY ?? process.env.WORKER_CONCURRENCY ?? 2);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 536_870_912) } });

const mineru = new MinerUClient({
  baseUrl: mineruBaseUrl,
  resultTimeoutMs: Number(process.env.JOB_RESULT_TIMEOUT_SECONDS ?? 7200) * 1000,
});
const jobs = new TableCompareJobManager({ storageRoot });
const app = express();

app.get(["/openapi.json", "/swagger.json"], (_request, response) => {
  response.json(openApiDocument);
});

app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument, {
    customSiteTitle: "MinerU Semantic Table Compare API",
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
  }),
);

app.get("/health", async (_request, response) => {
  const mineruHealth = await mineru.health().catch((error) => ({
    status: "unhealthy",
    error: error instanceof Error ? error.message : String(error),
  }));
  response.json({
    status: "healthy",
    mineru: mineruHealth,
    jobs: await jobs.counts(),
    workerConcurrency,
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
      const baselineDocument = parseBaselineDocument(request.body?.baselineDocument ?? request.body?.baseline);
      if ((request.body?.baselineDocument || request.body?.baseline) && !baselineDocument) {
        response.status(400).json({ detail: "baselineDocument must be documentA or documentB" });
        return;
      }

      const job = await jobs.submit({ documentA, documentB, baselineDocument });
      response.status(202).json({
        jobId: job.id,
        status: job.status,
        baselineDocument: job.baselineDocument,
        statusUrl: `/v1/table-comparisons/${job.id}`,
        resultUrl: `/v1/table-comparisons/${job.id}/result`,
        redlinePdfUrl: `/v1/table-comparisons/${job.id}/redline.pdf`,
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/v1/table-comparisons/:jobId", async (request, response) => {
  const job = await jobs.get(request.params.jobId);
  if (!job) {
    response.status(404).json({ detail: "Job not found" });
    return;
  }
  response.json(serializeJob(job));
});

app.get("/v1/table-comparisons/:jobId/result", async (request, response) => {
  const job = await jobs.get(request.params.jobId);
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

app.get("/v1/table-comparisons/:jobId/redline.pdf", async (request, response) => {
  const job = await jobs.get(request.params.jobId);
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

const server = app.listen(port, () => {
  console.log(`table comparison API listening on :${port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await jobs.close();
}

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

function serializeJob(job: CompareJobRecord) {
  return {
    jobId: job.id,
    status: job.status,
    files: job.files,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    baselineDocument: job.baselineDocument,
    error: job.error,
    resultUrl: `/v1/table-comparisons/${job.id}/result`,
    redlinePdfUrl: `/v1/table-comparisons/${job.id}/redline.pdf`,
  };
}

function parseBaselineDocument(value: unknown): "documentA" | "documentB" | undefined {
  if (value === "documentA" || value === "documentB") {
    return value;
  }
  return undefined;
}
