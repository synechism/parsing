import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PNG } from "pngjs";

import type { BBox, ExtractedTable, ParsedDocumentTables } from "./types";

interface RenderedPage {
  pageIndex: number;
  png: PNG;
}

interface BoundaryCluster {
  position: number;
  score: number;
}

interface DetectedGrid {
  xBoundaries: number[];
  yBoundaries: number[];
}

const RENDER_DPI = 144;
const DARK_THRESHOLD = 125;
const LINE_COVERAGE_THRESHOLD = 0.42;

export async function refineDocumentTablesWithPdfRulingLines(
  documentPath: string,
  parsed: ParsedDocumentTables,
  workDir?: string,
): Promise<ParsedDocumentTables> {
  const sourceKind = sourceDocumentKind(documentPath);
  if (!sourceKind || parsed.tables.length === 0) {
    return parsed;
  }

  const tempRoot = workDir ?? (await mkdtemp(path.join(os.tmpdir(), "table-geometry-")));
  const shouldCleanup = !workDir;
  const renderedPages = new Map<number, RenderedPage>();

  try {
    await mkdir(tempRoot, { recursive: true });
    const tables: ExtractedTable[] = [];
    for (const table of parsed.tables) {
      let rendered = renderedPages.get(table.pageIndex);
      if (!rendered) {
        rendered =
          sourceKind === "pdf"
            ? await renderPdfPage(documentPath, table.pageIndex, tempRoot)
            : await loadPngPage(documentPath);
        renderedPages.set(table.pageIndex, rendered);
      }

      const page =
        parsed.pages.find((candidate) => candidate.pageIndex === table.pageIndex) ??
        (sourceKind === "png"
          ? { pageIndex: table.pageIndex, width: rendered.png.width, height: rendered.png.height }
          : undefined);
      if (!page) {
        tables.push(table);
        continue;
      }

      const tableWithPageSize: ExtractedTable = table.pageSize ? table : { ...table, pageSize: [page.width, page.height] };
      const grid = detectGrid(rendered.png, [page.width, page.height], table.bbox, table.rowCount, table.colCount);
      tables.push(grid ? applyDetectedGrid(tableWithPageSize, grid) : tableWithPageSize);
    }

    return {
      ...parsed,
      pages:
        parsed.pages.length > 0 || sourceKind !== "png"
          ? parsed.pages
          : [{ pageIndex: 0, width: renderedPages.get(0)?.png.width ?? 0, height: renderedPages.get(0)?.png.height ?? 0 }],
      tables,
    };
  } catch {
    return parsed;
  } finally {
    if (shouldCleanup) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

function sourceDocumentKind(documentPath: string): "pdf" | "png" | null {
  const extension = path.extname(documentPath).toLowerCase();
  if (extension === ".pdf") {
    return "pdf";
  }
  if (extension === ".png") {
    return "png";
  }
  return null;
}

async function renderPdfPage(documentPath: string, pageIndex: number, outputDir: string): Promise<RenderedPage> {
  const prefix = path.join(outputDir, `page-${pageIndex}`);
  await runCommand("pdftoppm", [
    "-png",
    "-f",
    String(pageIndex + 1),
    "-l",
    String(pageIndex + 1),
    "-singlefile",
    "-r",
    String(RENDER_DPI),
    documentPath,
    prefix,
  ]);

  const png = PNG.sync.read(await readFile(`${prefix}.png`));
  return { pageIndex, png };
}

async function loadPngPage(documentPath: string): Promise<RenderedPage> {
  return { pageIndex: 0, png: PNG.sync.read(await readFile(documentPath)) };
}

function detectGrid(
  png: PNG,
  pageSize: [number, number],
  tableBBox: BBox,
  rowCount: number,
  colCount: number,
): DetectedGrid | null {
  const scaleX = png.width / pageSize[0];
  const scaleY = png.height / pageSize[1];
  const pad = Math.round(RENDER_DPI / 36);
  const crop = {
    x1: clamp(Math.floor(tableBBox[0] * scaleX) - pad, 0, png.width - 1),
    y1: clamp(Math.floor(tableBBox[1] * scaleY) - pad, 0, png.height - 1),
    x2: clamp(Math.ceil(tableBBox[2] * scaleX) + pad, 1, png.width),
    y2: clamp(Math.ceil(tableBBox[3] * scaleY) + pad, 1, png.height),
  };

  const vertical = findLineClusters(png, crop, "vertical");
  const horizontal = findLineClusters(png, crop, "horizontal");
  const xPixels = selectBoundaries(vertical, colCount + 1);
  const yPixels = selectBoundaries(horizontal, rowCount + 1);

  if (!xPixels || !yPixels) {
    return null;
  }

  return {
    xBoundaries: xPixels.map((pixel) => pixel / scaleX),
    yBoundaries: yPixels.map((pixel) => pixel / scaleY),
  };
}

function findLineClusters(
  png: PNG,
  crop: { x1: number; y1: number; x2: number; y2: number },
  orientation: "vertical" | "horizontal",
): BoundaryCluster[] {
  const scores: BoundaryCluster[] = [];
  if (orientation === "vertical") {
    const height = crop.y2 - crop.y1;
    for (let x = crop.x1; x < crop.x2; x += 1) {
      let dark = 0;
      for (let y = crop.y1; y < crop.y2; y += 1) {
        dark += isDark(png, x, y) ? 1 : 0;
      }
      const score = dark / height;
      if (score >= LINE_COVERAGE_THRESHOLD) {
        scores.push({ position: x, score });
      }
    }
  } else {
    const width = crop.x2 - crop.x1;
    for (let y = crop.y1; y < crop.y2; y += 1) {
      let dark = 0;
      for (let x = crop.x1; x < crop.x2; x += 1) {
        dark += isDark(png, x, y) ? 1 : 0;
      }
      const score = dark / width;
      if (score >= LINE_COVERAGE_THRESHOLD) {
        scores.push({ position: y, score });
      }
    }
  }

  return clusterAdjacentScores(scores);
}

function clusterAdjacentScores(scores: BoundaryCluster[]): BoundaryCluster[] {
  if (scores.length === 0) {
    return [];
  }

  const clusters: BoundaryCluster[] = [];
  let current = [scores[0]];
  for (const score of scores.slice(1)) {
    const previous = current[current.length - 1];
    if (score.position <= previous.position + 2) {
      current.push(score);
      continue;
    }
    clusters.push(summarizeCluster(current));
    current = [score];
  }
  clusters.push(summarizeCluster(current));
  return clusters;
}

function summarizeCluster(cluster: BoundaryCluster[]): BoundaryCluster {
  const score = Math.max(...cluster.map((entry) => entry.score));
  const weightedSum = cluster.reduce((sum, entry) => sum + entry.position * entry.score, 0);
  const weight = cluster.reduce((sum, entry) => sum + entry.score, 0);
  return { position: weightedSum / weight, score };
}

function selectBoundaries(clusters: BoundaryCluster[], expectedCount: number): number[] | null {
  if (clusters.length < expectedCount) {
    return null;
  }
  return clusters
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, expectedCount)
    .map((cluster) => cluster.position)
    .sort((a, b) => a - b);
}

function applyDetectedGrid(table: ExtractedTable, grid: DetectedGrid): ExtractedTable {
  if (grid.xBoundaries.length < table.colCount + 1 || grid.yBoundaries.length < table.rowCount + 1) {
    return table;
  }

  return {
    ...table,
    bbox: [
      grid.xBoundaries[0],
      grid.yBoundaries[0],
      grid.xBoundaries[table.colCount],
      grid.yBoundaries[table.rowCount],
    ],
    geometrySource: "pdf_ruling_lines",
    cells: table.cells.map((cell) => ({
      ...cell,
      geometrySource: "pdf_ruling_lines",
      bbox: [
        grid.xBoundaries[cell.colIndex],
        grid.yBoundaries[cell.rowIndex],
        grid.xBoundaries[cell.colIndex + cell.colSpan],
        grid.yBoundaries[cell.rowIndex + cell.rowSpan],
      ],
    })),
  };
}

function isDark(png: PNG, x: number, y: number): boolean {
  const offset = (png.width * y + x) << 2;
  const alpha = png.data[offset + 3];
  if (alpha < 32) {
    return false;
  }
  const red = png.data[offset];
  const green = png.data[offset + 1];
  const blue = png.data[offset + 2];
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance <= DARK_THRESHOLD;
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      }
    });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
