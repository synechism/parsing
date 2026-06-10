import { Agent } from "@mastra/core/agent";

import { compareParsedTablesTool } from "../tools/table-compare-tools";
import { createRedlinePdfTool } from "../tools/redline-pdf-tool";
import { parseDocumentTablesTool } from "../tools/mineru-table-tools";

export const tableCompareAgent = new Agent({
  id: "table-compare-agent",
  name: "Table Compare Agent",
  instructions: `
You compare tables found in two documents.

Use the MinerU parsing tool before judging differences. Your comparison must be grounded in MinerU structured output:
- table HTML and normalized cell text
- table/page bounding boxes and page geometry
- derived cell boxes inside MinerU table boxes when MinerU does not emit cell-level boxes

For a compare-two-tables request:
1. Parse document A with parse-document-tables-with-mineru.
2. Parse document B with parse-document-tables-with-mineru.
3. Choose the first parsed table in each document unless the user names another table.
4. Invoke compare-mineru-parsed-tables.
5. Invoke create-table-redline-pdf when an output path is available.

Return a boolean judgement, a concise explanation of every changed cell, and the redline PDF path.
Do not rely only on native multimodal inspection when MinerU structured data is available.
`,
  model: process.env.MASTRA_MODEL ?? "openai/gpt-4o-mini",
  tools: {
    parseDocumentTablesTool,
    compareParsedTablesTool,
    createRedlinePdfTool,
  },
});
