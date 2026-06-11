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

export interface ParseDocumentPairTablesInput {
  documentAPath: string;
  documentBPath: string;
  documentAName?: string;
  documentBName?: string;
  geometryWorkDirA?: string;
  geometryWorkDirB?: string;
  mineru?: MinerUClient;
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

export async function parseDocumentPairTables(input: ParseDocumentPairTablesInput) {
  const client = input.mineru ?? defaultMineruClient();
  const [documentA, documentB] = await Promise.all([
    parseDocumentTables({
      filePath: input.documentAPath,
      fileName: input.documentAName ?? input.documentAPath,
      geometryWorkDir: input.geometryWorkDirA,
      mineru: client,
    }),
    parseDocumentTables({
      filePath: input.documentBPath,
      fileName: input.documentBName ?? input.documentBPath,
      geometryWorkDir: input.geometryWorkDirB,
      mineru: client,
    }),
  ]);
  return { documentA, documentB };
}

export const parseDocumentTablesTool = createTool({
  id: "parse-document-tables-with-mineru",
  description:
    "Parse one document with the local MinerU API and return structured table HTML, table bounding boxes, page geometry, and cell grid data.",
  inputSchema: z.object({
    filePath: z.string().describe("Absolute path to a PDF, DOC/DOCX, or image file accessible to this runtime."),
    fileName: z.string().optional().describe("Display name for the document."),
    geometryWorkDir: z.string().optional().describe("Optional directory for rendered page images used to refine table cell geometry."),
  }),
  outputSchema: z.object({
    fileName: z.string(),
    mineruTaskId: z.string(),
    tables: z.array(z.any()),
    pages: z.array(z.any()),
  }),
  execute: async ({ filePath, fileName, geometryWorkDir }) => {
    const tables = await parseDocumentTables({ filePath, fileName, geometryWorkDir });
    return {
      fileName: tables.fileName,
      mineruTaskId: tables.mineruTaskId,
      tables: tables.tables,
      pages: tables.pages,
    };
  },
});

export const parseDocumentPairTablesTool = createTool({
  id: "parse-document-pair-tables-with-mineru",
  description:
    "Parse two documents with the local MinerU API and return structured table data for documentA and documentB. Use this for table comparison requests so the two inputs cannot be mixed up.",
  inputSchema: z.object({
    documentAPath: z.string().describe("Absolute path to the first document."),
    documentBPath: z.string().describe("Absolute path to the second document."),
    documentAName: z.string().optional().describe("Display name for the first document."),
    documentBName: z.string().optional().describe("Display name for the second document."),
    geometryWorkDirA: z.string().optional().describe("Optional geometry artifact directory for document A."),
    geometryWorkDirB: z.string().optional().describe("Optional geometry artifact directory for document B."),
  }),
  outputSchema: z.object({
    documentA: z.any(),
    documentB: z.any(),
  }),
  execute: async ({ documentAPath, documentBPath, documentAName, documentBName, geometryWorkDirA, geometryWorkDirB }) =>
    parseDocumentPairTables({
      documentAPath,
      documentBPath,
      documentAName,
      documentBName,
      geometryWorkDirA,
      geometryWorkDirB,
    }),
});
