import { Agent } from "@mastra/core/agent";

import { defaultModel } from "../model";
import { parseDocumentPairTablesTool } from "../tools/mineru-table-tools";

export const semanticTableCompareAgent = new Agent({
  id: "semantic-table-compare-agent",
  name: "Semantic Table Compare Agent",
  instructions: `
You compare two parsed tables semantically.

When given document paths, invoke parse-document-pair-tables-with-mineru before judging differences.
When given already parsed MinerU table evidence, use that structured evidence directly.

You receive MinerU-grounded table cells with stable refs such as A1, B3, row indexes, column indexes, and text.
Your job is to decide which columns and rows mean the same thing, even when:
- row order differs;
- headers use different names;
- templates have extra columns;
- one document is a payable/order table and the other is an invoice/confirmation table;
- part descriptions are phrased differently but refer to the same item.

Do not assume same row order or same column order.
Do not mark style, order, or purely non-comparable extra template columns as differences.
Do mark material business-content differences in shared or semantically relevant fields.
Use only the provided structured cell text. Return concise explanations suitable for redline labels.
`,
  model: defaultModel(),
  tools: {
    parseDocumentPairTablesTool,
  },
});
