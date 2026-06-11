import path from "node:path";

import { mastra } from "../mastra";
import { createRedlinePdf } from "./redline";
import {
  buildSameFormatCandidateReviewPrompt,
  buildSemanticComparisonPrompt,
  buildSemanticComparisonResult,
  needsSameFormatCandidateReview,
  parseSemanticComparisonPlanText,
  type SemanticComparisonPlan,
} from "./semantic-compare";
import type { ParsedDocumentTables, TableComparisonResult } from "./types";

export interface CompareTwoDocumentsInput {
  documentAPath: string;
  documentBPath: string;
  outputDirectory: string;
  baselineDocument?: "documentA" | "documentB";
}

const AGENT_REGISTRY_NAME = "semanticTableCompareAgent";
const PARSE_PAIR_TOOL_KEY = "parseDocumentPairTablesTool";
const PARSE_PAIR_TOOL_ID = "parse-document-pair-tables-with-mineru";
type SemanticAgent = Awaited<ReturnType<typeof mastra.getAgent>>;

export async function compareTwoDocuments(input: CompareTwoDocumentsInput): Promise<TableComparisonResult> {
  const agent = mastra.getAgent(AGENT_REGISTRY_NAME);
  const baselineDocument = input.baselineDocument ?? "documentB";
  const parsed = await parseDocumentsWithSemanticAgent(agent, input);

  if (parsed.documentA.tables.length === 0 || parsed.documentB.tables.length === 0) {
    throw new Error(
      `Expected at least one table in each document; found ${parsed.documentA.tables.length} in A and ${parsed.documentB.tables.length} in B`,
    );
  }

  const tableA = parsed.documentA.tables[0];
  const tableB = parsed.documentB.tables[0];
  const prompt = buildSemanticComparisonPrompt(tableA, tableB, baselineDocument);
  const { plan, responseText } = await runSemanticJudgement(agent, prompt, tableA, tableB);
  const comparison = buildSemanticComparisonResult(tableA, tableB, plan, { baselineDocument });
  const baselineDocumentPath = comparison.baselineDocument === "documentA" ? input.documentAPath : input.documentBPath;
  const redlinePdfPath = await createRedlinePdf(
    comparison,
    baselineDocumentPath,
    path.join(input.outputDirectory, "redline.pdf"),
    comparison.baselineDocument,
  );

  return {
    ...comparison,
    redlinePdfPath,
    agent: {
      id: agent.id,
      registryName: AGENT_REGISTRY_NAME,
      skill: "compare-two-tables",
      toolCalls: [PARSE_PAIR_TOOL_ID, "semantic-table-compare-agent", "create-table-redline-pdf"],
      invokedByApi: true,
      responseText,
    },
  };
}

async function parseDocumentsWithSemanticAgent(
  agent: SemanticAgent,
  input: CompareTwoDocumentsInput,
): Promise<{ documentA: ParsedDocumentTables; documentB: ParsedDocumentTables }> {
  const documentAName = `documentA:${path.basename(input.documentAPath)}`;
  const documentBName = `documentB:${path.basename(input.documentBPath)}`;
  let parseResult: { documentA: ParsedDocumentTables; documentB: ParsedDocumentTables } | undefined;

  const response = await agent.generate(
    `
Parse these two documents with MinerU before any comparison.

Call ${PARSE_PAIR_TOOL_ID} exactly once with these exact arguments:
- documentAPath: ${JSON.stringify(input.documentAPath)}
- documentBPath: ${JSON.stringify(input.documentBPath)}
- documentAName: ${JSON.stringify(documentAName)}
- documentBName: ${JSON.stringify(documentBName)}
- geometryWorkDirA: ${JSON.stringify(path.join(input.outputDirectory, "geometry-a"))}
- geometryWorkDirB: ${JSON.stringify(path.join(input.outputDirectory, "geometry-b"))}

After the tool call finishes, respond only with a short confirmation. Do not judge table differences in this step.
`,
    {
      maxSteps: 5,
      activeTools: [PARSE_PAIR_TOOL_KEY],
      modelSettings: {
        temperature: 0,
      },
      onStepFinish: (step: any) => {
        parseResult = extractParsePairToolResult(step) ?? parseResult;
      },
    },
  );

  parseResult = extractParsePairToolResult(response as any) ?? parseResult;

  if (!parseResult) {
    throw new Error("semanticTableCompareAgent did not parse both documents with MinerU");
  }

  return parseResult;
}

async function runSemanticJudgement(
  agent: SemanticAgent,
  prompt: string,
  tableA: ParsedDocumentTables["tables"][number],
  tableB: ParsedDocumentTables["tables"][number],
): Promise<{ plan: SemanticComparisonPlan; responseText: string }> {
  const response = await agent.generate(prompt, {
    activeTools: [],
    modelSettings: { temperature: 0, maxOutputTokens: 4096 },
  });
  const responseText = typeof (response as any).text === "string" ? (response as any).text : "";
  const parsed = await parseSemanticPlanOrRepair(agent, prompt, responseText);
  return reviewSameFormatCandidates(agent, prompt, tableA, tableB, parsed.plan, parsed.responseText);
}

async function parseSemanticPlanOrRepair(
  agent: SemanticAgent,
  prompt: string,
  text: string,
): Promise<{ plan: SemanticComparisonPlan; responseText: string }> {
  let candidate = text;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return { plan: parseSemanticComparisonPlanText(candidate), responseText: candidate };
    } catch (error) {
      lastError = error;
    }

    const repair = await agent.generate(
      `${prompt}

Your previous response could not be parsed as the required JSON object.
Parse error: ${lastError instanceof Error ? lastError.message : String(lastError)}

Return only a valid JSON object matching the requested schema. Do not include markdown or commentary.
Use strict JSON: double-quoted property names and string values, escaped inner quotes, no trailing commas, no comments.
Previous response:
${candidate}`,
      {
        activeTools: [],
        modelSettings: { temperature: 0, maxOutputTokens: 4096 },
      },
    );
    candidate = (repair as any).text ?? "";
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function reviewSameFormatCandidates(
  agent: SemanticAgent,
  prompt: string,
  tableA: ParsedDocumentTables["tables"][number],
  tableB: ParsedDocumentTables["tables"][number],
  plan: SemanticComparisonPlan,
  responseText: string,
): Promise<{ plan: SemanticComparisonPlan; responseText: string }> {
  if (!needsSameFormatCandidateReview(tableA, tableB, plan)) {
    return { plan, responseText };
  }

  const reviewPrompt = buildSameFormatCandidateReviewPrompt(prompt, tableA, tableB, plan);
  const review = await agent.generate(reviewPrompt, {
    activeTools: [],
    modelSettings: { temperature: 0, maxOutputTokens: 4096 },
  });
  return parseSemanticPlanOrRepair(agent, reviewPrompt, (review as any).text ?? "");
}

function extractParsePairToolResult(value: any): { documentA: ParsedDocumentTables; documentB: ParsedDocumentTables } | undefined {
  const candidates = [
    ...(Array.isArray(value?.toolResults) ? value.toolResults : []),
    ...(Array.isArray(value?.steps) ? value.steps.flatMap((step: any) => step.toolResults ?? []) : []),
  ];

  for (const candidate of candidates) {
    const toolName = candidate.toolName ?? candidate.toolCall?.toolName ?? candidate.payload?.toolName;
    if (toolName !== PARSE_PAIR_TOOL_KEY && toolName !== PARSE_PAIR_TOOL_ID) {
      continue;
    }
    const output = candidate.result ?? candidate.output ?? candidate.payload?.result;
    if (isParsedDocumentPair(output)) {
      return output;
    }
  }

  return undefined;
}

function isParsedDocumentPair(value: unknown): value is { documentA: ParsedDocumentTables; documentB: ParsedDocumentTables } {
  const candidate = value as { documentA?: unknown; documentB?: unknown };
  return isParsedDocumentTables(candidate?.documentA) && isParsedDocumentTables(candidate?.documentB);
}

function isParsedDocumentTables(value: unknown): value is ParsedDocumentTables {
  const candidate = value as ParsedDocumentTables;
  return Boolean(
    candidate &&
      typeof candidate === "object" &&
      typeof candidate.fileName === "string" &&
      typeof candidate.mineruTaskId === "string" &&
      Array.isArray(candidate.tables) &&
      Array.isArray(candidate.pages),
  );
}
