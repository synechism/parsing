import path from "node:path";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { compareFirstTables } from "../../table-compare/table-compare";
import { createRedlinePdf } from "../../table-compare/redline";
import type { ExtractedTable, TableComparisonResult } from "../../table-compare/types";
import { parseDocumentTables } from "./mineru-table-tools";

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

export const compareTwoTablesSkillTool = createTool({
  id: "compare-two-tables-skill",
  description:
    "Run the full compare-two-tables skill: parse both documents with MinerU, compare the first parsed table, and create a redline PDF.",
  inputSchema: z.object({
    documentAPath: z.string().describe("Absolute path to the first document."),
    documentBPath: z.string().describe("Absolute path to the second document."),
    outputDirectory: z.string().describe("Directory where redline.pdf and geometry artifacts should be written."),
  }),
  outputSchema: z.any(),
  execute: async ({ documentAPath, documentBPath, outputDirectory }) => {
    const [documentA, documentB] = await Promise.all([
      parseDocumentTables({
        filePath: documentAPath,
        fileName: path.basename(documentAPath),
        geometryWorkDir: path.join(outputDirectory, "geometry-a"),
      }),
      parseDocumentTables({
        filePath: documentBPath,
        fileName: path.basename(documentBPath),
        geometryWorkDir: path.join(outputDirectory, "geometry-b"),
      }),
    ]);

    if (documentA.tables.length === 0 || documentB.tables.length === 0) {
      throw new Error(
        `Expected at least one table in each document; found ${documentA.tables.length} in A and ${documentB.tables.length} in B`,
      );
    }

    const comparison: TableComparisonResult = compareFirstTables(documentA.tables[0], documentB.tables[0]);
    const redlinePdfPath = await createRedlinePdf(
      comparison,
      documentBPath,
      path.join(outputDirectory, "redline.pdf"),
    );

    return {
      ...comparison,
      redlinePdfPath,
      agent: {
        id: "table-compare-agent",
        registryName: "tableCompareAgent",
        skill: "compare-two-tables",
        toolCalls: [
          "compare-two-tables-skill",
          "parse-document-tables-with-mineru",
          "parse-document-tables-with-mineru",
          "compare-mineru-parsed-tables",
          "create-table-redline-pdf",
        ],
      },
    };
  },
  toModelOutput: (output: TableComparisonResult) => ({
    type: "json",
    value: {
      different: output.different,
      summary: output.summary,
      explanation: output.explanation,
      redlinePdfPath: output.redlinePdfPath,
      differences: output.differences.map((difference) => ({
        kind: difference.kind,
        ref: difference.ref,
        before: difference.before,
        after: difference.after,
        bboxB: difference.bboxB,
        pageIndexB: difference.pageIndexB,
      })),
    },
  }),
});
