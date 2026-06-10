import { Agent } from "@mastra/core/agent";

import { compareParsedTablesTool, compareTwoTablesSkillTool } from "../tools/table-compare-tools";
import { createRedlinePdfTool } from "../tools/redline-pdf-tool";
import { parseDocumentTablesTool } from "../tools/mineru-table-tools";

function defaultModel(): string {
  if (process.env.MASTRA_MODEL) {
    return process.env.MASTRA_MODEL;
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return "anthropic/deepseek-v4-flash";
  }
  return "openai/gpt-4o-mini";
}

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
1. Prefer invoking compare-two-tables-skill with the two document paths and output directory.
2. That skill parses both documents with MinerU, compares the first parsed table, and creates the redline PDF.
3. If explicitly asked to inspect intermediate state, use parse-document-tables-with-mineru, compare-mineru-parsed-tables, and create-table-redline-pdf directly.

Return a boolean judgement, a concise explanation of every changed cell, and the redline PDF path.
Do not rely only on native multimodal inspection when MinerU structured data is available.
`,
  model: defaultModel(),
  tools: {
    compareTwoTablesSkillTool,
    parseDocumentTablesTool,
    compareParsedTablesTool,
    createRedlinePdfTool,
  },
});
