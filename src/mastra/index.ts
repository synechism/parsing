import { Mastra } from "@mastra/core";

import { tableCompareAgent } from "./agents/table-compare-agent";

export const mastra = new Mastra({
  agents: { tableCompareAgent },
});
