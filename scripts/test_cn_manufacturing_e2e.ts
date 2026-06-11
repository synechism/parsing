import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument } from "pdf-lib";

const apiUrl = (process.env.TABLE_COMPARE_API_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const gotenbergUrl = (process.env.GOTENBERG_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const suiteDir = "data/table-compare/manufacturing-structure-tests";
const suiteConcurrency = Number(process.env.TABLE_MANUFACTURING_TEST_CONCURRENCY ?? 2);
const statusPollAttempts = Number(process.env.TABLE_MANUFACTURING_TEST_POLL_ATTEMPTS ?? 600);
const caseFilter = new Set(
  (process.env.TABLE_MANUFACTURING_TEST_CASES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

type DocumentFormat = "pdf" | "png" | "image-pdf";

interface LineItem {
  date: string;
  documentNo: string;
  orderNo: string;
  materialCode: string;
  spec: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amountOverride?: number;
}

interface Fixture {
  manufacturer: string;
  customer: string;
  period: string;
  contact: string;
  items: LineItem[];
  totalOverride?: number;
  blankRows?: number;
  style?: "standard" | "dense" | "wide";
  descriptionMode?: "standard" | "synonym";
}

interface CaseDef {
  name: string;
  expectedDifferent: boolean;
  documentA: Fixture;
  documentB: Fixture;
  documentAFormat?: DocumentFormat;
  documentBFormat?: DocumentFormat;
  expectedText?: string[];
}

interface TableCompareResult {
  jobId: string;
  different: boolean;
  comparisonMode?: string;
  explanation: string;
  differences: unknown[];
  selection?: unknown;
  agent?: {
    registryName?: string;
    toolCalls: string[];
  };
}

const baseItems = [
  line("Apr 01", "DN-26040101", "PO-260001", "PNL-499-089-6", "MDF side panel 499 x 89 x 6 mm CARB", 100, "pcs", 2.35),
  line("Apr 02", "DN-26040102", "PO-260001", "RCA-108-AU", "RCA jack yellow gold plated straight pin", 12, "ea", 2.35),
  line("Apr 03", "DN-26040103", "PO-260002", "PNL-154-404-9", "MDF brace 154 x 404 x 9 mm CARB", 90, "pcs", 1.23),
  line("Apr 04", "DN-26040104", "PO-260003", "MAG-D12-25", "Magnet disc D12 x 2.5 mm", 1100, "pcs", 0.82),
];

const extendedItems = [
  ...baseItems,
  line("Apr 05", "DN-26040105", "PO-260004", "BOX-3PLY-S", "Three-ply shipping carton small", 30, "ea", 5.2),
  line("Apr 06", "DN-26040106", "PO-260004", "LBL-WHT-40", "White barcode label 40 x 20 mm", 500, "roll", 0.14),
  line("Apr 07", "DN-26040107", "PO-260005", "SCR-M3-08", "M3 x 8 zinc machine screw", 1500, "ea", 0.03),
  line("Apr 08", "DN-26040108", "PO-260005", "WIRE-UL1015-R", "UL1015 red wire 18 AWG", 200, "m", 0.41),
];

const baseA = fixture("Acme Precision Components", "Shenzhen Bluepine Technology Co.", baseItems);
const baseB = fixture("Zhejiang Zhongzhen Magnetics Co.", "Shenzhen Bluepine Technology Co.", baseItems, { blankRows: 9 });

const cases: CaseDef[] = [
  same("01-different-layout-same-content"),
  same("02-row-reordered", { documentB: withItems([baseItems[2], baseItems[0], baseItems[3], baseItems[1]]) }),
  same("03-metadata-only-change", { documentB: { ...baseB, contact: "Mia Chen", period: "Apr 01 2026 - Apr 30 2026" } }),
  same("04-extra-blank-padding", { documentB: { ...baseB, blankRows: 14 } }),
  same("05-style-variation-same-content", { documentA: { ...baseA, style: "wide" }, documentB: { ...baseB, style: "dense" } }),
  changed("06-quantity-change", mutate(0, { quantity: 112 }), ["112", "PNL-499-089-6"]),
  changed("07-unit-price-change", mutate(1, { unitPrice: 2.75 }), ["2.75", "RCA-108-AU"]),
  changed("08-amount-change", mutate(2, { amountOverride: 118.88 }), ["118.88", "PNL-154-404-9"]),
  changed("09-material-code-change", mutate(3, { materialCode: "MAG-D12-99" }), ["MAG-D12-99"]),
  changed("10-spec-change", mutate(2, { spec: "MDF brace 154 x 404 x 12 mm CARB" }), ["154 x 404 x 12"]),
  changed("11-order-number-change", mutate(0, { orderNo: "PO-260099" }), ["PO-260099"]),
  changed("12-added-line", [...baseItems, line("Apr 05", "DN-26040105", "PO-260004", "BOX-3PLY-S", "Three-ply shipping carton small", 30, "ea", 5.2)], ["BOX-3PLY-S"]),
  changed("13-removed-line", baseItems.slice(0, 3), ["MAG-D12-25"]),
  changed("14-duplicate-line-quantity-change", duplicateAndMutate(0, { documentNo: "DN-26040106", quantity: 45 }), ["45", "PNL-499-089-6"]),
  changed("15-unit-change", mutate(1, { unit: "set" }), ["set", "RCA-108-AU"]),
  changed("16-total-only-change", baseItems, ["9999.99"], { documentB: { ...baseB, totalOverride: 9999.99 } }),
  same("17-short-blank-section", { documentB: { ...baseB, blankRows: 2 } }),
  changed("18-date-change", mutate(2, { date: "Apr 30" }), ["Apr 30", "PNL-154-404-9"]),
  changed("19-multiple-field-changes", [
    { ...baseItems[0], quantity: 101 },
    { ...baseItems[1], unitPrice: 2.99 },
    { ...baseItems[2], materialCode: "PNL-154-404-99" },
    baseItems[3],
  ], ["101", "2.99", "PNL-154-404-99"]),
  same("20-manufacturer-style-noise", {
    documentA: { ...baseA, manufacturer: "Acme Precision Components - Statement Export" },
    documentB: { ...baseB, manufacturer: "ZZ Magnetics ERP Export" },
  }),
  same("21-eight-line-table-same-content", {
    documentA: { ...baseA, items: extendedItems },
    documentB: { ...baseB, items: extendedItems, blankRows: 4 },
  }),
  changed(
    "22-eight-line-quantity-change",
    extendedItems.map((lineItem) => (lineItem.materialCode === "WIRE-UL1015-R" ? { ...lineItem, quantity: 260 } : lineItem)),
    ["260", "WIRE-UL1015-R"],
    { documentA: { ...baseA, items: extendedItems }, documentB: { ...baseB, blankRows: 4 } },
  ),
  same("23-description-synonym-same-content", {
    documentB: { ...baseB, descriptionMode: "synonym" },
  }),
  same("24-png-base-same-content", {
    documentAFormat: "png",
    documentBFormat: "pdf",
  }),
  changed("25-image-pdf-quantity-change", mutate(3, { quantity: 1050 }), ["1050", "MAG-D12-25"], {
    documentBFormat: "image-pdf",
  }),
];

const selectedCases = caseFilter.size > 0 ? cases.filter((testCase) => matchesCaseFilter(testCase.name)) : cases;
assert.ok(selectedCases.length > 0, `No manufacturing test cases matched ${[...caseFilter].join(", ")}`);

if (caseFilter.size > 0) {
  await mkdir(suiteDir, { recursive: true });
  await Promise.all(selectedCases.map((testCase) => rm(path.join(suiteDir, testCase.name), { recursive: true, force: true })));
} else {
  await rm(suiteDir, { recursive: true, force: true });
  await mkdir(suiteDir, { recursive: true });
}

const results = await mapWithConcurrency(selectedCases, suiteConcurrency, runCase);
console.log(JSON.stringify({ passed: true, concurrency: suiteConcurrency, cases: results }, null, 2));

async function runCase(testCase: CaseDef) {
  const caseDir = path.join(suiteDir, testCase.name);
  const inputDir = path.join(caseDir, "input");
  const outputDir = path.join(caseDir, "output");
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const documentAFormat = testCase.documentAFormat ?? "pdf";
  const documentBFormat = testCase.documentBFormat ?? "pdf";
  const baseDocument = path.join(inputDir, `base.${extensionForFormat(documentAFormat)}`);
  const changedDocument = path.join(inputDir, `changed.${extensionForFormat(documentBFormat)}`);
  await writeFile(baseDocument, await renderDocument(renderSupplierStatementHtml(testCase.documentA), documentAFormat));
  await writeFile(changedDocument, await renderDocument(renderEmbeddedTableHtml(testCase.documentB), documentBFormat));

  console.log(`[${testCase.name}] submitted inputs (${documentAFormat} vs ${documentBFormat})`);
  const result = await submitAndWait(baseDocument, changedDocument);
  assert.equal(result.different, testCase.expectedDifferent, `${testCase.name} different mismatch`);
  assert.equal(result.comparisonMode, "semantic", `${testCase.name} should use semantic mode`);
  assert.ok(result.selection, `${testCase.name} should include table section selection metadata`);
  assert.ok(result.agent?.toolCalls.includes("semantic-table-section-selection"), `${testCase.name} should select table sections`);
  for (const expected of testCase.expectedText ?? []) {
    assert.ok(JSON.stringify(result).toLowerCase().includes(expected.toLowerCase()), `${testCase.name} should mention ${expected}`);
  }

  await downloadRedline(result.jobId, path.join(outputDir, "redline.pdf"));
  await writeFile(
    path.join(outputDir, "result.json"),
    JSON.stringify(
      {
        caseName: testCase.name,
        expectedDifferent: testCase.expectedDifferent,
        inputFiles: { documentA: path.basename(baseDocument), documentB: path.basename(changedDocument) },
        passed: true,
        result,
      },
      null,
      2,
    ),
  );
  console.log(`[${testCase.name}] passed job=${result.jobId}`);
  return {
    name: testCase.name,
    jobId: result.jobId,
    different: result.different,
    differences: result.differences.length,
    outputDirectory: caseDir,
  };
}

function line(
  date: string,
  documentNo: string,
  orderNo: string,
  materialCode: string,
  spec: string,
  quantity: number,
  unit: string,
  unitPrice: number,
): LineItem {
  return { date, documentNo, orderNo, materialCode, spec, quantity, unit, unitPrice };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

function fixture(manufacturer: string, customer: string, items: LineItem[], overrides: Partial<Fixture> = {}): Fixture {
  return { manufacturer, customer, period: "April 2026", contact: "Nora Wang", items, blankRows: 7, style: "standard", ...overrides };
}

function same(name: string, overrides: Partial<CaseDef> = {}): CaseDef {
  return { name, expectedDifferent: false, documentA: baseA, documentB: baseB, ...overrides };
}

function changed(name: string, changedItems: LineItem[], expectedText: string[], overrides: Partial<CaseDef> = {}): CaseDef {
  const documentB = { ...baseB, ...(overrides.documentB ?? {}), items: changedItems };
  return {
    name,
    expectedDifferent: true,
    documentA: overrides.documentA ?? baseA,
    documentB,
    documentAFormat: overrides.documentAFormat,
    documentBFormat: overrides.documentBFormat,
    expectedText,
  };
}

function matchesCaseFilter(name: string): boolean {
  const shortName = name.replace(/^\d+-/, "");
  return caseFilter.has(name) || caseFilter.has(shortName);
}

function withItems(items: LineItem[]): Fixture {
  return { ...baseB, items };
}

function mutate(index: number, patch: Partial<LineItem>): LineItem[] {
  return baseItems.map((lineItem, lineIndex) => (lineIndex === index ? { ...lineItem, ...patch } : lineItem));
}

function duplicateAndMutate(index: number, patch: Partial<LineItem>): LineItem[] {
  return [...baseItems.slice(0, index + 1), { ...baseItems[index], ...patch }, ...baseItems.slice(index + 1)];
}

function amount(lineItem: LineItem): number {
  return lineItem.amountOverride ?? Math.round(lineItem.quantity * lineItem.unitPrice * 100) / 100;
}

function total(fixture: Fixture): number {
  return fixture.totalOverride ?? Math.round(fixture.items.reduce((sum, lineItem) => sum + amount(lineItem), 0) * 100) / 100;
}

function renderSupplierStatementHtml(fixture: Fixture): string {
  const rows = fixture.items
    .map(
      (lineItem) =>
        `<tr><td>${e(lineItem.date)}</td><td>${e(descriptionText(fixture, lineItem))}</td><td>${e(lineItem.documentNo)}</td><td>${e(lineItem.orderNo)}</td><td>${e(lineItem.materialCode)}</td><td class="num">${lineItem.quantity.toFixed(2)}</td><td>${e(lineItem.unit)}</td><td class="num">${lineItem.unitPrice.toFixed(3)}</td><td class="num">${amount(lineItem).toFixed(2)}</td><td>line note</td></tr>`,
    )
    .join("");
  return htmlPage(
    fixture,
    `<h1>${e(fixture.manufacturer)} Payables Statement - ${e(fixture.period)}</h1>
    <table class="meta"><tr><th>Supplier</th><td>${e(fixture.manufacturer)}</td><th>Period</th><td>${e(fixture.period)}</td></tr><tr><th>Buyer</th><td>${e(fixture.customer)}</td><th>Currency</th><td>USD</td></tr></table>
    <table class="main ${fixture.style}"><thead><tr><th>Delivery Date</th><th>Specification</th><th>Delivery Note</th><th>PO No</th><th>Part Code</th><th>Quantity</th><th>Unit</th><th>Unit Price</th><th>Amount</th><th>Remarks</th></tr></thead><tbody>${rows}${supplierTotalRow(fixture)}</tbody></table>
    <table class="signature"><tr><th>Prepared By</th><td>Bluepine AP Team</td><th>Supplier Confirmation</th><td></td></tr><tr><th>Date</th><td>2026-04-26</td><th>Signed Date</th><td>____-__-__</td></tr></table>`,
  );
}

function renderEmbeddedTableHtml(fixture: Fixture): string {
  const rows = fixture.items
    .map(
      (lineItem) =>
        `<tr><td>${e(lineItem.date)}</td><td>${e(lineItem.documentNo)}</td><td>${e(lineItem.orderNo)}</td><td>${e(lineItem.materialCode)}</td><td>${e(descriptionText(fixture, lineItem))}</td><td>${e(lineItem.unit)}</td><td class="num">${lineItem.quantity}</td><td class="num">${lineItem.unitPrice.toFixed(3)}</td><td class="num">${amount(lineItem).toFixed(2)}</td><td></td></tr>`,
    )
    .join("");
  const blanks = Array.from({ length: fixture.blankRows ?? 7 }, () => `<tr>${"<td>&nbsp;</td>".repeat(10)}</tr>`).join("");
  return htmlPage(
    fixture,
    `<h1>${e(fixture.manufacturer)}<br/>Supplier Reconciliation Sheet</h1>
    <table class="main embedded ${fixture.style}"><tbody>
    <tr><th>Supplier</th><td colspan="3">${e(fixture.manufacturer)}</td><th>Buyer</th><td colspan="5">${e(fixture.customer)}</td></tr>
    <tr><th>Sender</th><td colspan="3">${e(fixture.contact)}</td><th>Receiver</th><td colspan="5">Mia Chen</td></tr>
    <tr><th>Phone/Fax</th><td colspan="3">0579-89322656</td><th>Phone/Fax</th><td colspan="5"></td></tr>
    <tr><th>Statement Date</th><td colspan="3">${e(fixture.period)}</td><th>Payment Terms</th><td colspan="5">Net 60, tax included</td></tr>
    <tr><th>Date</th><th>Document No</th><th>Order No</th><th>Material Code</th><th>Specification</th><th>Unit</th><th>Shipped Qty</th><th>Unit Price</th><th>Amount</th><th></th></tr>
    ${rows}${blanks}${embeddedTotalRow(fixture)}</tbody></table>`,
  );
}

function supplierTotalRow(fixture: Fixture): string {
  const quantity = fixture.items.reduce((sum, lineItem) => sum + lineItem.quantity, 0);
  return `<tr class="total"><td colspan="5">TOTAL</td><td class="num">${quantity.toFixed(2)}</td><td></td><td></td><td class="num">${total(fixture).toFixed(2)}</td><td></td></tr>`;
}

function embeddedTotalRow(fixture: Fixture): string {
  const quantity = fixture.items.reduce((sum, lineItem) => sum + lineItem.quantity, 0);
  return `<tr class="total"><td>TOTAL:</td><td></td><td></td><td></td><td></td><td></td><td class="num">${quantity}</td><td></td><td class="num">${total(fixture).toFixed(2)}</td><td></td></tr>`;
}

function descriptionText(fixture: Fixture, lineItem: LineItem): string {
  if (fixture.descriptionMode !== "synonym") {
    return lineItem.spec;
  }

  const synonyms: Record<string, string> = {
    "PNL-499-089-6": "CARB MDF side board, 499 by 89 by 6 mm",
    "RCA-108-AU": "Gold-plated yellow RCA connector, straight pin",
    "PNL-154-404-9": "CARB MDF support panel, 154 by 404 by 9 mm",
    "MAG-D12-25": "Round magnet, 12 mm diameter by 2.5 mm thick",
  };
  return synonyms[lineItem.materialCode] ?? lineItem.spec;
}

function htmlPage(fixture: Fixture, body: string): string {
  const dense = fixture.style === "dense";
  const wide = fixture.style === "wide";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: A4; margin: ${wide ? "8mm" : "12mm"}; }
      body { font-family: "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", Arial, sans-serif; color: #111; }
      h1 { text-align: center; font-size: ${dense ? "16px" : "18px"}; margin: 0 0 8px; line-height: 1.25; }
      table { border-collapse: collapse; width: 100%; table-layout: fixed; margin-bottom: 10px; }
      th, td { border: 1px solid #111; padding: ${dense ? "3px 4px" : "5px 6px"}; font-size: ${dense ? "8.5px" : "9.5px"}; line-height: 1.25; vertical-align: middle; word-break: break-word; }
      th { font-weight: 700; background: #f3f4f6; }
      .meta th, .signature th { width: 12%; }
      .meta td, .signature td { width: 38%; }
      .main th:nth-child(1), .main td:nth-child(1) { width: 9%; }
      .main th:nth-child(2), .main td:nth-child(2) { width: 20%; }
      .main th:nth-child(3), .main td:nth-child(3) { width: 11%; }
      .main th:nth-child(4), .main td:nth-child(4) { width: 11%; }
      .main th:nth-child(5), .main td:nth-child(5) { width: 13%; }
      .main th:nth-child(6), .main td:nth-child(6) { width: 7%; }
      .main th:nth-child(7), .main td:nth-child(7) { width: 6%; }
      .main th:nth-child(8), .main td:nth-child(8) { width: 7%; }
      .main th:nth-child(9), .main td:nth-child(9) { width: 8%; }
      .main th:nth-child(10), .main td:nth-child(10) { width: 8%; }
      .embedded th, .embedded td { font-size: ${dense ? "8px" : "9px"}; }
      .num { text-align: right; }
      .total td { font-weight: 700; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function extensionForFormat(format: DocumentFormat): "pdf" | "png" {
  return format === "png" ? "png" : "pdf";
}

async function renderDocument(html: string, format: DocumentFormat): Promise<Buffer> {
  if (format === "png") {
    return renderPng(html);
  }
  if (format === "image-pdf") {
    return renderImagePdf(html);
  }
  return renderPdf(html);
}

async function renderPdf(html: string): Promise<Buffer> {
  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");
  const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`Gotenberg render failed: ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function renderPng(html: string): Promise<Buffer> {
  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");
  const response = await fetch(`${gotenbergUrl}/forms/chromium/screenshot/html`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`Gotenberg screenshot failed: ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function renderImagePdf(html: string): Promise<Buffer> {
  const imageBytes = await renderPng(html);
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(imageBytes);
  const page = pdf.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return Buffer.from(await pdf.save());
}

async function submitAndWait(documentA: string, documentB: string): Promise<TableCompareResult> {
  const form = new FormData();
  form.append("documentA", new Blob([await readFile(documentA)], { type: mimeTypeForPath(documentA) }), path.basename(documentA));
  form.append("documentB", new Blob([await readFile(documentB)], { type: mimeTypeForPath(documentB) }), path.basename(documentB));
  form.append("baselineDocument", "documentB");
  const submit = await fetch(`${apiUrl}/v1/table-comparisons`, { method: "POST", body: form });
  await assertHttpStatus(submit, 202, "submit");
  const submitted = (await submit.json()) as { jobId: string };

  for (let attempt = 0; attempt < statusPollAttempts; attempt += 1) {
    const status = await fetch(`${apiUrl}/v1/table-comparisons/${submitted.jobId}`);
    await assertHttpStatus(status, 200, "status");
    const statusBody = (await status.json()) as { status: string; error?: string };
    if (statusBody.status === "completed") {
      const result = await fetch(`${apiUrl}/v1/table-comparisons/${submitted.jobId}/result`);
      await assertHttpStatus(result, 200, "result");
      return { ...((await result.json()) as TableCompareResult), jobId: submitted.jobId };
    }
    if (statusBody.status === "failed") {
      throw new Error(`job ${submitted.jobId} failed: ${statusBody.error ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`timed out waiting for job ${submitted.jobId}`);
}

async function downloadRedline(jobId: string, outputPath: string): Promise<void> {
  const response = await fetch(`${apiUrl}/v1/table-comparisons/${jobId}/redline.pdf`);
  await assertHttpStatus(response, 200, "redline");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
  await writeFile(outputPath, bytes);
  assert.ok((await stat(outputPath)).size > 1000);
}

function mimeTypeForPath(filePath: string): string {
  return path.extname(filePath).toLowerCase() === ".png" ? "image/png" : "application/pdf";
}

async function assertHttpStatus(response: Response, expected: number, label: string): Promise<void> {
  if (response.status !== expected) {
    throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }
}

function e(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
