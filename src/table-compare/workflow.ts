import { mastra } from "../mastra";
import type { TableComparisonResult } from "./types";

export interface CompareTwoDocumentsInput {
  documentAPath: string;
  documentBPath: string;
  outputDirectory: string;
}

const AGENT_REGISTRY_NAME = "tableCompareAgent";
const SKILL_TOOL_KEY = "compareTwoTablesSkillTool";
const SKILL_TOOL_ID = "compare-two-tables-skill";

export async function compareTwoDocuments(input: CompareTwoDocumentsInput): Promise<TableComparisonResult> {
  const agent = mastra.getAgent(AGENT_REGISTRY_NAME);
  let toolResult: TableComparisonResult | undefined;

  const response = await agent.generate(
    `
Run the compare-two-tables skill now.

Inputs:
- documentAPath: ${JSON.stringify(input.documentAPath)}
- documentBPath: ${JSON.stringify(input.documentBPath)}
- outputDirectory: ${JSON.stringify(input.outputDirectory)}

Call ${SKILL_TOOL_ID} exactly once with these exact paths. Do not answer from vision or memory.
After the tool returns, summarize whether the tables differ.
`,
    {
      maxSteps: 4,
      activeTools: [SKILL_TOOL_KEY],
      modelSettings: {
        temperature: 0,
      },
      onStepFinish: (step: any) => {
        toolResult = extractSkillToolResult(step) ?? toolResult;
      },
    },
  );

  toolResult = extractSkillToolResult(response as any) ?? toolResult;

  if (!toolResult) {
    throw new Error("tableCompareAgent did not execute compare-two-tables-skill");
  }

  return {
    ...toolResult,
    agent: {
      ...(toolResult.agent ?? {}),
      id: agent.id,
      registryName: AGENT_REGISTRY_NAME,
      skill: "compare-two-tables",
      toolCalls: toolResult.agent?.toolCalls ?? [SKILL_TOOL_ID],
      invokedByApi: true,
      responseText: typeof (response as any).text === "string" ? (response as any).text : toolResult.agent?.responseText,
    },
  };
}

function extractSkillToolResult(value: any): TableComparisonResult | undefined {
  const candidates = [
    ...(Array.isArray(value?.toolResults) ? value.toolResults : []),
    ...(Array.isArray(value?.steps) ? value.steps.flatMap((step: any) => step.toolResults ?? []) : []),
  ];

  for (const candidate of candidates) {
    const toolName = candidate.toolName ?? candidate.toolCall?.toolName ?? candidate.payload?.toolName;
    if (toolName !== SKILL_TOOL_KEY && toolName !== SKILL_TOOL_ID) {
      continue;
    }
    const output = candidate.result ?? candidate.output ?? candidate.payload?.result;
    if (output && typeof output === "object" && "different" in output) {
      return output as TableComparisonResult;
    }
  }

  return undefined;
}
