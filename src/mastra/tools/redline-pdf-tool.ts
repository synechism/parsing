import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { createRedlinePdf } from "../../table-compare/redline";
import type { TableComparisonResult } from "../../table-compare/types";

export const createRedlinePdfTool = createTool({
  id: "create-table-redline-pdf",
  description:
    "Create a PDF overlay that marks table differences using MinerU-derived page coordinates and bounding boxes.",
  inputSchema: z.object({
    comparison: z.any().describe("TableComparisonResult produced by compare-mineru-parsed-tables."),
    documentBPath: z.string().describe("Path to the second/source PDF. The redline is drawn on this document when it is a PDF."),
    outputPath: z.string().describe("Absolute destination path for the redlined PDF."),
  }),
  outputSchema: z.object({
    redlinePdfPath: z.string(),
  }),
  execute: async ({ comparison, documentBPath, outputPath }) => ({
    redlinePdfPath: await createRedlinePdf(comparison as TableComparisonResult, documentBPath, outputPath),
  }),
});
