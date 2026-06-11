import path from "node:path";

import { mastra } from "../mastra";
import { createRedlinePdf } from "./redline";
import {
  applyTableSectionSelection,
  buildSemanticComparisonPrompt,
  buildSemanticComparisonResult,
  buildTableSelectionPrompt,
  mergeSameFormatCandidateDifferences,
  normalizeTableSelectionPlan,
  parseSemanticComparisonPlanText,
  parseTableSelectionPlanText,
  semanticComparisonPlanSchema,
  tableSelectionPlanSchema,
  type SemanticComparisonPlan,
  type TableSelectionPlan,
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
const semanticAgentCallTimeoutMs = Number(process.env.TABLE_COMPARE_AGENT_CALL_TIMEOUT_MS ?? 180_000);
const semanticAgentAttempts = Number(process.env.TABLE_COMPARE_AGENT_ATTEMPTS ?? 6);
const semanticRepairAttempts = Number(process.env.TABLE_COMPARE_AGENT_REPAIR_ATTEMPTS ?? 4);
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

  const selection = await selectComparableTableSections(agent, parsed);
  const tableA = applyTableSectionSelection(parsed.documentA, selection.documentA);
  const tableB = applyTableSectionSelection(parsed.documentB, selection.documentB);
  const prompt = buildSemanticComparisonPrompt(tableA, tableB, baselineDocument);
  const { plan, responseText } = await runSemanticJudgement(agent, prompt, tableA, tableB);
  const comparison = buildSemanticComparisonResult(tableA, tableB, plan, { baselineDocument, selection });
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
      toolCalls: [PARSE_PAIR_TOOL_ID, "semantic-table-section-selection", "semantic-table-compare-agent", "create-table-redline-pdf"],
      invokedByApi: true,
      responseText,
    },
  };
}

async function selectComparableTableSections(
  agent: SemanticAgent,
  parsed: { documentA: ParsedDocumentTables; documentB: ParsedDocumentTables },
): Promise<TableSelectionPlan> {
  const prompt = buildTableSelectionPrompt(parsed.documentA, parsed.documentB);
  let lastError: unknown;

  for (let attempt = 0; attempt < semanticAgentAttempts; attempt += 1) {
    try {
      const { object: plan } = await generateStructuredWithTimeout<TableSelectionPlan>(
        agent,
        prompt,
        tableSelectionPlanSchema,
        "table-section-selection",
        4096,
      );
      return normalizeTableSelectionPlan(parsed.documentA, parsed.documentB, plan);
    } catch (error) {
      lastError = error;
      console.warn(`semantic table-section selection attempt ${attempt + 1} failed`, error);
      await delay(750 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  let lastError: unknown;

  for (let attempt = 0; attempt < semanticAgentAttempts; attempt += 1) {
    try {
      const generated = await generateStructuredWithTimeout<SemanticComparisonPlan>(
        agent,
        prompt,
        semanticComparisonPlanSchema,
        "semantic-table-judgement",
        8192,
      );
      return await reviewSameFormatCandidates(agent, prompt, tableA, tableB, generated.object, generated.responseText);
    } catch (error) {
      lastError = error;
      console.warn(`semantic table judgement attempt ${attempt + 1} failed`, error);
      await delay(750 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function parseSemanticPlanOrRepair(
  agent: SemanticAgent,
  prompt: string,
  text: string,
): Promise<{ plan: SemanticComparisonPlan; responseText: string }> {
  let candidate = text;
  let lastError: unknown;

  for (let attempt = 0; attempt < semanticRepairAttempts; attempt += 1) {
    try {
      return { plan: parseSemanticComparisonPlanText(candidate), responseText: candidate };
    } catch (error) {
      lastError = error;
    }

    const repair = await generateWithTimeout(
      agent,
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

async function parseTableSelectionPlanOrRepair(
  agent: SemanticAgent,
  prompt: string,
  text: string,
): Promise<TableSelectionPlan> {
  let candidate = text;
  let lastError: unknown;

  for (let attempt = 0; attempt < semanticRepairAttempts; attempt += 1) {
    try {
      return parseTableSelectionPlanText(candidate);
    } catch (error) {
      lastError = error;
    }

    const repair = await generateWithTimeout(
      agent,
      `${prompt}

Your previous response could not be parsed as the required JSON table selection object.
Parse error: ${lastError instanceof Error ? lastError.message : String(lastError)}

Return only strict JSON matching the requested table-selection schema. Do not include markdown, comments, or trailing commas.
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
  void agent;
  void prompt;
  return { plan: mergeSameFormatCandidateDifferences(tableA, tableB, plan), responseText };
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

async function generateWithTimeout(agent: SemanticAgent, prompt: string, options: Record<string, unknown>): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`semantic agent call timed out after ${semanticAgentCallTimeoutMs}ms`));
  }, semanticAgentCallTimeoutMs);

  try {
    return await Promise.race([
      (agent as any).generate(prompt, {
        ...options,
        abortSignal: controller.signal,
        timeout: semanticAgentCallTimeoutMs,
      }),
      new Promise((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason ?? new Error(`semantic agent call timed out after ${semanticAgentCallTimeoutMs}ms`)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function generateStructuredWithTimeout<T>(
  agent: SemanticAgent,
  prompt: string,
  schema: unknown,
  label: string,
  maxOutputTokens: number,
): Promise<{ object: T; responseText: string }> {
  const response = await generateWithTimeout(agent, prompt, {
    activeTools: [],
    toolChoice: "none",
    modelSettings: { temperature: 0, maxOutputTokens, maxRetries: 2 },
    structuredOutput: {
      schema,
      errorStrategy: "strict",
    },
  });
  const object = (response as any).object;
  if (!object) {
    throw new Error(`${label} did not produce structured object: ${summarizeAgentResponse(response)}`);
  }
  const responseText = typeof (response as any).text === "string" && (response as any).text.trim().length > 0
    ? (response as any).text
    : JSON.stringify(object);
  return { object, responseText };
}

function summarizeAgentResponse(response: any): string {
  return JSON.stringify({
    textLength: typeof response?.text === "string" ? response.text.length : null,
    textPreview: typeof response?.text === "string" ? response.text.slice(0, 240) : undefined,
    finishReason: response?.finishReason,
    usage: response?.usage,
    hasObject: Boolean(response?.object),
    headers: {
      traceId: response?.response?.headers?.["x-ds-trace-id"],
      contentType: response?.response?.headers?.["content-type"],
    },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
