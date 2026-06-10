import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

import type { BBox, TableComparisonResult, TableDifference } from "./types";

export async function createRedlinePdf(
  comparison: TableComparisonResult,
  documentBPath: string,
  outputPath: string,
): Promise<string> {
  await mkdir(path.dirname(outputPath), { recursive: true });

  const pdf = await loadOrCreatePdf(documentBPath, comparison);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const marks = comparison.differences.filter((diff) => diff.bboxB || diff.bboxA);

  for (const diff of marks) {
    const pageIndex = Math.max(0, Math.min(pages.length - 1, diff.pageIndexB ?? comparison.tableB.pageIndex ?? 0));
    const page = pages[pageIndex];
    const bbox = diff.bboxB ?? diff.bboxA ?? comparison.tableB.bbox;
    const sourcePage = comparison.tableB.pageSize ?? comparison.tableA.pageSize;
    const rect = mapBBoxToPdf(bbox, sourcePage ?? [page.getWidth(), page.getHeight()], page.getWidth(), page.getHeight());

    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      borderColor: rgb(0.9, 0.05, 0.05),
      borderWidth: 1.5,
      color: rgb(1, 0.85, 0.85),
      opacity: 0.28,
      borderOpacity: 0.95,
    });
    page.drawText(diff.ref, {
      x: rect.x,
      y: Math.min(page.getHeight() - 10, rect.y + rect.height + 3),
      size: 7,
      color: rgb(0.75, 0, 0),
      font,
    });
  }

  if (marks.length === 0) {
    const page = pages[0] ?? pdf.addPage();
    page.drawText("No table differences found by MinerU-grounded comparison.", {
      x: 36,
      y: page.getHeight() - 54,
      size: 11,
      color: rgb(0, 0.35, 0.12),
      font,
    });
  }

  const bytes = await pdf.save();
  await writeFile(outputPath, bytes);
  return outputPath;
}

async function loadOrCreatePdf(documentPath: string, comparison: TableComparisonResult): Promise<PDFDocument> {
  if (documentPath.toLowerCase().endsWith(".pdf")) {
    const bytes = await import("node:fs/promises").then((fs) => fs.readFile(documentPath));
    return PDFDocument.load(bytes);
  }

  const pdf = await PDFDocument.create();
  const pageSize = comparison.tableB.pageSize ?? [612, 792];
  pdf.addPage(pageSize);
  return pdf;
}

function mapBBoxToPdf(
  bbox: BBox,
  sourcePageSize: [number, number],
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number; width: number; height: number } {
  const [sourceWidth, sourceHeight] = sourcePageSize;
  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;
  const x = bbox[0] * scaleX;
  const width = Math.max(1, (bbox[2] - bbox[0]) * scaleX);
  const height = Math.max(1, (bbox[3] - bbox[1]) * scaleY);
  const y = targetHeight - bbox[3] * scaleY;
  return { x, y, width, height };
}
