import { Mastra } from "@mastra/core";

import { semanticTableCompareAgent } from "./agents/semantic-table-compare-agent";

export const mastra = new Mastra({
  agents: { semanticTableCompareAgent },
});
