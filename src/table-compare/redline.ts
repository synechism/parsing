import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

import type { BBox, TableComparisonResult, TableDifference } from "./types";

export async function createRedlinePdf(
  comparison: TableComparisonResult,
  baselineDocumentPath: string,
  outputPath: string,
  baselineDocument: "documentA" | "documentB" = comparison.baselineDocument ?? "documentB",
): Promise<string> {
  await mkdir(path.dirname(outputPath), { recursive: true });

  const pdf = await loadOrCreatePdf(baselineDocumentPath, comparison);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const marks = comparison.differences.filter((diff) =>
    baselineDocument === "documentA" ? diff.bboxA || diff.bboxB : diff.bboxB || diff.bboxA,
  );

  for (const diff of marks) {
    const preferredPageIndex = baselineDocument === "documentA" ? diff.pageIndexA : diff.pageIndexB;
    const fallbackPageIndex = baselineDocument === "documentA" ? comparison.tableA.pageIndex : comparison.tableB.pageIndex;
    const pageIndex = Math.max(0, Math.min(pages.length - 1, preferredPageIndex ?? fallbackPageIndex ?? 0));
    const page = pages[pageIndex];
    const bbox =
      baselineDocument === "documentA"
        ? diff.bboxA ?? diff.bboxB ?? comparison.tableA.bbox
        : diff.bboxB ?? diff.bboxA ?? comparison.tableB.bbox;
    const sourcePage =
      baselineDocument === "documentA"
        ? comparison.tableA.pageSize ?? comparison.tableB.pageSize
        : comparison.tableB.pageSize ?? comparison.tableA.pageSize;
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
    page.drawText(labelForDifference(diff), {
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

function labelForDifference(diff: TableDifference): string {
  const label = diff.explanation ?? diff.ref;
  return label.length > 72 ? `${label.slice(0, 69)}...` : label;
}

async function loadOrCreatePdf(documentPath: string, comparison: TableComparisonResult): Promise<PDFDocument> {
  const extension = path.extname(documentPath).toLowerCase();
  if (extension === ".pdf") {
    const bytes = await readFile(documentPath);
    return PDFDocument.load(bytes);
  }

  const pdf = await PDFDocument.create();
  const bytes = await readFile(documentPath);
  if (extension === ".png") {
    const image = await pdf.embedPng(bytes);
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    return pdf;
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    const image = await pdf.embedJpg(bytes);
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    return pdf;
  }

  pdf.addPage(comparison.tableB.pageSize ?? [612, 792]);
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
