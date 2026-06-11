import { z } from "zod";

import { compareFirstTables } from "./table-compare";
import type { BBox, ExtractedCell, ExtractedTable, TableComparisonResult, TableDifference } from "./types";

export const semanticComparisonPlanSchema = z.object({
  different: z.boolean(),
  summary: z.string(),
  explanation: z.string(),
  rowMatches: z
    .array(
      z.object({
        rowIndexA: z.number(),
        rowIndexB: z.number(),
        rationale: z.string().optional(),
        confidence: z.number().optional(),
      }),
    )
    .optional(),
  differences: z.array(
    z.object({
      kind: z.enum(["cell_changed", "row_added", "row_removed", "shape_changed"]),
      cellRefA: z.string().nullable().optional(),
      cellRefB: z.string().nullable().optional(),
      rowIndexA: z.number().nullable().optional(),
      rowIndexB: z.number().nullable().optional(),
      field: z.string().optional(),
      before: z.string().nullable().optional(),
      after: z.string().nullable().optional(),
      explanation: z.string(),
    }),
  ),
  ignored: z
    .array(
      z.object({
        refsA: z.array(z.string()).optional(),
        refsB: z.array(z.string()).optional(),
        reason: z.string(),
      }),
    )
    .optional(),
});

export type SemanticComparisonPlan = z.infer<typeof semanticComparisonPlanSchema>;

export interface SemanticResultOptions {
  baselineDocument?: "documentA" | "documentB";
}

export function compactTableForSemanticAgent(table: ExtractedTable) {
  const headerRowIndex = Math.min(...table.cells.map((cell) => cell.rowIndex));
  const rows = [...new Set(table.cells.map((cell) => cell.rowIndex))]
    .sort((a, b) => a - b)
    .map((rowIndex) => ({
      rowIndex,
      isHeader: rowIndex === headerRowIndex,
      cells: table.cells
        .filter((cell) => cell.rowIndex === rowIndex)
        .sort((a, b) => a.colIndex - b.colIndex)
        .map((cell) => ({
          ref: cell.ref,
          rowIndex: cell.rowIndex,
          colIndex: cell.colIndex,
          text: cell.text,
        })),
    }));

  return {
    rowCount: table.rowCount,
    colCount: table.colCount,
    rows,
  };
}

export function buildSemanticComparisonPrompt(
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  baselineDocument: "documentA" | "documentB",
): string {
  return `
Compare these two MinerU-extracted tables semantically and return JSON only.

Rules:
- Infer which columns correspond by meaning; do not assume identical headers or positions.
- Infer which rows correspond by business content; do not assume row order.
- Ignore visual style and row/column order.
- Ignore extra template columns when they are not needed to decide whether the business content matches.
- If an extra or missing column is materially required to verify equality, report a shape_changed difference and explain why.
- If the tables have the same apparent format and same row order, compare the corresponding cells directly.
- In same-format/same-order tables, every positional candidate difference is a real semantic difference unless it is literally formatting-only, such as whitespace, punctuation, case, or currency formatting.
- In same-format/same-order tables, changed header labels are material differences. Do not collapse header terms like Revenue vs Sales unless the text is just an abbreviation of the same phrase.
- For each real difference, include the best cellRefA and/or cellRefB so the redline can anchor precisely.
- The top-level explanation must explicitly mention every reported difference, including cell refs when available and before/after values when applicable.
- Use rowIndex values exactly as provided below. Header rows are marked isHeader=true.
- Return no markdown, no code fences, no prose outside JSON.

JSON shape:
{
  "different": boolean,
  "summary": "one sentence",
  "explanation": "concise explanation of the judgement",
  "rowMatches": [
    { "rowIndexA": 1, "rowIndexB": 3, "rationale": "same item despite reordered rows", "confidence": 0.95 }
  ],
  "differences": [
    {
      "kind": "cell_changed" | "row_added" | "row_removed" | "shape_changed",
      "cellRefA": "B3",
      "cellRefB": "D5",
      "rowIndexA": 2,
      "rowIndexB": 4,
      "field": "quantity",
      "before": "10",
      "after": "12",
      "explanation": "Quantity differs for item X: 10 vs 12."
    }
  ],
  "ignored": [
    { "refsA": ["C1"], "refsB": [], "reason": "supplier template lacks this non-essential column" }
  ]
}

If there are no semantic content differences, return "different": false and an empty differences array.

Baseline for redlining: ${baselineDocument}

Document A table:
${JSON.stringify(compactTableForSemanticAgent(tableA), null, 2)}

Document B table:
${JSON.stringify(compactTableForSemanticAgent(tableB), null, 2)}

Candidate positional differences from the same-grid comparison.
These are not final judgement; use them as evidence. If the tables are the same format/order, these are usually the differences to report. If rows/templates differ, decide which candidates are only artifacts of ordering/template changes.
${JSON.stringify(compactCandidateDifferences(tableA, tableB), null, 2)}
`;
}

export function parseSemanticComparisonPlanText(text: string): SemanticComparisonPlan {
  return semanticComparisonPlanSchema.parse(parseJsonObject(text));
}

export function needsSameFormatCandidateReview(
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  plan: SemanticComparisonPlan,
): boolean {
  const candidates = compactCandidateDifferences(tableA, tableB);
  return sameShape(tableA, tableB) && candidates.length > 0 && plan.differences.length < candidates.length;
}

export function buildSameFormatCandidateReviewPrompt(
  originalPrompt: string,
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  plan: SemanticComparisonPlan,
): string {
  return `${originalPrompt}

Review your previous JSON plan against these same-format positional candidate differences:
${JSON.stringify(compactCandidateDifferences(tableA, tableB), null, 2)}

Previous JSON plan:
${JSON.stringify(plan, null, 2)}

The two tables have the same row count, column count, and apparent layout. In this situation, every positional candidate difference MUST be included as a difference unless it is literally formatting-only, such as whitespace, punctuation, case, or currency formatting. Header label changes are material and must be included.

Return a revised valid JSON object. If you still omit a candidate, add an ignored entry explaining why that exact candidate is formatting-only.
Return only JSON.`;
}

export function buildSemanticComparisonResult(
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  plan: SemanticComparisonPlan,
  options: SemanticResultOptions = {},
): TableComparisonResult {
  const baselineDocument = options.baselineDocument ?? "documentB";
  const cellsA = indexCells(tableA);
  const cellsB = indexCells(tableB);
  const differences = plan.different
    ? plan.differences.map((difference) => buildDifference(difference, tableA, tableB, cellsA, cellsB, baselineDocument))
    : [];
  const explanation = plan.different ? ensureExplanationCoversDifferences(plan.explanation, differences) : plan.explanation;

  return {
    different: plan.different,
    summary: plan.summary,
    explanation,
    differences,
    tableA,
    tableB,
    comparisonMode: "semantic",
    baselineDocument,
    semantic: {
      commonFields: [],
      ignoredFieldsA: plan.ignored?.flatMap((ignored) => ignored.refsA ?? []) ?? [],
      ignoredFieldsB: plan.ignored?.flatMap((ignored) => ignored.refsB ?? []) ?? [],
      matchedRows:
        plan.rowMatches?.map((match) => ({
          key: match.rationale ?? `A${match.rowIndexA}:B${match.rowIndexB}`,
          rowIndexA: match.rowIndexA,
          rowIndexB: match.rowIndexB,
          score: match.confidence ?? 1,
        })) ?? [],
    },
  };
}

function ensureExplanationCoversDifferences(explanation: string, differences: TableDifference[]): string {
  const parts = [explanation.trim()];

  for (const difference of differences) {
    const current = parts.join(" ");
    const requiredTerms = [difference.ref, difference.before, difference.after].filter(
      (term): term is string => Boolean(term && term.trim()),
    );
    if (requiredTerms.every((term) => current.includes(term))) {
      continue;
    }

    let detail = difference.explanation?.trim() || `${difference.kind} at ${difference.ref}`;
    if (!detail.includes(difference.ref)) {
      detail = `${difference.ref}: ${detail}`;
    }
    if (difference.before !== null && difference.before !== undefined && !detail.includes(difference.before)) {
      detail = `${detail} Before: ${difference.before}.`;
    }
    if (difference.after !== null && difference.after !== undefined && !detail.includes(difference.after)) {
      detail = `${detail} After: ${difference.after}.`;
    }
    parts.push(ensureSentence(detail));
  }

  return parts.join(" ");
}

function ensureSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function buildDifference(
  planned: SemanticComparisonPlan["differences"][number],
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  cellsA: Map<string, ExtractedCell>,
  cellsB: Map<string, ExtractedCell>,
  baselineDocument: "documentA" | "documentB",
): TableDifference {
  const cellA = planned.cellRefA ? cellsA.get(planned.cellRefA) : undefined;
  const cellB = planned.cellRefB ? cellsB.get(planned.cellRefB) : undefined;
  const rowCellsA = planned.rowIndexA !== null && planned.rowIndexA !== undefined ? cellsForRow(tableA, planned.rowIndexA) : [];
  const rowCellsB = planned.rowIndexB !== null && planned.rowIndexB !== undefined ? cellsForRow(tableB, planned.rowIndexB) : [];
  const baselineCell = baselineDocument === "documentA" ? cellA : cellB;
  const fallbackCell = cellB ?? cellA;
  const baselineRowCells = baselineDocument === "documentA" ? rowCellsA : rowCellsB;
  const fallbackRowCells = rowCellsB.length > 0 ? rowCellsB : rowCellsA;
  const baselineBBox = baselineCell?.bbox ?? (baselineRowCells.length > 0 ? cellsBBox(baselineRowCells) : undefined);
  const fallbackBBox = fallbackCell?.bbox ?? (fallbackRowCells.length > 0 ? cellsBBox(fallbackRowCells) : undefined);

  return {
    kind: planned.kind,
    ref: baselineCell?.ref ?? fallbackCell?.ref ?? planned.field ?? planned.kind,
    rowIndex: baselineCell?.rowIndex ?? fallbackCell?.rowIndex ?? planned.rowIndexB ?? planned.rowIndexA ?? -1,
    colIndex: baselineCell?.colIndex ?? fallbackCell?.colIndex ?? -1,
    before: planned.before ?? cellA?.text ?? (rowCellsA.length ? rowCellsA.map((cell) => cell.text).join(" | ") : null),
    after: planned.after ?? cellB?.text ?? (rowCellsB.length ? rowCellsB.map((cell) => cell.text).join(" | ") : null),
    bboxA: cellA?.bbox ?? (rowCellsA.length > 0 ? cellsBBox(rowCellsA) : baselineDocument === "documentA" ? baselineBBox ?? fallbackBBox : undefined),
    bboxB: cellB?.bbox ?? (rowCellsB.length > 0 ? cellsBBox(rowCellsB) : baselineDocument === "documentB" ? baselineBBox ?? fallbackBBox : undefined),
    pageIndexA: tableA.pageIndex,
    pageIndexB: tableB.pageIndex,
    field: planned.field,
    matchKey: rowMatchKey(planned),
    explanation: planned.explanation,
  };
}

function indexCells(table: ExtractedTable): Map<string, ExtractedCell> {
  return new Map(table.cells.map((cell) => [cell.ref, cell]));
}

function cellsForRow(table: ExtractedTable, rowIndex: number): ExtractedCell[] {
  return table.cells.filter((cell) => cell.rowIndex === rowIndex);
}

function cellsBBox(cells: ExtractedCell[]): BBox {
  return [
    Math.min(...cells.map((cell) => cell.bbox[0])),
    Math.min(...cells.map((cell) => cell.bbox[1])),
    Math.max(...cells.map((cell) => cell.bbox[2])),
    Math.max(...cells.map((cell) => cell.bbox[3])),
  ];
}

function rowMatchKey(planned: SemanticComparisonPlan["differences"][number]): string | undefined {
  if (planned.rowIndexA === undefined && planned.rowIndexB === undefined) {
    return undefined;
  }
  return `A:${planned.rowIndexA ?? "none"}|B:${planned.rowIndexB ?? "none"}`;
}

function compactCandidateDifferences(tableA: ExtractedTable, tableB: ExtractedTable) {
  return compareFirstTables(tableA, tableB).differences.map((difference) => ({
    kind: difference.kind,
    cellRefA: refFromBBox(tableA, difference.bboxA),
    cellRefB: refFromBBox(tableB, difference.bboxB),
    rowIndexA: difference.rowIndex,
    rowIndexB: difference.rowIndex,
    before: difference.before,
    after: difference.after,
  }));
}

function sameShape(tableA: ExtractedTable, tableB: ExtractedTable): boolean {
  return tableA.rowCount === tableB.rowCount && tableA.colCount === tableB.colCount;
}

function refFromBBox(table: ExtractedTable, bbox: number[] | undefined): string | undefined {
  if (!bbox) {
    return undefined;
  }
  return table.cells.find((cell) => cell.bbox.every((value, index) => value === bbox[index]))?.ref;
}

function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Semantic table agent did not return a JSON object: ${text.slice(0, 500)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
