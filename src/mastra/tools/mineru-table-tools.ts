import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { MinerUClient } from "../../table-compare/mineru-client";
import { extractTablesFromMinerUResult } from "../../table-compare/table-extractor";
import { refineDocumentTablesWithPdfRulingLines } from "../../table-compare/table-geometry";

function defaultMineruClient(): MinerUClient {
  return new MinerUClient({
    baseUrl: process.env.MINERU_BASE_URL ?? "http://127.0.0.1:8000",
    resultTimeoutMs: Number(process.env.JOB_RESULT_TIMEOUT_SECONDS ?? 7200) * 1000,
  });
}

export interface ParseDocumentTablesInput {
  filePath: string;
  fileName?: string;
  mineru?: MinerUClient;
  geometryWorkDir?: string;
}

export async function parseDocumentTables(input: ParseDocumentTablesInput) {
  const client = input.mineru ?? defaultMineruClient();
  const parsed = await client.parseDocument(input.filePath);
  return refineDocumentTablesWithPdfRulingLines(
    input.filePath,
    extractTablesFromMinerUResult(parsed.result, input.fileName ?? input.filePath, parsed.taskId),
    input.geometryWorkDir,
  );
}

export const parseDocumentTablesTool = createTool({
  id: "parse-document-tables-with-mineru",
  description:
    "Parse one document with the local MinerU API and return structured table HTML, table bounding boxes, page geometry, and cell grid data.",
  inputSchema: z.object({
    filePath: z.string().describe("Absolute path to a PDF, DOC/DOCX, or image file accessible to this runtime."),
    fileName: z.string().optional().describe("Display name for the document."),
  }),
  outputSchema: z.object({
    fileName: z.string(),
    mineruTaskId: z.string(),
    tables: z.array(z.any()),
    pages: z.array(z.any()),
  }),
  execute: async ({ filePath, fileName }) => {
    const tables = await parseDocumentTables({ filePath, fileName });
    return {
      fileName: tables.fileName,
      mineruTaskId: tables.mineruTaskId,
      tables: tables.tables,
      pages: tables.pages,
    };
  },
});
