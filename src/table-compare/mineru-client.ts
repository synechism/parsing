import { readFile } from "node:fs/promises";
import path from "node:path";

import type { MinerUOptions } from "./types";

const DEFAULT_OPTIONS: Required<MinerUOptions> = {
  lang: "en",
  backend: "hybrid-auto-engine",
  parseMethod: "auto",
  formulaEnable: true,
  tableEnable: true,
  imageAnalysis: true,
  startPageId: 0,
  endPageId: 99999,
};

export interface MinerUClientConfig {
  baseUrl: string;
  pollIntervalMs?: number;
  resultTimeoutMs?: number;
}

export class MinerUClient {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly resultTimeoutMs: number;

  constructor(config: MinerUClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.resultTimeoutMs = config.resultTimeoutMs ?? 30 * 60_000;
  }

  async health(): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`MinerU health failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  async parseDocument(filePath: string, options: MinerUOptions = {}): Promise<{ taskId: string; result: unknown }> {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const fileName = path.basename(filePath);
    const form = new FormData();
    const bytes = await readFile(filePath);

    form.append("files", new Blob([bytes], { type: guessMimeType(fileName) }), fileName);
    form.append("lang_list", merged.lang);
    form.append("backend", merged.backend);
    form.append("parse_method", merged.parseMethod);
    form.append("formula_enable", String(merged.formulaEnable));
    form.append("table_enable", String(merged.tableEnable));
    form.append("image_analysis", String(merged.imageAnalysis));
    form.append("return_md", "true");
    form.append("return_middle_json", "true");
    form.append("return_model_output", "false");
    form.append("return_content_list", "true");
    form.append("return_images", "false");
    form.append("response_format_zip", "false");
    form.append("start_page_id", String(merged.startPageId));
    form.append("end_page_id", String(merged.endPageId));

    const submit = await fetch(`${this.baseUrl}/tasks`, {
      method: "POST",
      body: form,
    });
    if (!submit.ok) {
      throw new Error(`MinerU task submit failed: ${submit.status} ${await submit.text()}`);
    }

    const submitted = (await submit.json()) as { task_id?: string; taskId?: string };
    const taskId = submitted.task_id ?? submitted.taskId;
    if (!taskId) {
      throw new Error(`MinerU response did not include a task id: ${JSON.stringify(submitted)}`);
    }

    const result = await this.waitForResult(taskId);
    return { taskId, result };
  }

  private async waitForResult(taskId: string): Promise<unknown> {
    const deadline = Date.now() + this.resultTimeoutMs;
    let lastStatus: unknown;

    while (Date.now() < deadline) {
      const statusResponse = await fetch(`${this.baseUrl}/tasks/${taskId}`);
      if (!statusResponse.ok) {
        throw new Error(`MinerU task status failed: ${statusResponse.status} ${await statusResponse.text()}`);
      }
      const status = (await statusResponse.json()) as { status?: string; error?: string };
      lastStatus = status;

      if (status.status === "completed") {
        const resultResponse = await fetch(`${this.baseUrl}/tasks/${taskId}/result`);
        if (!resultResponse.ok) {
          throw new Error(`MinerU task result failed: ${resultResponse.status} ${await resultResponse.text()}`);
        }
        return resultResponse.json();
      }
      if (status.status === "failed") {
        throw new Error(status.error ?? `MinerU task ${taskId} failed`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new Error(`Timed out waiting for MinerU task ${taskId}: ${JSON.stringify(lastStatus)}`);
  }
}

function guessMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".doc")) {
    return "application/msword";
  }
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  return "application/octet-stream";
}
