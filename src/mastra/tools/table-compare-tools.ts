import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { compareFirstTables } from "../../table-compare/table-compare";
import type { ExtractedTable } from "../../table-compare/types";

export const compareParsedTablesTool = createTool({
  id: "compare-mineru-parsed-tables",
  description:
    "Compare two MinerU-extracted table structures cell by cell and return the exact changed cells plus their source bounding boxes.",
  inputSchema: z.object({
    tableA: z.any().describe("First ExtractedTable produced by parse-document-tables-with-mineru."),
    tableB: z.any().describe("Second ExtractedTable produced by parse-document-tables-with-mineru."),
  }),
  outputSchema: z.object({
    different: z.boolean(),
    summary: z.string(),
    explanation: z.string(),
    differences: z.array(z.any()),
    tableA: z.any(),
    tableB: z.any(),
  }),
  execute: async ({ tableA, tableB }) => compareFirstTables(tableA as ExtractedTable, tableB as ExtractedTable),
});
