import { z } from "zod";

import { compareFirstTables } from "./table-compare";
import type {
  BBox,
  ExtractedCell,
  ExtractedTable,
  ParsedDocumentTables,
  TableComparisonResult,
  TableDifference,
  TableSectionSelection,
} from "./types";

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

const tableSectionSelectionSchema = z.object({
  tableIndex: z.number().int().nonnegative(),
  headerRowIndexes: z.array(z.number().int().nonnegative()).default([]),
  dataRowIndexes: z.array(z.number().int().nonnegative()).default([]),
  totalRowIndexes: z.array(z.number().int().nonnegative()).default([]),
  ignoredRowIndexes: z.array(z.number().int().nonnegative()).default([]),
  rationale: z.string().default(""),
});

export const tableSelectionPlanSchema = z.object({
  rationale: z.string().optional(),
  documentA: tableSectionSelectionSchema,
  documentB: tableSectionSelectionSchema,
});

export type TableSelectionPlan = z.infer<typeof tableSelectionPlanSchema>;

export interface SemanticResultOptions {
  baselineDocument?: "documentA" | "documentB";
  selection?: TableComparisonResult["selection"];
}

export function buildTableSelectionPrompt(documentA: ParsedDocumentTables, documentB: ParsedDocumentTables): string {
  return `
Choose the meaningful line-item table regions to compare in these two MinerU-parsed documents.

The documents may be manufacturing statements, payable tables, supplier invoices, reconciliation sheets, image PDFs, scans, or screenshots.

Selection rules:
- Select the table/rows containing actual payable/invoice/manufacturing line items.
- Ignore supplier/customer metadata tables, title blocks, approval/signature/stamp boxes, payment terms blocks, and blank padding rows.
- If metadata rows are inside the same physical table, exclude those metadata rows and start at the line-item header row.
- Include the line-item header row or rows.
- Include non-empty transaction/material rows.
- Include total/subtotal rows when they are part of the comparable business table.
- Do not select rows only because they contain dates/names; select rows that identify materials/orders/quantities/prices/amounts.
- Use the zero-based tableIndex and rowIndex values exactly as listed below.
- Return JSON only, no markdown.

Relevant English header hints include:
- Date, delivery date, statement date, invoice date
- Document No, invoice no, delivery note, packing slip
- PO, purchase order, order no
- Part code, item code, material code, SKU, manufacturer part code, MPN
- Part name, description, specification, spec
- Quantity, shipped quantity, received quantity
- Unit, UOM
- Unit price, price
- Amount, extended amount, line total
- Notes, remarks
- Subtotal, total

Relevant Chinese header hints include:
- 日期, 交货日期, 对账日期
- 单据编号, 送货单号
- 订单号
- 料号, 物料编号
- 型号, 规格型号, 规格
- 数量, 发货数量
- 单位
- 单价
- 金额, 金额(CNY)
- 备注
- 合计

JSON shape:
{
  "rationale": "brief reason for selected regions",
  "documentA": {
    "tableIndex": 1,
    "headerRowIndexes": [0],
    "dataRowIndexes": [1, 2, 3],
    "totalRowIndexes": [4],
    "ignoredRowIndexes": [],
    "rationale": "selected the middle line-item table"
  },
  "documentB": {
    "tableIndex": 0,
    "headerRowIndexes": [4],
    "dataRowIndexes": [5, 6, 7],
    "totalRowIndexes": [18],
    "ignoredRowIndexes": [0, 1, 2, 3, 8, 9],
    "rationale": "single physical grid with metadata rows above the header"
  }
}

Document A tables:
${JSON.stringify(compactDocumentTablesForSelection(documentA), null, 2)}

Document B tables:
${JSON.stringify(compactDocumentTablesForSelection(documentB), null, 2)}
`;
}

export function parseTableSelectionPlanText(text: string): TableSelectionPlan {
  return tableSelectionPlanSchema.parse(parseJsonObject(text));
}

export function normalizeTableSelectionPlan(
  documentA: ParsedDocumentTables,
  documentB: ParsedDocumentTables,
  plan: TableSelectionPlan,
): TableSelectionPlan {
  return {
    ...plan,
    documentA: normalizeTableSectionSelection(documentA, plan.documentA),
    documentB: normalizeTableSectionSelection(documentB, plan.documentB),
  };
}

function normalizeTableSectionSelection(
  document: ParsedDocumentTables,
  selection: TableSectionSelection,
): TableSectionSelection {
  const table = document.tables.find((candidate) => candidate.index === selection.tableIndex) ?? document.tables[0];
  if (!table) {
    return selection;
  }

  const nonBlankRows = new Set(
    [...new Set(table.cells.map((cell) => cell.rowIndex))].filter((rowIndex) =>
      table.cells.some((cell) => cell.rowIndex === rowIndex && cell.text.trim().length > 0),
    ),
  );
  const totalRows = tableRowsContaining(table, /合计|总计|小计|subtotal|total/i);
  const headerRowIndexes = uniqueSorted(selection.headerRowIndexes.filter((rowIndex) => nonBlankRows.has(rowIndex)));
  const dataRowIndexes = uniqueSorted(
    selection.dataRowIndexes.filter((rowIndex) => nonBlankRows.has(rowIndex) && !totalRows.includes(rowIndex)),
  );
  const totalRowIndexes = uniqueSorted([
    ...selection.totalRowIndexes.filter((rowIndex) => nonBlankRows.has(rowIndex)),
    ...totalRows,
  ]);
  const selectedRows = new Set([...headerRowIndexes, ...dataRowIndexes, ...totalRowIndexes]);
  const ignoredRowIndexes = uniqueSorted([
    ...selection.ignoredRowIndexes,
    ...[...new Set(table.cells.map((cell) => cell.rowIndex))].filter((rowIndex) => !selectedRows.has(rowIndex)),
  ]);

  return {
    ...selection,
    headerRowIndexes,
    dataRowIndexes,
    totalRowIndexes,
    ignoredRowIndexes,
  };
}

export function applyTableSectionSelection(
  document: ParsedDocumentTables,
  selection: TableSectionSelection,
): ExtractedTable {
  const table = document.tables.find((candidate) => candidate.index === selection.tableIndex) ?? document.tables[0];
  if (!table) {
    throw new Error(`No table found for selection in ${document.fileName}`);
  }

  const selectedRowIndexes = uniqueSorted([
    ...selection.headerRowIndexes,
    ...selection.dataRowIndexes,
    ...selection.totalRowIndexes,
  ]).filter((rowIndex) => table.cells.some((cell) => cell.rowIndex === rowIndex));

  if (selectedRowIndexes.length === 0) {
    return table;
  }

  const selectedRows = new Set(selectedRowIndexes);
  const selectedCells = table.cells.filter((cell) => selectedRows.has(cell.rowIndex));
  const selectedColIndexes = uniqueSorted(selectedCells.map((cell) => cell.colIndex));
  const rowIndexMap = new Map(selectedRowIndexes.map((rowIndex, index) => [rowIndex, index]));
  const colIndexMap = new Map(selectedColIndexes.map((colIndex, index) => [colIndex, index]));
  const cells = selectedCells.map((cell) => {
    const rowIndex = rowIndexMap.get(cell.rowIndex) ?? cell.rowIndex;
    const colIndex = colIndexMap.get(cell.colIndex) ?? cell.colIndex;
    return {
      ...cell,
      rowIndex,
      colIndex,
      rowSpan: Math.min(cell.rowSpan, selectedRowIndexes.length - rowIndex),
      ref: cellRef(rowIndex, colIndex),
    };
  });

  return {
    ...table,
    bbox: cells.length > 0 ? cellsBBox(cells) : table.bbox,
    rowCount: selectedRowIndexes.length,
    colCount: Math.max(0, ...cells.map((cell) => cell.colIndex + cell.colSpan)),
    cells,
    html: table.html,
    caption: table.caption,
    geometrySource: cells.some((cell) => cell.geometrySource === "pdf_ruling_lines") ? "pdf_ruling_lines" : table.geometrySource,
  };
}

function compactDocumentTablesForSelection(document: ParsedDocumentTables) {
  return {
    fileName: document.fileName,
    tables: document.tables.map((table) => ({
      tableIndex: table.index,
      pageIndex: table.pageIndex,
      rowCount: table.rowCount,
      colCount: table.colCount,
      bbox: table.bbox,
      caption: table.caption,
      rows: compactRowsForSelection(table),
    })),
  };
}

function compactRowsForSelection(table: ExtractedTable) {
  const rows = [...new Set(table.cells.map((cell) => cell.rowIndex))].sort((a, b) => a - b);
  return rows.map((rowIndex) => {
    const cells = table.cells
      .filter((cell) => cell.rowIndex === rowIndex)
      .sort((a, b) => a.colIndex - b.colIndex);
    const nonEmptyCells = cells.filter((cell) => cell.text.trim().length > 0);
    return {
      rowIndex,
      nonEmptyCellCount: nonEmptyCells.length,
      text: nonEmptyCells.map((cell) => `${cell.ref}:${cell.text}`).join(" | "),
    };
  });
}

function tableRowsContaining(table: ExtractedTable, pattern: RegExp): number[] {
  return [...new Set(table.cells.map((cell) => cell.rowIndex))]
    .filter((rowIndex) =>
      table.cells
        .filter((cell) => cell.rowIndex === rowIndex)
        .some((cell) => pattern.test(cell.text)),
    )
    .sort((a, b) => a - b);
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
- Treat wording-only description differences as equivalent when stable identifiers such as part code/order number plus quantity/price/amount clearly match.
- Report description/specification differences when they change a material attribute such as dimensions, grade, material, color, revision, or required part identity.
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
  return (
    sameShape(tableA, tableB) &&
    similarHeaderLayout(tableA, tableB) &&
    !hasReorderedRowMatches(plan) &&
    candidates.length > 0 &&
    plan.differences.length < candidates.length
  );
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

export function mergeSameFormatCandidateDifferences(
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  plan: SemanticComparisonPlan,
): SemanticComparisonPlan {
  if (!needsSameFormatCandidateReview(tableA, tableB, plan)) {
    return plan;
  }

  const existing = new Set(plan.differences.map((difference) => plannedDifferenceKey(difference)));
  const additions = compactCandidateDifferences(tableA, tableB)
    .filter((candidate) => !existing.has(candidateDifferenceKey(candidate)))
    .map((candidate) => ({
      kind: candidate.kind === "cell_changed" ? "cell_changed" as const : "shape_changed" as const,
      cellRefA: candidate.cellRefA ?? null,
      cellRefB: candidate.cellRefB ?? null,
      rowIndexA: candidate.rowIndexA ?? null,
      rowIndexB: candidate.rowIndexB ?? null,
      field: candidate.cellRefB ?? candidate.cellRefA ?? "same-format-cell",
      before: candidate.before ?? null,
      after: candidate.after ?? null,
      explanation: `Same-format cell differs at ${candidate.cellRefA ?? "unknown"} / ${candidate.cellRefB ?? "unknown"}: ${candidate.before ?? ""} vs ${candidate.after ?? ""}.`,
    }));

  if (additions.length === 0) {
    return plan;
  }

  const explanation = [
    plan.explanation,
    ...additions.map((difference) => difference.explanation),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    ...plan,
    different: true,
    summary: plan.summary || "Same-format positional differences were found.",
    explanation,
    differences: [...plan.differences, ...additions],
  };
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
  const ignoredTemplateDifferences = plan.differences.filter((difference) =>
    isIgnoredTemplateDifference(difference, tableA, tableB, cellsA, cellsB),
  );
  const reportablePlanDifferences = plan.differences.filter(
    (difference) => !isIgnoredTemplateDifference(difference, tableA, tableB, cellsA, cellsB),
  );
  const different = plan.different && reportablePlanDifferences.length > 0;
  const differences = different
    ? reportablePlanDifferences.map((difference) => buildDifference(difference, tableA, tableB, cellsA, cellsB, baselineDocument))
    : [];
  const explanation = different
    ? ensureExplanationCoversDifferences(plan.explanation, differences)
    : plan.different && ignoredTemplateDifferences.length > 0
      ? explainIgnoredTemplateOnlyDifferences(ignoredTemplateDifferences)
      : plan.explanation;

  return {
    different,
    summary: different ? plan.summary : plan.different ? "No material table differences found." : plan.summary,
    explanation,
    differences,
    tableA,
    tableB,
    comparisonMode: "semantic",
    baselineDocument,
    selection: options.selection,
    semantic: {
      commonFields: [],
      ignoredFieldsA: [
        ...(plan.ignored?.flatMap((ignored) => ignored.refsA ?? []) ?? []),
        ...ignoredTemplateDifferences.flatMap((difference) => (difference.cellRefA ? [difference.cellRefA] : [])),
      ],
      ignoredFieldsB: [
        ...(plan.ignored?.flatMap((ignored) => ignored.refsB ?? []) ?? []),
        ...ignoredTemplateDifferences.flatMap((difference) => (difference.cellRefB ? [difference.cellRefB] : [])),
      ],
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

function isIgnoredTemplateDifference(
  difference: SemanticComparisonPlan["differences"][number],
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  cellsA: Map<string, ExtractedCell>,
  cellsB: Map<string, ExtractedCell>,
): boolean {
  if (isBlankPaddingRowDifference(difference, tableA, tableB, cellsA, cellsB)) {
    return true;
  }

  if (isOneSidedComputedSummaryRowDifference(difference, tableA, tableB, cellsA, cellsB)) {
    return true;
  }

  if (isOptionalTemplateFieldDifference(difference, tableA, tableB, cellsA, cellsB)) {
    return true;
  }

  return false;
}

function isBlankPaddingRowDifference(
  difference: SemanticComparisonPlan["differences"][number],
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  cellsA: Map<string, ExtractedCell>,
  cellsB: Map<string, ExtractedCell>,
): boolean {
  if (difference.kind !== "row_added" && difference.kind !== "row_removed") {
    return false;
  }

  const evidence = differenceEvidenceText(difference, tableA, tableB, cellsA, cellsB);
  const rowA = rowTextForDifference(difference, "documentA", tableA, cellsA);
  const rowB = rowTextForDifference(difference, "documentB", tableB, cellsB);
  return /blank|empty|padding|spacer/.test(evidence) || (isBlankOptionalValue(rowA) && isBlankOptionalValue(rowB));
}

function isOneSidedComputedSummaryRowDifference(
  difference: SemanticComparisonPlan["differences"][number],
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  cellsA: Map<string, ExtractedCell>,
  cellsB: Map<string, ExtractedCell>,
): boolean {
  if (difference.kind !== "row_added" && difference.kind !== "row_removed") {
    return false;
  }

  const evidence = differenceEvidenceText(difference, tableA, tableB, cellsA, cellsB);
  return /total|subtotal|summary|合计|总计|小计/.test(evidence);
}

function isOptionalTemplateFieldDifference(
  difference: SemanticComparisonPlan["differences"][number],
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  cellsA: Map<string, ExtractedCell>,
  cellsB: Map<string, ExtractedCell>,
): boolean {
  const evidence = differenceEvidenceText(difference, tableA, tableB, cellsA, cellsB);
  if (!/remarks?|notes?|comments?|memo|备注|说明/.test(evidence)) {
    return false;
  }

  if (difference.kind === "shape_changed") {
    if (/non[-\s]?material|non[-\s]?essential|does not affect|not affect verification/.test(evidence)) {
      return true;
    }
    return (
      /line note|placeholder|generic|template/.test(evidence) &&
      /empty|blank|absent|missing|no remarks|no notes|no equivalent|no remarks data|no notes data/.test(evidence)
    );
  }

  if (difference.kind !== "cell_changed") {
    return false;
  }

  const before = normalizeOptionalFieldValue(difference.before);
  const after = normalizeOptionalFieldValue(difference.after);
  return (
    before !== after &&
    ((isBlankOptionalValue(before) && isGenericOptionalValue(after)) || (isBlankOptionalValue(after) && isGenericOptionalValue(before)))
  );
}

function differenceEvidenceText(
  difference: SemanticComparisonPlan["differences"][number],
  tableA: ExtractedTable,
  tableB: ExtractedTable,
  cellsA: Map<string, ExtractedCell>,
  cellsB: Map<string, ExtractedCell>,
): string {
  const cellA = difference.cellRefA ? cellsA.get(difference.cellRefA) : undefined;
  const cellB = difference.cellRefB ? cellsB.get(difference.cellRefB) : undefined;
  return [
    difference.field,
    difference.before,
    difference.after,
    difference.explanation,
    cellA?.text,
    cellB?.text,
    cellA ? headerTextForCell(tableA, cellA) : undefined,
    cellB ? headerTextForCell(tableB, cellB) : undefined,
    rowTextForDifference(difference, "documentA", tableA, cellsA),
    rowTextForDifference(difference, "documentB", tableB, cellsB),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function rowTextForDifference(
  difference: SemanticComparisonPlan["differences"][number],
  document: "documentA" | "documentB",
  table: ExtractedTable,
  cells: Map<string, ExtractedCell>,
): string {
  const explicitRowIndex = document === "documentA" ? difference.rowIndexA : difference.rowIndexB;
  const cellRef = document === "documentA" ? difference.cellRefA : difference.cellRefB;
  const rowIndex = explicitRowIndex ?? (cellRef ? cells.get(cellRef)?.rowIndex : undefined);
  if (rowIndex === undefined || rowIndex === null) {
    return "";
  }

  return cellsForRow(table, rowIndex)
    .sort((a, b) => a.colIndex - b.colIndex)
    .map((cell) => cell.text.trim())
    .filter(Boolean)
    .join(" ");
}

function headerTextForCell(table: ExtractedTable, cell: ExtractedCell): string {
  const headerRowIndex = Math.min(...table.cells.map((candidate) => candidate.rowIndex));
  const headerCell = table.cells
    .filter((candidate) => candidate.rowIndex === headerRowIndex)
    .find((candidate) => rangesOverlap(candidate.colIndex, candidate.colIndex + candidate.colSpan, cell.colIndex, cell.colIndex + cell.colSpan));
  return headerCell?.text ?? "";
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

function normalizeOptionalFieldValue(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isBlankOptionalValue(value: string): boolean {
  return value === "";
}

function isGenericOptionalValue(value: string): boolean {
  return isBlankOptionalValue(value) || /^(line note|note|remarks?|comment|n\/a|na|none|null|-|—)$/.test(value);
}

function explainIgnoredTemplateOnlyDifferences(differences: SemanticComparisonPlan["differences"]): string {
  const refs = differences
    .map((difference) => difference.cellRefB ?? difference.cellRefA ?? difference.field)
    .filter(Boolean)
    .join(", ");
  return `No material table differences found. Only optional template-only fields or computed summary rows differed${
    refs ? ` (${refs})` : ""
  }, so those fields were ignored for business-content comparison.`;
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
  const bboxA = cellA?.bbox ?? (rowCellsA.length > 0 ? cellsBBox(rowCellsA) : undefined);
  const bboxB = cellB?.bbox ?? (rowCellsB.length > 0 ? cellsBBox(rowCellsB) : undefined);

  return {
    kind: planned.kind,
    ref: baselineCell?.ref ?? fallbackCell?.ref ?? planned.field ?? planned.kind,
    rowIndex: baselineCell?.rowIndex ?? fallbackCell?.rowIndex ?? planned.rowIndexB ?? planned.rowIndexA ?? -1,
    colIndex: baselineCell?.colIndex ?? fallbackCell?.colIndex ?? -1,
    before: planned.before ?? cellA?.text ?? (rowCellsA.length ? rowCellsA.map((cell) => cell.text).join(" | ") : null),
    after: planned.after ?? cellB?.text ?? (rowCellsB.length ? rowCellsB.map((cell) => cell.text).join(" | ") : null),
    bboxA,
    bboxB,
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

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function cellRef(rowIndex: number, colIndex: number): string {
  let col = colIndex + 1;
  let label = "";
  while (col > 0) {
    const remainder = (col - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    col = Math.floor((col - 1) / 26);
  }
  return `${label}${rowIndex + 1}`;
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

function plannedDifferenceKey(difference: SemanticComparisonPlan["differences"][number]): string {
  return `${difference.cellRefA ?? ""}|${difference.cellRefB ?? ""}|${difference.before ?? ""}|${difference.after ?? ""}`;
}

function candidateDifferenceKey(candidate: ReturnType<typeof compactCandidateDifferences>[number]): string {
  return `${candidate.cellRefA ?? ""}|${candidate.cellRefB ?? ""}|${candidate.before ?? ""}|${candidate.after ?? ""}`;
}

function sameShape(tableA: ExtractedTable, tableB: ExtractedTable): boolean {
  return tableA.rowCount === tableB.rowCount && tableA.colCount === tableB.colCount;
}

function hasReorderedRowMatches(plan: SemanticComparisonPlan): boolean {
  return Boolean(plan.rowMatches?.some((match) => match.rowIndexA !== match.rowIndexB));
}

function similarHeaderLayout(tableA: ExtractedTable, tableB: ExtractedTable): boolean {
  const headerA = normalizedHeaderCells(tableA);
  const headerB = normalizedHeaderCells(tableB);
  const comparable = Math.min(headerA.length, headerB.length);
  if (comparable === 0) {
    return false;
  }

  const matches = Array.from({ length: comparable }, (_, index) => headerA[index] === headerB[index]).filter(Boolean).length;
  return matches / comparable >= 0.6;
}

function normalizedHeaderCells(table: ExtractedTable): string[] {
  const headerRowIndex = Math.min(...table.cells.map((cell) => cell.rowIndex));
  return table.cells
    .filter((cell) => cell.rowIndex === headerRowIndex)
    .sort((a, b) => a.colIndex - b.colIndex)
    .map((cell) => normalizeHeaderText(cell.text));
}

function normalizeHeaderText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
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
