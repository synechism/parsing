import * as cheerio from "cheerio";

import type { BBox, ExtractedCell, ExtractedTable, PageGeometry, ParsedDocumentTables } from "./types";

interface MinerUResultShape {
  results?: Record<
    string,
    {
      content_list?: string | unknown[];
      middle_json?: MinerUMiddleJson;
    }
  >;
}

type MinerUMiddleJson =
  | string
  | {
      pdf_info?: Array<{
        page_idx?: number;
        page_size?: [number, number];
        para_blocks?: Array<{
          type?: string;
          bbox?: BBox;
          blocks?: Array<{
            type?: string;
            bbox?: BBox;
            lines?: Array<{
              spans?: Array<{
                type?: string;
                bbox?: BBox;
                html?: string;
              }>;
            }>;
          }>;
        }>;
      }>;
    };

interface ContentListTable {
  type?: string;
  table_body?: string;
  table_caption?: string[];
  bbox?: BBox;
  page_idx?: number;
}

interface MiddleJsonTable {
  pageIndex: number;
  bbox: BBox;
  html: string;
}

interface ParsedHtmlCell {
  rowIndex: number;
  colIndex: number;
  rowSpan: number;
  colSpan: number;
  text: string;
}

export function extractTablesFromMinerUResult(
  rawResult: unknown,
  fileName: string,
  mineruTaskId: string,
): ParsedDocumentTables {
  const result = rawResult as MinerUResultShape;
  const firstResult = Object.values(result.results ?? {})[0];
  if (!firstResult) {
    return { fileName, mineruTaskId, rawResult, tables: [], pages: [] };
  }

  const pages = extractPages(firstResult.middle_json);
  const middleTables = extractMiddleJsonTables(firstResult.middle_json);
  const contentList = parseMaybeJson<unknown[]>(firstResult.content_list) ?? [];
  const tables = contentList
    .filter((item): item is ContentListTable => {
      const candidate = item as ContentListTable;
      return candidate.type === "table" && Boolean(candidate.table_body) && isBBox(candidate.bbox);
    })
    .map((table, index) => buildExtractedTable(table, index, pages, middleTables));

  return { fileName, mineruTaskId, rawResult, tables, pages };
}

function extractPages(middleJson: MinerUMiddleJson | undefined): PageGeometry[] {
  const parsed = parseMaybeJson<{ pdf_info?: Array<{ page_idx?: number; page_size?: [number, number] }> }>(middleJson);
  return (parsed?.pdf_info ?? [])
    .filter((page) => Array.isArray(page.page_size) && page.page_size.length === 2)
    .map((page, fallbackIndex) => ({
      pageIndex: page.page_idx ?? fallbackIndex,
      width: Number(page.page_size?.[0]),
      height: Number(page.page_size?.[1]),
    }));
}

function extractMiddleJsonTables(middleJson: MinerUMiddleJson | undefined): MiddleJsonTable[] {
  const parsed = parseMaybeJson<Extract<MinerUMiddleJson, object>>(middleJson);
  const tables: MiddleJsonTable[] = [];

  for (const [fallbackPageIndex, page] of (parsed?.pdf_info ?? []).entries()) {
    const pageIndex = page.page_idx ?? fallbackPageIndex;
    for (const block of page.para_blocks ?? []) {
      if (block.type !== "table") {
        continue;
      }
      for (const child of block.blocks ?? []) {
        if (child.type !== "table_body") {
          continue;
        }
        for (const line of child.lines ?? []) {
          for (const span of line.spans ?? []) {
            if (span.type === "table" && span.html && isBBox(span.bbox)) {
              tables.push({ pageIndex, bbox: span.bbox, html: span.html });
            }
          }
        }
      }
    }
  }

  return tables;
}

function buildExtractedTable(
  table: ContentListTable,
  index: number,
  pages: PageGeometry[],
  middleTables: MiddleJsonTable[],
): ExtractedTable {
  const html = table.table_body ?? "";
  const middleTable = findMiddleTable(table, middleTables);
  const bbox = middleTable?.bbox ?? (table.bbox as BBox);
  const grid = parseTableHtml(html);
  const rowCount = grid.reduce((max, cell) => Math.max(max, cell.rowIndex + cell.rowSpan), 0);
  const colCount = grid.reduce((max, cell) => Math.max(max, cell.colIndex + cell.colSpan), 0);
  const tableWidth = Math.max(1, bbox[2] - bbox[0]);
  const tableHeight = Math.max(1, bbox[3] - bbox[1]);
  const cellWidth = tableWidth / Math.max(1, colCount);
  const cellHeight = tableHeight / Math.max(1, rowCount);

  const cells: ExtractedCell[] = grid.map((cell) => ({
    ...cell,
    ref: cellRef(cell.rowIndex, cell.colIndex),
    bbox: [
      bbox[0] + cell.colIndex * cellWidth,
      bbox[1] + cell.rowIndex * cellHeight,
      bbox[0] + (cell.colIndex + cell.colSpan) * cellWidth,
      bbox[1] + (cell.rowIndex + cell.rowSpan) * cellHeight,
    ],
  }));

  const pageIndex = Number(middleTable?.pageIndex ?? table.page_idx ?? 0);
  const page = pages.find((candidate) => candidate.pageIndex === pageIndex);

  return {
    index,
    pageIndex,
    pageSize: page ? [page.width, page.height] : null,
    bbox,
    caption: table.table_caption ?? [],
    html,
    rowCount,
    colCount,
    cells,
  };
}

function findMiddleTable(table: ContentListTable, middleTables: MiddleJsonTable[]): MiddleJsonTable | undefined {
  const html = normalizeHtml(table.table_body ?? "");
  const pageIndex = Number(table.page_idx ?? 0);
  return (
    middleTables.find((candidate) => candidate.pageIndex === pageIndex && normalizeHtml(candidate.html) === html) ??
    middleTables.find((candidate) => candidate.pageIndex === pageIndex)
  );
}

function parseTableHtml(html: string): ParsedHtmlCell[] {
  const $ = cheerio.load(html);
  const cells: ParsedHtmlCell[] = [];
  const occupied = new Set<string>();

  $("tr").each((rowIndex, rowElement) => {
    let colIndex = 0;
    $(rowElement)
      .children("th,td")
      .each((_, cellElement) => {
        while (occupied.has(`${rowIndex}:${colIndex}`)) {
          colIndex += 1;
        }

        const cell = $(cellElement);
        const rowSpan = positiveInt(cell.attr("rowspan")) ?? 1;
        const colSpan = positiveInt(cell.attr("colspan")) ?? 1;
        const text = normalizeCellText(cell.text());

        for (let row = rowIndex; row < rowIndex + rowSpan; row += 1) {
          for (let col = colIndex; col < colIndex + colSpan; col += 1) {
            occupied.add(`${row}:${col}`);
          }
        }

        cells.push({ rowIndex, colIndex, rowSpan, colSpan, text });
        colIndex += colSpan;
      });
  });

  return cells;
}

export function normalizeCellText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeHtml(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseMaybeJson<T>(value: string | T | undefined): T | undefined {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isBBox(value: unknown): value is BBox {
  return Array.isArray(value) && value.length === 4 && value.every((entry) => typeof entry === "number");
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
