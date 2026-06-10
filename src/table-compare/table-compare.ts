import type { ExtractedCell, ExtractedTable, TableComparisonResult, TableDifference } from "./types";

export function compareFirstTables(tableA: ExtractedTable, tableB: ExtractedTable): TableComparisonResult {
  const differences: TableDifference[] = [];
  const cellsA = indexCells(tableA.cells);
  const cellsB = indexCells(tableB.cells);
  const refs = new Set([...cellsA.keys(), ...cellsB.keys()]);

  if (tableA.rowCount !== tableB.rowCount || tableA.colCount !== tableB.colCount) {
    differences.push({
      kind: "shape_changed",
      ref: "table",
      rowIndex: -1,
      colIndex: -1,
      before: `${tableA.rowCount} rows x ${tableA.colCount} columns`,
      after: `${tableB.rowCount} rows x ${tableB.colCount} columns`,
      bboxA: tableA.bbox,
      bboxB: tableB.bbox,
      pageIndexA: tableA.pageIndex,
      pageIndexB: tableB.pageIndex,
    });
  }

  for (const ref of [...refs].sort(compareCellRefs)) {
    const cellA = cellsA.get(ref);
    const cellB = cellsB.get(ref);
    if (!cellA && cellB) {
      differences.push(buildDifference("cell_added", ref, null, cellB));
      continue;
    }
    if (cellA && !cellB) {
      differences.push(buildDifference("cell_removed", ref, cellA, null));
      continue;
    }
    if (cellA && cellB && cellA.text !== cellB.text) {
      differences.push(buildDifference("cell_changed", ref, cellA, cellB));
    }
  }

  return {
    different: differences.length > 0,
    summary: summarizeDifferences(differences),
    explanation: explainDifferences(differences),
    differences,
    tableA,
    tableB,
  };
}

function indexCells(cells: ExtractedCell[]): Map<string, ExtractedCell> {
  return new Map(cells.map((cell) => [cell.ref, cell]));
}

function buildDifference(
  kind: TableDifference["kind"],
  ref: string,
  cellA: ExtractedCell | null,
  cellB: ExtractedCell | null,
): TableDifference {
  return {
    kind,
    ref,
    rowIndex: cellB?.rowIndex ?? cellA?.rowIndex ?? -1,
    colIndex: cellB?.colIndex ?? cellA?.colIndex ?? -1,
    before: cellA?.text ?? null,
    after: cellB?.text ?? null,
    bboxA: cellA?.bbox,
    bboxB: cellB?.bbox,
  };
}

function summarizeDifferences(differences: TableDifference[]): string {
  if (differences.length === 0) {
    return "The tables are not different. Every parsed cell has matching text and the table dimensions match.";
  }

  const changed = differences.filter((diff) => diff.kind === "cell_changed").length;
  const added = differences.filter((diff) => diff.kind === "cell_added").length;
  const removed = differences.filter((diff) => diff.kind === "cell_removed").length;
  const shape = differences.some((diff) => diff.kind === "shape_changed");
  const parts = [
    shape ? "table dimensions changed" : null,
    changed ? `${changed} cell value${changed === 1 ? "" : "s"} changed` : null,
    added ? `${added} cell${added === 1 ? "" : "s"} added` : null,
    removed ? `${removed} cell${removed === 1 ? "" : "s"} removed` : null,
  ].filter(Boolean);

  return `The tables are different: ${parts.join(", ")}.`;
}

function explainDifferences(differences: TableDifference[]): string {
  if (differences.length === 0) {
    return "No differences were found. The parsed table dimensions match and every corresponding MinerU-extracted cell has the same normalized text.";
  }

  return differences
    .map((diff) => {
      if (diff.kind === "shape_changed") {
        return `The table shape changed from ${diff.before} to ${diff.after}.`;
      }
      if (diff.kind === "cell_added") {
        return `Cell ${diff.ref} was added with value "${diff.after ?? ""}".`;
      }
      if (diff.kind === "cell_removed") {
        return `Cell ${diff.ref} was removed; previous value was "${diff.before ?? ""}".`;
      }
      return `Cell ${diff.ref} changed from "${diff.before ?? ""}" to "${diff.after ?? ""}".`;
    })
    .join(" ");
}

function compareCellRefs(a: string, b: string): number {
  const parsedA = parseRef(a);
  const parsedB = parseRef(b);
  return parsedA.row - parsedB.row || parsedA.col - parsedB.col;
}

function parseRef(ref: string): { row: number; col: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) {
    return { row: Number.MAX_SAFE_INTEGER, col: Number.MAX_SAFE_INTEGER };
  }
  const [, colLabel, rowLabel] = match;
  let col = 0;
  for (const char of colLabel) {
    col = col * 26 + (char.charCodeAt(0) - 64);
  }
  return { row: Number(rowLabel), col };
}
