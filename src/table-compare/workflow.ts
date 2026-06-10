import path from "node:path";

import { compareFirstTables } from "./table-compare";
import { extractTablesFromMinerUResult } from "./table-extractor";
import { createRedlinePdf } from "./redline";
import type { MinerUClient } from "./mineru-client";
import type { MinerUOptions, TableComparisonResult } from "./types";

export interface CompareTwoDocumentsInput {
  documentAPath: string;
  documentBPath: string;
  outputDirectory: string;
  mineru: MinerUClient;
  options?: MinerUOptions;
}

export async function compareTwoDocuments(input: CompareTwoDocumentsInput): Promise<TableComparisonResult> {
  const [parsedA, parsedB] = await Promise.all([
    input.mineru.parseDocument(input.documentAPath, input.options),
    input.mineru.parseDocument(input.documentBPath, input.options),
  ]);

  const tablesA = extractTablesFromMinerUResult(parsedA.result, path.basename(input.documentAPath), parsedA.taskId);
  const tablesB = extractTablesFromMinerUResult(parsedB.result, path.basename(input.documentBPath), parsedB.taskId);

  if (tablesA.tables.length === 0 || tablesB.tables.length === 0) {
    throw new Error(
      `Expected at least one table in each document; found ${tablesA.tables.length} in A and ${tablesB.tables.length} in B`,
    );
  }

  const comparison = compareFirstTables(tablesA.tables[0], tablesB.tables[0]);
  const redlinePdfPath = await createRedlinePdf(
    comparison,
    input.documentBPath,
    path.join(input.outputDirectory, "redline.pdf"),
  );

  return { ...comparison, redlinePdfPath };
}
